// 演示适配器：不联网、不花钱，用来试界面和流程。
// 图片生成一张带提示词的示意图；视频在装了 ffmpeg 时生成一段测试画面，没装就给一张示意图。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Adapter, AdapterContext, PollResult, PreparedRequest, RemoteOutput } from './types.js';

const pending = new Map<string, { readyAt: number; ctx: AdapterContext; req: PreparedRequest }>();

function hashHue(s: string) {
  const h = crypto.createHash('md5').update(s).digest();
  return [h[0] % 360, h[1] % 360];
}

function esc(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function dims(ratio: string): [number, number] {
  const map: Record<string, [number, number]> = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [1024, 1024],
    '4:3': [1152, 864],
    '3:4': [864, 1152],
    '21:9': [1344, 576],
  };
  return map[ratio] || [1280, 720];
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of text.replace(/\s+/g, ' ')) {
    line += ch;
    if (line.length >= width) {
      out.push(line);
      line = '';
    }
    if (out.length >= 6) break;
  }
  if (line && out.length < 6) out.push(line);
  return out;
}

async function makeSvg(prompt: string, ratio: string, tag: string, seed: string): Promise<string> {
  const [w, h] = dims(ratio);
  const [a, b] = hashHue(prompt + seed);
  const lines = wrap(prompt || '（没有提示词）', Math.max(12, Math.floor(w / 46)));
  const tspans = lines
    .map((l, i) => `<tspan x="${w / 2}" dy="${i === 0 ? 0 : 44}">${esc(l)}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a},45%,28%)"/><stop offset="1" stop-color="hsl(${b},55%,14%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="32" y="56" font-family="sans-serif" font-size="26" fill="rgba(255,255,255,.55)">${esc(tag)}</text>
<text x="${w / 2}" y="${h / 2 - lines.length * 20}" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="34" fill="#fff">${tspans}</text>
</svg>`;
  const file = path.join(os.tmpdir(), `mock-${crypto.randomUUID()}.svg`);
  await fs.writeFile(file, svg, 'utf-8');
  return file;
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffmpeg', args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function makeVideo(req: PreparedRequest): Promise<RemoteOutput> {
  const ratio = String(req.params.ratio || '16:9');
  const [w, h] = dims(ratio);
  // 尺寸缩到一半并保证是偶数，让演示视频生成得快
  const vw = Math.round(w / 4) * 2;
  const vh = Math.round(h / 4) * 2;
  const dur = Math.min(10, Number(req.params.duration) || 5);
  const file = path.join(os.tmpdir(), `mock-${crypto.randomUUID()}.mp4`);
  const audio = req.params.generate_audio !== false;
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${vw}x${vh}:rate=24:duration=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=330:duration=${dur}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  if (await runFfmpeg(args)) return { kind: 'video', localFile: file, mime: 'video/mp4' };
  const svg = await makeSvg(req.prompt, ratio, '演示视频（电脑上没装 ffmpeg，只给示意图）', crypto.randomUUID());
  return { kind: 'video', localFile: svg, mime: 'image/svg+xml' };
}

async function makeWav(seconds = 1.5): Promise<string> {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 800, (n - i) / 800);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000 * env), 44 + i * 2);
  }
  const file = path.join(os.tmpdir(), `mock-${crypto.randomUUID()}.wav`);
  await fs.writeFile(file, buf);
  return file;
}

export const mockAdapter: Adapter = {
  type: 'mock',
  label: '演示模型（不联网、不花钱）',
  defaultBaseUrl: '',

  async test() {
    return '演示模型不需要 key，随时可用';
  },

  async submit(ctx, req) {
    if (req.capability === 'text') {
      const isTranslate = /^请把下面的内容翻译成英文/.test(req.prompt);
      const body = req.prompt.split('\n').slice(isTranslate ? 1 : 0).join('\n');
      const text = isTranslate
        ? `[EN 演示翻译] ${body}`
        : `【演示文本模型】\n${body}\n\n（接入真正的文本模型后，这里会是改写或扩写后的内容。）`;
      return { kind: 'done', outputs: [{ kind: 'text', text }], cost: 0 };
    }
    const id = `mock-${crypto.randomUUID()}`;
    const wait = req.capability === 'video' ? 6000 : 2500;
    pending.set(id, { readyAt: Date.now() + wait, ctx, req });
    return { kind: 'pending', remoteId: id };
  },

  async poll(_ctx, remoteId): Promise<PollResult> {
    const p = pending.get(remoteId);
    if (!p) return { status: 'failed', error: '演示任务已丢失（服务重启过）' };
    if (Date.now() < p.readyAt) return { status: 'running', note: '演示模型生成中…' };
    pending.delete(remoteId);
    const { req } = p;
    if (/失败|fail/i.test(req.prompt)) return { status: 'failed', error: '演示失败：提示词里有「失败」两个字，用来测试失败的样子' };
    if (req.capability === 'image') {
      const count = Math.max(1, Math.min(4, Number(req.params.count) || 1));
      const outputs: RemoteOutput[] = [];
      for (let i = 0; i < count; i++) {
        const refsNote = req.refs.length ? ` · 参考 ${req.refs.length} 张` : '';
        outputs.push({ kind: 'image', localFile: await makeSvg(req.prompt, String(req.params.ratio || '16:9'), `演示生图${refsNote}`, String(i)), mime: 'image/svg+xml' });
      }
      return { status: 'succeeded', outputs, cost: 0 };
    }
    if (req.capability === 'video') return { status: 'succeeded', outputs: [await makeVideo(req)], cost: 0 };
    return { status: 'succeeded', outputs: [{ kind: 'audio', localFile: await makeWav(), mime: 'audio/wav' }], cost: 0 };
  },

  refLabel(kind, n) {
    return `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}${n}`;
  },
};
