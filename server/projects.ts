// 项目、剧集、画布、角色的读写。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CanvasFile, Character, Episode, Project, ProjectSummary } from '../shared/types.js';
import { WORKSPACE, ensureDir, listDirs, listFiles, newId, nowIso, paths, readJson, rotateBackups, safe, writeJson } from './storage.js';

export async function listProjects(): Promise<Project[]> {
  const out: Project[] = [];
  for (const d of await listDirs(paths.projects())) {
    const p = await readJson<Project | null>(paths.projectFile(d), null);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 主页用：每个画布的封面、节点数、最后修改时间 */
export async function projectSummaries(): Promise<ProjectSummary[]> {
  const out: ProjectSummary[] = [];
  for (const p of await listProjects()) {
    const eps = await listEpisodes(p.id);
    let nodeCount = 0;
    let updatedAt = p.createdAt;
    let lastEpisodeId = eps[0]?.id;
    const covers: { file: string; at: string }[] = [];
    for (const e of eps) {
      const c = await readCanvas(p.id, e.id);
      nodeCount += c.nodes.length;
      if (c.savedAt && c.savedAt > updatedAt) {
        updatedAt = c.savedAt;
        lastEpisodeId = e.id;
      }
      for (const n of c.nodes) {
        for (const v of n.data.versions || []) {
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
    const e = await readJson<Episode | null>(path.join(paths.episode(pid, d), 'episode.json'), null);
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.index - b.index);
}

export async function createEpisode(pid: string, title?: string): Promise<Episode> {
  const eps = await listEpisodes(pid);
  const index = (eps.at(-1)?.index || 0) + 1;
  const e: Episode = { id: `ep${String(index).padStart(2, '0')}`, index, title: title || `第${index}集` };
  await writeJson(path.join(paths.episode(pid, e.id), 'episode.json'), e);
  await writeJson(paths.canvas(pid, e.id), { nodes: [], edges: [] } satisfies CanvasFile);
  return e;
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
  return readJson<CanvasFile>(paths.canvas(pid, eid), { nodes: [], edges: [] });
}

let lastBackup = new Map<string, number>();

export async function saveCanvas(pid: string, eid: string, canvas: CanvasFile) {
  const file = paths.canvas(pid, eid);
  // 自动保存很频繁，历史版本最多每 2 分钟留一份
  const last = lastBackup.get(file) || 0;
  if (Date.now() - last > 120_000) {
    await rotateBackups(file);
    lastBackup.set(file, Date.now());
  }
  await writeJson(file, { ...canvas, savedAt: nowIso() });
}

export async function listCharacters(pid: string): Promise<Character[]> {
  const out: Character[] = [];
  for (const f of await listFiles(paths.characters(pid))) {
    const c = await readJson<Character | null>(f, null);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
