// 项目、剧集、画布、角色的读写。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CanvasFile, Character, Episode, Project, ProjectSummary } from '../shared/types.js';
import { WORKSPACE, ensureDir, listDirs, listFiles, newId, nowIso, paths, readJson, rotateBackups, safe, writeJson } from './storage.js';

// 同一个 key 的操作排队进行（读-比较-写 不会被另一次同类操作插进来）
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => undefined);
  return next;
}

/** 列表里单个文件读不了就跳过，别让一个坏文件拖垮整个列表 */
async function tryRead<T>(file: string): Promise<T | null> {
  try {
    const v = await readJson<T | null>(file, null);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    console.error(`读取 ${file} 失败，已跳过：`, e);
    return null;
  }
}

export async function listProjects(): Promise<Project[]> {
  const out: Project[] = [];
  for (const d of await listDirs(paths.projects())) {
    const p = await tryRead<Project>(paths.projectFile(d));
    if (p?.id) out.push(p);
  }
  return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/** 主页用：每个画布的封面、节点数、最后修改时间 */
export async function projectSummaries(): Promise<ProjectSummary[]> {
  const out: ProjectSummary[] = [];
  for (const p of await listProjects()) {
    const eps = await listEpisodes(p.id);
    let nodeCount = 0;
    let updatedAt = p.createdAt || '';
    let lastEpisodeId = eps[0]?.id;
    const covers: { file: string; at: string }[] = [];
    for (const e of eps) {
      const c = await tryRead<CanvasFile>(paths.canvas(p.id, e.id));
      if (!c) continue;
      const nodes = Array.isArray(c.nodes) ? c.nodes : [];
      nodeCount += nodes.length;
      if (c.savedAt && c.savedAt > updatedAt) {
        updatedAt = c.savedAt;
        lastEpisodeId = e.id;
      }
      for (const n of nodes) {
        for (const v of n?.data?.versions || []) {
          if (v.file && /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm)$/i.test(v.file)) covers.push({ file: v.file, at: v.createdAt || '' });
        }
      }
    }
    covers.sort((a, b) => b.at.localeCompare(a.at));
    out.push({ ...p, episodeCount: eps.length, nodeCount, updatedAt, lastEpisodeId, covers: covers.slice(0, 4).map((c) => c.file) });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 删除画布：不真删，挪到 workspace/.trash，后悔了还能拖回来 */
export async function trashProject(pid: string) {
  const trash = path.join(WORKSPACE, '.trash');
  await ensureDir(trash);
  await fsp.rename(paths.project(pid), path.join(trash, `${safe(pid)}-${Date.now()}`));
}

export async function createProject(name: string, style = '', ratio = '16:9'): Promise<Project> {
  const p: Project = { id: newId('proj_'), name: name || '未命名项目', style, ratio, createdAt: nowIso() };
  await writeJson(paths.projectFile(p.id), p);
  await createEpisode(p.id, '第1集');
  return p;
}

export async function updateProject(pid: string, patch: Partial<Project>): Promise<Project> {
  const p = await readJson<Project | null>(paths.projectFile(pid), null);
  if (!p) throw new Error('项目不存在');
  const next = { ...p, ...patch, id: p.id, createdAt: p.createdAt };
  await writeJson(paths.projectFile(pid), next);
  return next;
}

export async function listEpisodes(pid: string): Promise<Episode[]> {
  const out: Episode[] = [];
  for (const d of await listDirs(paths.episodes(pid))) {
    const e = await tryRead<Episode>(path.join(paths.episode(pid, d), 'episode.json'));
    if (e?.id) out.push(e);
  }
  return out.sort((a, b) => a.index - b.index);
}

export function createEpisode(pid: string, title?: string): Promise<Episode> {
  // 同一个项目里排队建，两次同时点「新建」不会撞号
  return serial(`episode:${paths.episodes(pid)}`, async () => {
    const eps = await listEpisodes(pid);
    let index = Math.max(0, ...eps.map((e) => Number(e.index) || 0)) + 1;
    await ensureDir(paths.episodes(pid));
    // 文件夹已经存在（比如 episode.json 坏了没列出来）就往后挪，绝不覆盖已有的画布
    for (;;) {
      try {
        await fsp.mkdir(paths.episode(pid, `ep${String(index).padStart(2, '0')}`));
        break;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        index += 1;
      }
    }
    const e: Episode = { id: `ep${String(index).padStart(2, '0')}`, index, title: title || `第${index}集` };
    await writeJson(path.join(paths.episode(pid, e.id), 'episode.json'), e);
    await writeJson(paths.canvas(pid, e.id), { nodes: [], edges: [] } satisfies CanvasFile);
    return e;
  });
}

export async function updateEpisode(pid: string, eid: string, title: string): Promise<Episode> {
  const f = path.join(paths.episode(pid, eid), 'episode.json');
  const e = await readJson<Episode | null>(f, null);
  if (!e) throw new Error('剧集不存在');
  e.title = title;
  await writeJson(f, e);
  return e;
}

export async function readCanvas(pid: string, eid: string): Promise<CanvasFile> {
  const c = await readJson<CanvasFile | null>(paths.canvas(pid, eid), null);
  if (!c || typeof c !== 'object') return { nodes: [], edges: [] };
  return { ...c, nodes: Array.isArray(c.nodes) ? c.nodes : [], edges: Array.isArray(c.edges) ? c.edges : [] };
}

const lastBackup = new Map<string, number>();

export type SaveCanvasResult = { ok: true; savedAt: string } | { conflict: true; savedAt?: string };

/**
 * 保存画布。带了 baseSavedAt（前端上次读到 / 存下的 savedAt）而硬盘上的已经变了 → 不写，返回 conflict；
 * 不带就直接覆盖（自动清理这类内部调用）。同一个画布的保存排队进行。
 */
export function saveCanvas(pid: string, eid: string, canvas: CanvasFile): Promise<SaveCanvasResult> {
  if (!canvas || typeof canvas !== 'object' || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    return Promise.reject(new Error('画布数据不对：nodes 和 edges 必须是数组'));
  }
  const file = paths.canvas(pid, eid);
  const { baseSavedAt, savedAt: _old, ...rest } = canvas;
  return serial(`canvas:${file}`, async () => {
    const disk = await readJson<CanvasFile | null>(file, null);
    // 硬盘上没有 savedAt（新建的、或坏了被挪走）就不算冲突，直接写
    if (baseSavedAt && disk?.savedAt && disk.savedAt !== baseSavedAt) return { conflict: true, savedAt: disk.savedAt };
    // 自动保存很频繁，历史版本最多每 2 分钟留一份
    const last = lastBackup.get(file) || 0;
    if (Date.now() - last > 120_000) {
      lastBackup.set(file, Date.now());
      await rotateBackups(file);
    }
    // 保证新的 savedAt 一定和旧的不同（同一毫秒内连存两次也能分辨）
    const prev = Date.parse(disk?.savedAt || '');
    const savedAt = prev >= Date.now() ? new Date(prev + 1).toISOString() : nowIso();
    await writeJson(file, { ...rest, savedAt });
    return { ok: true, savedAt };
  });
}

export async function listCharacters(pid: string): Promise<Character[]> {
  const out: Character[] = [];
  for (const f of await listFiles(paths.characters(pid))) {
    const c = await tryRead<Character>(f);
    if (c?.id) out.push(c);
  }
  return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export async function saveCharacter(pid: string, c: Partial<Character> & { name: string }): Promise<Character> {
  const full: Character = {
    id: c.id || newId('char_'),
    name: c.name,
    description: c.description || '',
    image: c.image,
    createdAt: c.createdAt || nowIso(),
  };
  await writeJson(path.join(paths.characters(pid), `${safe(full.id)}.json`), full);
  return full;
}

export async function deleteCharacter(pid: string, cid: string) {
  await fsp.rm(path.join(paths.characters(pid), `${safe(cid)}.json`), { force: true });
}
