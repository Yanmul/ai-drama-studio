// 项目、剧集、画布、角色的读写，以及第一次启动时的示例项目。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CanvasFile, Character, Episode, NodeData, Project, ProjectSummary } from '../shared/types.js';
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

// —— 第一次启动：放一个《压线过弯》示例项目，打开就能看到怎么用 ——

function node(id: string, kind: NodeData['kind'], title: string, x: number, y: number, extra: Partial<NodeData> = {}) {
  const data: NodeData = {
    kind,
    title,
    versions: [],
    current: -1,
    gen: { prompt: '', params: {}, refRoles: {} },
    ...extra,
  };
  return { id, type: 'media', position: { x, y }, data };
}

export async function seedIfEmpty() {
  if ((await listDirs(paths.projects())).length) return;
  await ensureDir(paths.projects());
  const p: Project = {
    id: 'yaxian',
    name: '压线过弯',
    style: '写实电影质感，2010 年代中国四川小城，胶片颗粒感，浅景深，画面中不出现任何文字',
    ratio: '9:16',
    createdAt: nowIso(),
  };
  await writeJson(paths.projectFile(p.id), p);
  const hero = await saveCharacter(p.id, {
    id: 'char_hubobing_young',
    name: '胡柏冰（少年）',
    description: '11 岁中国男孩，偏胖，圆脸，脸颊鼓鼓的，黑色中分头发长短不齐，额前一绺头发翘起来，穿褪色的蓝白色小学校服',
  });
  const e: Episode = { id: 'ep01', index: 1, title: '第1集 靠窗第二排' };
  await writeJson(path.join(paths.episode(p.id, e.id), 'episode.json'), e);

  const script = [
    '镜头1：老式 CRT 显示器上，一辆卡通赛车在弯道漂移，差一点撞墙。男孩凑近屏幕看呆了。',
    '镜头2：两个男孩坐在电脑前。瘦男孩得意地问「帅不帅？」，胖男孩问「它咋个不撞墙？」',
    '镜头3：男孩用手指隔空描屏幕上的弯道；黄昏老街上，他边走边在空中画弧线。',
    '镜头4：他专心画线，额头撞上电线杆，左右看看没人，接着走；切到冰箱门上的纸条。',
    '镜头5：狭小厨房，他踮脚热剩饭，油溅到手背，缩一下手接着翻饭。',
    '镜头6：挂历纸背面画满了一条条弯道；一碗米饭冒着最后一缕热气（静止镜头）。',
    '镜头7：门外钥匙声，他把纸塞到碗底，低头扒饭。妈妈问「作业写完没得？」',
  ].join('\n\n');

  const videoGen = (prompt: string) => ({
    modelId: 'demo/video',
    mode: 'omni',
    prompt,
    params: { ratio: '9:16', resolution: '720p', duration: 5, count: 1, generate_audio: true },
    refRoles: {},
  });

  const canvas: CanvasFile = {
    nodes: [
      node('n_script', 'script', '脚本 · 第1集', -560, -80, { text: script }),
      node('n_hero', 'image', '胡柏冰（少年）定妆图', 0, 440, {
        characterId: hero.id,
        gen: {
          modelId: 'demo/image',
          mode: 't2i',
          prompt: '角色定妆照，正面半身，纯色背景，' + hero.description,
          params: { ratio: '3:4', count: 1 },
          refRoles: {},
        },
      }),
      node('n_t1', 'text', '镜头1 · 提示词', 0, -300, {
        text: '镜头1（0-4秒）：特写老式 CRT 显示器，屏幕上一辆卡通赛车在弯道漂移，车身贴着护栏擦过，差一点撞墙，轮胎冒白烟。\n镜头2（4-10秒）：切到近景，@图1 慢慢把脸凑近屏幕，屏幕蓝光在脸上闪动，嘴微微张开，看得入迷。',
      }),
      node('n_v1', 'video', '视频节点 1', 440, -380, { gen: videoGen('冷蓝色调，房间昏暗，屏幕光是唯一光源。') }),
      node('n_t2', 'text', '镜头2 · 提示词', 0, 80, {
        text: '镜头1（0-5秒）：中景，两个男孩并排坐在老式电脑前。瘦男孩得意地说「帅不帅？漂移！」，@图1 一动不动盯着屏幕。\n镜头2（5-10秒）：@图1 眉头微皱，小声问「它咋个不撞墙？」',
      }),
      node('n_v2', 'video', '视频节点 2', 440, 20, { gen: videoGen('午后阳光从窗帘缝里透进来，自然光。') }),
    ],
    edges: [
      { id: 'e1', source: 'n_t1', target: 'n_v1' },
      { id: 'e2', source: 'n_hero', target: 'n_v1' },
      { id: 'e3', source: 'n_t2', target: 'n_v2' },
      { id: 'e4', source: 'n_hero', target: 'n_v2' },
    ],
    viewport: { x: 660, y: 420, zoom: 0.72 },
  };
  await writeJson(paths.canvas(p.id, e.id), canvas);
}
