'use strict';

// CA / 主机证书管理
// - 首次启动时生成自签根证书（CA），写入 certs/ca.pem 与 certs/ca.key
// - 之后对每个目标主机即时签发叶子证书并缓存到内存
//
// 备注：Claude Code 的 utils/caCerts.ts 通过 NODE_EXTRA_CA_CERTS 把额外 PEM
// 追加到 Mozilla 根证书集合上，因此把 certs/ca.pem 指向该变量即可让它信任。

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const pki = forge.pki;

const CERTS_DIR = path.resolve(__dirname, '..', 'certs');
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca.key');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function generateKeyPair() {
  // 2048 位足够调试用，且生成快
  return pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
}

function makeSerial() {
  // 序列号必须正数，使用 16 字节随机
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
  // 确保首位为 0 避免被解析为负数
  return '00' + hex;
}

function buildCA() {
  const keys = generateKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = makeSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * ONE_YEAR_MS);

  const attrs = [
    { name: 'commonName', value: 'CC-Zhuabao Local Root CA' },
    { name: 'organizationName', value: 'CC-Zhuabao' },
    { name: 'organizationalUnitName', value: 'Debug Proxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    {
      name: 'keyUsage',
      critical: true,
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function loadOrCreateCA() {
  ensureDir(CERTS_DIR);
  if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
    const certPem = fs.readFileSync(CA_CERT_PATH, 'utf8');
    const keyPem = fs.readFileSync(CA_KEY_PATH, 'utf8');
    return {
      cert: pki.certificateFromPem(certPem),
      key: pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
      created: false,
    };
  }
  const { cert, key } = buildCA();
  const certPem = pki.certificateToPem(cert);
  const keyPem = pki.privateKeyToPem(key);
  fs.writeFileSync(CA_CERT_PATH, certPem);
  fs.writeFileSync(CA_KEY_PATH, keyPem);
  return { cert, key, certPem, keyPem, created: true };
}

// 用于子证书的密钥对在所有主机间复用（仅调试用途，避免反复昂贵的 RSA 生成）
let sharedLeafKeys = null;
function getSharedLeafKeys() {
  if (!sharedLeafKeys) sharedLeafKeys = generateKeyPair();
  return sharedLeafKeys;
}

const hostCertCache = new Map(); // host -> { key, cert } PEM

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function issueHostCertificate(host, ca) {
  if (hostCertCache.has(host)) return hostCertCache.get(host);
  const leafKeys = getSharedLeafKeys();
  const cert = pki.createCertificate();
  cert.publicKey = leafKeys.publicKey;
  cert.serialNumber = makeSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + ONE_YEAR_MS);

  cert.setSubject([
    { name: 'commonName', value: host },
    { name: 'organizationName', value: 'CC-Zhuabao' },
  ]);
  cert.setIssuer(ca.cert.subject.attributes);

  const altNames = isIp(host)
    ? [{ type: 7, ip: host }]
    : [{ type: 2, value: host }];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      critical: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  const out = {
    key: pki.privateKeyToPem(leafKeys.privateKey),
    cert: pki.certificateToPem(cert),
  };
  hostCertCache.set(host, out);
  return out;
}

module.exports = {
  loadOrCreateCA,
  issueHostCertificate,
  CA_CERT_PATH,
  CA_KEY_PATH,
  CERTS_DIR,
};
