// 定时清理：每 3 天一次，删掉 3 天前生成 / 上传的图片、视频、音频，省硬盘。
// 保留：定稿（⭐）的版本、角色库用到的图；资产库（workspace/assets）本来就单独存了一份，不动。
// 项目、画布、剧本文字都不删；节点里文件被删的版本一起去掉。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CanvasFile } from '../shared/types.js';
import { pruneDeletedVersions } from '../shared/cleanup.js';
import { listCharacters, saveCanvas } from './projects.js';
import { events } from './queue.js';
import { kindOfFile, listDirs, nowIso, paths, readJson, rel, writeJson } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;
export const KEEP_DAYS = 3; // 文件超过几天就删
export const EVERY_DAYS = 3; // 几天清理一次
const CHECK_MS = 60 * 60 * 1000; // 每小时看一眼到没到时间（服务没开着的那几天，下次启动时补上）

export interface CleanupState {
  lastRun?: string;
  lastResult?: { files: number; bytes: number };
}

const stateFile = () => path.join(paths.config(), 'cleanup.json');

export async function cleanupStatus() {
  const s = await readJson<CleanupState>(stateFile(), {});
  const nextRun = s.lastRun ? new Date(Date.parse(s.lastRun) + EVERY_DAYS * DAY).toISOString() : undefined;
  return { ...s, nextRun, keepDays: KEEP_DAYS, everyDays: EVERY_DAYS };
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

let running: Promise<CleanupState['lastResult']> | null = null;

/** 清理一次（同一时间只跑一个） */
export function runCleanup(): Promise<CleanupState['lastResult']> {
  running ??= doCleanup().finally(() => (running = null));
  return running;
}

async function doCleanup() {
  const cutoff = Date.now() - KEEP_DAYS * DAY;
  const deleted = new Set<string>();
  let bytes = 0;

  const remove = async (abs: string) => {
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return;
    await fsp.rm(abs, { force: true });
    bytes += st.size;
    deleted.add(rel(abs));
  };
  const old = async (abs: string) => ((await fsp.stat(abs).catch(() => null))?.mtimeMs ?? Infinity) < cutoff;

  for (const pid of await listDirs(paths.projects())) {
    // —— 要保留的文件：角色图 + 所有画布里的定稿版本 ——
    const keep = new Set<string>();
    for (const c of await listCharacters(pid)) if (c.image) keep.add(c.image);
    const episodes = await listDirs(paths.episodes(pid));
    const canvases = new Map<string, CanvasFile>();
    for (const eid of episodes) {
      const canvas = await readJson<CanvasFile | null>(paths.canvas(pid, eid), null).catch(() => null);
      if (!canvas) continue;
      canvases.set(eid, canvas);
      for (const n of canvas.nodes || []) {
        const star = n.data?.starred ? n.data.versions?.find((v) => v.id === n.data.starred) : undefined;
        if (star?.file) keep.add(star.file);
      }
    }

    // —— 上传的素材 ——
    for (const f of await filesIn(paths.uploads(pid))) {
      if (!keep.has(rel(f)) && (await old(f))) await remove(f);
    }

    // —— 生成的结果：assets/<节点>/v3.mp4（连同记录提示词的 v3.json） ——
    for (const eid of episodes) {
      const assetsRoot = path.join(paths.episode(pid, eid), 'assets');
      for (const nodeId of await listDirs(assetsRoot)) {
        const dir = path.join(assetsRoot, nodeId);
        for (const f of await filesIn(dir)) {
          if (kindOfFile(f) === 'other' || keep.has(rel(f)) || !(await old(f))) continue;
          await remove(f);
          await fsp.rm(f.replace(/\.[^./]+$/, '.json'), { force: true });
        }
        // 节点文件夹空了就删掉
        if (!fs.readdirSync(dir).length) await fsp.rmdir(dir).catch(() => undefined);
      }
    }

    // —— 节点里文件被删的版本一起去掉 ——
    if (deleted.size) {
      for (const [eid, canvas] of canvases) {
        let changed = false;
        const nodes = (canvas.nodes || []).map((n) => {
          const next = n.data && pruneDeletedVersions(n.data, deleted);
          if (!next) return n;
          changed = true;
          return { ...n, data: next };
        });
        if (changed) await saveCanvas(pid, eid, { ...canvas, nodes });
      }
    }
  }

  const result = { files: deleted.size, bytes };
  await writeJson(stateFile(), { lastRun: nowIso(), lastResult: result } satisfies CleanupState);
  // 正开着的画布也要把这些版本去掉，不然它下次自动保存会把删掉的版本写回去
  events.emit('event', { type: 'cleanup', deleted: [...deleted], ...result });
  if (deleted.size) console.log(`  自动清理：删除 ${deleted.size} 个 ${KEEP_DAYS} 天前的文件，释放 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return result;
}

/** 启动时检查一次，之后每小时检查：距上次清理满 3 天就清理 */
export function startCleanupSchedule() {
  const tick = async () => {
    try {
      const s = await readJson<CleanupState>(stateFile(), {});
      if (!s.lastRun || Date.now() - Date.parse(s.lastRun) >= EVERY_DAYS * DAY) await runCleanup();
    } catch (e) {
      console.error('自动清理出错：', e);
    }
  };
  tick();
  setInterval(tick, CHECK_MS).unref();
}
