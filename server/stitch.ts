// 成片拼接：把几段视频按顺序拼成一个 mp4（用本机 ffmpeg）。
// 尺寸统一成第一段的分辨率（比例不同加黑边，不拉伸）；帧率统一 30；
// 没声音的片段补静音、声音长短按画面对齐，拼出来声画不会错位。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { absFromRel, ensureDir, nowIso, paths, rel, writeJson } from './storage.js';

interface Probe {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(cmd, args);
    } catch (e) {
      return reject(e);
    }
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function probe(file: string): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]);
  if (r.code !== 0) throw new Error(`读不了这个视频：${path.basename(file)}`);
  const j = JSON.parse(r.out || '{}');
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error(`这个文件里没有画面：${path.basename(file)}`);
  return {
    duration: Number(j.format?.duration) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    hasAudio: (j.streams || []).some((s: any) => s.codec_type === 'audio'),
  };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function nextVersionNo(dir: string): Promise<number> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  return Math.max(0, ...names.map((n) => Number(n.match(/^v(\d+)\./)?.[1] || 0))) + 1;
}

/** 拼接：files 是工作文件夹里的相对路径（按顺序）；结果存成这个节点的新版本，返回相对路径 */
export async function stitch(pid: string, eid: string, nodeId: string, files: string[]): Promise<{ file: string; duration: number }> {
  if (files.length < 1) throw new Error('至少要有一段视频');
  const abs = files.map((f) => absFromRel(f));
  for (const a of abs) if (!fs.existsSync(a)) throw new Error(`找不到视频文件：${path.basename(a)}（可能被自动清理了）`);
  try {
    await run('ffmpeg', ['-version']);
  } catch {
    throw new Error('电脑上没有 ffmpeg，拼接不了：在终端运行 brew install ffmpeg 装一下');
  }
  const probes = await Promise.all(abs.map(probe));
  const W = even(probes[0].width);
  const H = even(probes[0].height);

  // 输入：每段视频；没声音的再配一段同样长的静音
  const args: string[] = ['-y', '-hide_banner'];
  for (const a of abs) args.push('-i', a);
  let nextInput = abs.length;
  const silentIdx = probes.map((p) => {
    if (p.hasAudio) return -1;
    args.push('-f', 'lavfi', '-t', String(p.duration || 1), '-i', 'anullsrc=r=44100:cl=stereo');
    return nextInput++;
  });
  const parts: string[] = [];
  let concatIn = '';
  probes.forEach((p, i) => {
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p[v${i}]`);
    const src = p.hasAudio ? `[${i}:a]` : `[${silentIdx[i]}:a]`;
    // 声音按画面长度对齐：短了补静音、长了截掉
    parts.push(`${src}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${(p.duration || 1).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    concatIn += `[v${i}][a${i}]`;
  });
  parts.push(`${concatIn}concat=n=${probes.length}:v=1:a=1[v][a]`);

  const dir = paths.nodeAssets(pid, eid, nodeId);
  await ensureDir(dir);
  const no = await nextVersionNo(dir);
  const out = path.join(dir, `v${no}.mp4`);
  const tmp = `${out}.part.mp4`;
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp);
  const r = await run('ffmpeg', args);
  if (r.code !== 0) {
    await fsp.rm(tmp, { force: true });
    console.error('拼接失败：', r.err);
    const last = r.err.split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error(`拼接失败：${last.length > 240 ? `${last.slice(0, 240)}…` : last}`);
  }
  await fsp.rename(tmp, out);
  const duration = probes.reduce((s, p) => s + p.duration, 0);
  await writeJson(path.join(dir, `v${no}.json`), { kind: 'stitch', clips: files, size: `${W}x${H}`, duration, createdAt: nowIso() });
  return { file: rel(out), duration };
}
