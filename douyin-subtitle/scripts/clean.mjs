// clean.mjs —— AI 回答 → 纯字幕正文（API 版与面板版共用）

export function cleanAnswer(text, log = () => {}) {
  let answer = String(text || '').replace(/<\/?mark>/g, '').trim();
  // 尾部：来源列表、免责声明
  const srcIdx = answer.lastIndexOf('\n来源：');
  if (srcIdx > 0) answer = answer.slice(0, srcIdx);
  const dIdx = answer.lastIndexOf('以上结果由问问AI');
  if (dIdx > 0) answer = answer.slice(0, dIdx);
  answer = answer.trim();
  // 首行杂质（只看首行，避免误删正文）：
  //  ① 开场白「根据您提供的上下文……原文如下：」—— 必须以冒号结尾
  //  ② 服务端注入的上下文头「我刚刚刷到一个视频，视频作者：X，视频标题是：Y」—— AI 会把它当原文第一句照抄
  for (let k = 0; k < 2; k++) {
    const nl = answer.indexOf('\n');
    const line = (nl > 0 ? answer.slice(0, nl) : '').trim();
    if (!line || !(/^(根据|以下是|好的|当前视频)[^\n]{0,100}[：:]$/.test(line) || /^我刚刚刷到一个视频，视频作者/.test(line))) break;
    log('已去掉首行杂质: ' + line.slice(0, 40) + '…');
    answer = answer.slice(nl + 1).trim();
  }
  return answer;
}

// 服务端注入的文本里带着作品标题和简介，AI 常把它们当原文开头照抄（字数虚高、完整度误报「偏高」）。
// 只从开头删：逐行看，整行（去空白）能在简介里原样找到就删，遇到第一行找不到的就停，不碰正文。
export function stripLeadingDescription(text, desc, log = () => {}) {
  const norm = (s) => String(s || '').replace(/\s/g, '');
  const d = norm(desc);
  if (!d) return text;
  const lines = String(text).split('\n');
  let k = 0;
  while (k < lines.length) {
    const l = norm(lines[k]);
    if (l && !(l.length >= 4 && d.includes(l))) break;
    k++;
  }
  if (k === 0) return text;
  log(`已去掉开头照抄的标题/简介 ${k} 行`);
  return lines.slice(k).join('\n').trim();
}
