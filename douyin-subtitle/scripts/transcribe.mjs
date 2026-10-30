#!/usr/bin/env node
// SenseVoice-Small（sherpa-onnx CUDA fp32 + Silero VAD）本地转写
// 模型和 venv 放在 sensevoice/（skill 目录下），不依赖项目 cwd。
//
// 用法: node transcribe.mjs <音频或视频路径> [--out x.txt] [--threads 4] [--cpu]
//   音频非 16k 单声道 wav 时自动用 ffmpeg 转换。
//   默认 provider=cuda、model=fp32。--cpu 用 CPU（需 .venv，模型换 int8，见 SKILL.md）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = path.join(root, 'sensevoice');

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('用法: node transcribe.mjs <音频/视频> [--out x.txt] [--threads 4] [--cpu]');
  process.exit(2);
}
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const out = opt('out', path.join(path.dirname(path.resolve(input)), `${path.parse(input).name}.txt`));
const threads = opt('threads', '4');
const provider = args.includes('--cpu') ? 'cpu' : 'cuda';
const model = provider === 'cpu' ? 'int8' : 'fp32';

if (!fs.existsSync(input)) throw new Error(`找不到输入文件: ${input}`);
const py = path.join(here, provider === 'cpu' ? '.venv' : '.venv-gpu', 'Scripts', 'python.exe');
const script = path.join(here, 'transcribe.py');
if (!fs.existsSync(py)) {
  throw new Error(`缺少 ${py}。按 SKILL.md「本地转写」一节重建环境，或改用 --cpu 并装 .venv`);
}
if (!fs.existsSync(path.join(here, 'models', 'silero_vad.onnx'))) {
  throw new Error(`缺少 VAD 模型 ${path.join(here, 'models', 'silero_vad.onnx')}`);
}

// 非 16k 单声道 wav 先转码（ffprobe 缺失时直接转，代价只是多一次解码）
const wav = path.join(path.dirname(out), `.${path.parse(input).name}.16k.wav`);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
  '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', input], { encoding: 'utf8' });
const ok = probe.status === 0 && probe.stdout.trim() === '16000,1';
if (!ok) {
  const conv = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { encoding: 'utf8' });
  if (conv.status !== 0) throw new Error(`ffmpeg 转码失败: ${(conv.stderr || '').trim().split('\n').pop()}`);
}

const t0 = Date.now();
const r = spawnSync(py, ['-I', script, ok ? input : wav, out, '--provider', provider,
  '--model', model, '--threads', threads], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
if (r.status !== 0) throw new Error(`转写失败: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
if (!ok && wav !== input) fs.rmSync(wav, { force: true });

const stat = fs.statSync(out);
console.log(r.stdout.trim());
console.log(`→ ${out}  ${(stat.size / 1024).toFixed(0)} KB  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
