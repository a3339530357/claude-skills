'use strict';

// MITM 代理核心
// - HTTP 服务监听明文请求与 CONNECT 隧道
// - 对 CONNECT 请求：用本地 CA 现场签发主机证书，做 TLS 终止
// - 解密后的请求重新走 Node https.request 转发到真实上游
// - 同步把请求/响应（含流式块）写入 logger
//
// 解析参考：
// - Claude Code 实际使用 fetch(undici) + Anthropic SDK，依赖 EnvHttpProxyAgent
//   读取 HTTPS_PROXY → 它会以 CONNECT 隧道方式与本代理通信，因此本实现可以
//   完整看到请求/响应明文。

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const { Buffer } = require('buffer');
const zlib = require('zlib');

const { loadOrCreateCA, issueHostCertificate } = require('./ca');
const log = require('./logger');

const ca = loadOrCreateCA();

// 简单判断是否为「文本类」响应，决定是否解码 body
function isTextual(contentType) {
  if (!contentType) return true; // 默认认为是文本，便于查看
  const ct = String(contentType).toLowerCase();
  return /(^text\/|json|xml|javascript|x-www-form-urlencoded|event-stream)/.test(ct);
}

// HTTP 头大小写不敏感，按值取出来
function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

function decompressIfNeeded(headers, buffer) {
  const enc = String(headerValue(headers, 'content-encoding') || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buffer);
    }
  } catch {
    // 解压失败就原样返回
  }
  return buffer;
}

// 把单次 HTTP 请求-响应记录为完整的一条
function handleProxiedRequest(clientReq, clientRes, opts) {
  const id = log.nextId();
  const startedAt = Date.now();

  const isTls = !!opts.isTls;
  const targetHost = opts.host;
  const targetPort = opts.port;
  const fullUrl = `${isTls ? 'https' : 'http'}://${targetHost}${targetPort === (isTls ? 443 : 80) ? '' : ':' + targetPort}${clientReq.url}`;

  const reqHeaders = log.rawHeadersToObject(clientReq.rawHeaders);
  log.printRequestHeader(id, clientReq.method, fullUrl, reqHeaders);

  // 收集请求体
  const reqChunks = [];
  clientReq.on('data', (c) => reqChunks.push(c));
  clientReq.on('end', () => {
    const reqBodyBuf = Buffer.concat(reqChunks);
    const reqCt = headerValue(reqHeaders, 'content-type') || '';
    const reqBodyText = isTextual(reqCt)
      ? decompressIfNeeded(reqHeaders, reqBodyBuf).toString('utf8')
      : `<binary ${reqBodyBuf.length} bytes>`;
    log.printRequestBody(reqBodyText);

    // 发起上游请求
    const upstreamLib = isTls ? https : http;
    const upstreamOpts = {
      host: targetHost,
      port: targetPort,
      method: clientReq.method,
      path: clientReq.url,
      headers: { ...reqHeaders },
      // 转发到真实上游时使用系统/Node 内建 CA，不传 ca
      rejectUnauthorized: false,
      // SNI 必须对外用真实主机名
      servername: targetHost,
    };
    // 防止上游收到错误的 Host
    upstreamOpts.headers['host'] = targetHost + (targetPort === (isTls ? 443 : 80) ? '' : ':' + targetPort);

    const upstreamReq = upstreamLib.request(upstreamOpts, (upstreamRes) => {
      const resHeaders = log.rawHeadersToObject(upstreamRes.rawHeaders);
      log.printResponseHeader(id, upstreamRes.statusCode, resHeaders);

      // 透传响应状态与头部到客户端
      try {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.rawHeaders);
      } catch (e) {
        // rawHeaders 形式部分版本不接受，回退
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, resHeaders);
      }

      const resCt = String(headerValue(resHeaders, 'content-type') || '').toLowerCase();
      const resTe = String(headerValue(resHeaders, 'transfer-encoding') || '').toLowerCase();
      const resEnc = String(headerValue(resHeaders, 'content-encoding') || '').toLowerCase();
      const isStream = resCt.includes('text/event-stream') || resTe.includes('chunked');
      const resChunks = [];
      let streamedText = '';

      upstreamRes.on('data', (chunk) => {
        resChunks.push(chunk);
        // 流式：实时打印（按 chunk）。仅当响应未压缩时直接 utf8 显示；
        // 若是 gzip/br 等流式压缩，统一在 end 里解压后落盘。
        if (isStream && isTextual(resCt) && !resEnc) {
          const t = chunk.toString('utf8');
          streamedText += t;
          log.printResponseChunk(id, t);
        }
        // 透传给客户端
        clientRes.write(chunk);
      });

      upstreamRes.on('end', () => {
        clientRes.end();

        const fullBuf = Buffer.concat(resChunks);
        let bodyText;
        if (isTextual(resCt)) {
          bodyText = decompressIfNeeded(resHeaders, fullBuf).toString('utf8');
        } else {
          bodyText = `<binary ${fullBuf.length} bytes>`;
        }
        // 非流式才在尾部打印一份「最终响应体预览」
        if (!isStream) log.printResponseBodyFinal(bodyText);

        log.appendJsonl({
          id,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          url: fullUrl,
          method: clientReq.method,
          request: {
            headers: reqHeaders,
            body: reqBodyText,
          },
          response: {
            status: upstreamRes.statusCode,
            statusMessage: upstreamRes.statusMessage,
            headers: resHeaders,
            stream: isStream,
            body: isStream ? streamedText || bodyText : bodyText,
          },
        });
      });

      upstreamRes.on('error', (err) => {
        log.appendJsonl({ id, error: 'upstream_response_error', message: String(err) });
        try { clientRes.end(); } catch {}
      });
    });

    upstreamReq.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[#${id}] upstream error:`, err.message);
      log.appendJsonl({
        id,
        startedAt: new Date(startedAt).toISOString(),
        url: fullUrl,
        method: clientReq.method,
        request: { headers: reqHeaders, body: reqBodyText },
        error: 'upstream_request_error',
        message: String(err),
      });
      try {
        clientRes.writeHead(502);
        clientRes.end(`cc-zhuabao upstream error: ${err.message}`);
      } catch {}
    });

    if (reqBodyBuf.length) upstreamReq.write(reqBodyBuf);
    upstreamReq.end();
  });

  clientReq.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[#${id}] client error:`, err.message);
  });
}

// 内部 HTTPS server：每个 host 绑定动态签发的证书
// 我们用一个共享 HTTPS 服务器，通过 SNICallback 动态返回证书
const internalTlsServer = https.createServer({
  SNICallback: (servername, cb) => {
    try {
      const pair = issueHostCertificate(servername, ca);
      cb(null, tls.createSecureContext({ key: pair.key, cert: pair.cert }));
    } catch (e) {
      cb(e);
    }
  },
  // 占位证书（首次连接尚未走 SNI 时使用）
  cert: ca.certPem,
  key: ca.keyPem,
});

// 当 TLS 包装完成后，把原始 socket 上的 _zb 复制到 TLSSocket 上，
// 这样 request handler 里读 req.socket._zb 才能拿到目标主机信息。
internalTlsServer.on('secureConnection', (tlsSocket) => {
  const parent = tlsSocket._parent || tlsSocket._handle?.owner;
  if (parent && parent._zb) tlsSocket._zb = parent._zb;
});

internalTlsServer.on('request', (req, res) => {
  const meta = req.socket._zb || req.socket._parent?._zb || {};
  handleProxiedRequest(req, res, {
    isTls: true,
    host: meta.host,
    port: meta.port,
  });
});

internalTlsServer.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

// 把已 accept 的 socket "喂"给内部 TLS 服务器
function feedSocketToTlsServer(socket, host, port, headBuffer) {
  socket._zb = { host, port };
  // 让 TLS 服务器接管这个 socket
  internalTlsServer.emit('connection', socket);
  if (headBuffer && headBuffer.length) socket.unshift(headBuffer);
}

function createProxyServer({ port = 8888, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    // 明文 HTTP 请求（请求行带绝对 URL）
    let parsed;
    try {
      parsed = new url.URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('cc-zhuabao: bad request URL');
      return;
    }
    // 调整 req.url 为路径
    const newReq = req;
    const pathOnly = parsed.pathname + (parsed.search || '');
    Object.defineProperty(newReq, 'url', { value: pathOnly, configurable: true });
    handleProxiedRequest(newReq, res, {
      isTls: parsed.protocol === 'https:',
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    });
  });

  // CONNECT 隧道（HTTPS）
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = Number(portStr) || 443;
    // eslint-disable-next-line no-console
    console.log(`\x1b[2m[CONNECT]\x1b[0m ${host}:${port}`);

    // 回应 200，进入 TLS 终止
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n', 'utf8', () => {
      feedSocketToTlsServer(clientSocket, host, port, head);
    });

    clientSocket.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[CONNECT] socket error:', err.message);
    });
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createProxyServer, ca };
