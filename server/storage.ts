// 本地文件存储：不用数据库，所有东西都是工作文件夹里的 JSON 和素材文件。
// 规矩：写文件先写 .tmp 再改名（断电不会写出半个文件）；同一个文件的写入排队进行。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 工作文件夹：默认在项目目录下的 workspace，可以用环境变量 WORKSPACE 改 */
export const WORKSPACE = path.resolve(process.env.WORKSPACE || path.join(ROOT_DIR, 'workspace'));
export const PROJECT_ROOT = ROOT_DIR;

export const paths = {
  config: () => path.join(WORKSPACE, 'config'),
  providers: () => path.join(WORKSPACE, 'config', 'providers.json'),
  settings: () => path.join(WORKSPACE, 'config', 'settings.json'),
  projects: () => path.join(WORKSPACE, 'projects'),
  project: (pid: string) => path.join(WORKSPACE, 'projects', safe(pid)),
  projectFile: (pid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'project.json'),
  characters: (pid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'characters'),
  uploads: (pid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'uploads'),
  episodes: (pid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'episodes'),
  episode: (pid: string, eid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'episodes', safe(eid)),
  canvas: (pid: string, eid: string) => path.join(WORKSPACE, 'projects', safe(pid), 'episodes', safe(eid), 'canvas.json'),
  nodeAssets: (pid: string, eid: string, nodeId: string) =>
    path.join(WORKSPACE, 'projects', safe(pid), 'episodes', safe(eid), 'assets', safe(nodeId)),
  jobsActive: () => path.join(WORKSPACE, 'jobs', 'active'),
  jobsDone: (month: string) => path.join(WORKSPACE, 'jobs', 'done', month),
  jobsDoneRoot: () => path.join(WORKSPACE, 'jobs', 'done'),
};

/** 防止 ../ 跳出工作文件夹 */
export function safe(name: string): string {
  const s = String(name).replace(/[\\/]/g, '_').replace(/\.\.+/g, '_').trim();
  if (!s) throw new Error('非法名称');
  return s;
}

/** 工作文件夹内的绝对路径 → 相对路径（给前端用 /files/<相对路径> 访问） */
export function rel(abs: string): string {
  return path.relative(WORKSPACE, abs).split(path.sep).join('/');
}

/** 相对路径 → 绝对路径，并确认还在工作文件夹里 */
export function absFromRel(relPath: string): string {
  const abs = path.resolve(WORKSPACE, relPath);
  if (!abs.startsWith(WORKSPACE + path.sep)) throw new Error('路径越界');
  return abs;
}

export function newId(prefix = ''): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const txt = await fsp.readFile(file, 'utf-8');
    return JSON.parse(txt) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${rel(file)} 失败：${e?.message || e}`);
  }
}

// 每个文件一条写入队列
const writeChains = new Map<string, Promise<void>>();

export function writeJson(file: string, data: unknown): Promise<void> {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(path.dirname(file));
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fsp.rename(tmp, file);
    });
  writeChains.set(file, next);
  next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  });
  return next;
}

/** 画布保存前，把旧版本挪成 .bak1…bak20，改坏了能退回 */
export async function rotateBackups(file: string, keep = 20) {
  if (!fs.existsSync(file)) return;
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.bak${i}`;
    if (fs.existsSync(from)) await fsp.rename(from, `${file}.bak${i + 1}`).catch(() => undefined);
  }
  await fsp.copyFile(file, `${file}.bak1`).catch(() => undefined);
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export async function listFiles(dir: string, ext = '.json'): Promise<string[]> {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter((d) => d.isFile() && d.name.endsWith(ext)).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function kindOfFile(file: string): 'image' | 'video' | 'audio' | 'other' {
  const m = mimeOf(file);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'other';
}

export function extFromMime(mime: string, fallback: string): string {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  for (const [ext, mm] of Object.entries(MIME)) if (mm === m) return ext;
  return fallback;
}

/** 本地文件 → data URL（给只收 base64 的接口） */
export async function fileToDataUrl(relPath: string): Promise<string> {
  const abs = absFromRel(relPath);
  const buf = await fsp.readFile(abs);
  return `data:${mimeOf(abs)};base64,${buf.toString('base64')}`;
}
