// 资产库：所有画布共用。素材文件复制一份到 workspace/assets/files，删掉画布也不会丢。
// 列表存在 workspace/assets/assets.json。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Asset } from '../shared/types.js';
import { WORKSPACE, absFromRel, ensureDir, newId, nowIso, readJson, rel, writeJson } from './storage.js';

const DIR = () => path.join(WORKSPACE, 'assets');
const FILE = () => path.join(DIR(), 'assets.json');

export async function listAssets(): Promise<Asset[]> {
  return readJson<Asset[]>(FILE(), []);
}

export interface AssetInput {
  kind: Asset['kind'];
  name: string;
  file?: string; // 工作文件夹里的相对路径
  text?: string;
  projectId?: string;
}

/** 批量存入；同一个原文件 / 同一段文字已经存过的就跳过 */
export async function addAssets(items: AssetInput[]): Promise<{ added: Asset[]; skipped: number }> {
  const all = await listAssets();
  const added: Asset[] = [];
  let skipped = 0;
  await ensureDir(path.join(DIR(), 'files'));
  for (const it of items) {
    if (it.file) {
      if (all.some((a) => a.from === it.file || a.file === it.file)) {
        skipped++;
        continue;
      }
      const src = absFromRel(it.file);
      const dest = path.join(DIR(), 'files', `${newId('as_')}${path.extname(src)}`);
      try {
        await fsp.copyFile(src, dest);
      } catch {
        skipped++;
        continue;
      }
      const a: Asset = { id: newId('a_'), kind: it.kind, name: it.name, file: rel(dest), from: it.file, projectId: it.projectId, createdAt: nowIso() };
      all.unshift(a);
      added.push(a);
    } else if (it.text?.trim()) {
      if (all.some((a) => a.kind === it.kind && a.text === it.text)) {
        skipped++;
        continue;
      }
      const a: Asset = { id: newId('a_'), kind: it.kind, name: it.name, text: it.text, projectId: it.projectId, createdAt: nowIso() };
      all.unshift(a);
      added.push(a);
    } else skipped++;
  }
  if (added.length) await writeJson(FILE(), all);
  return { added, skipped };
}

export async function deleteAsset(id: string) {
  const all = await listAssets();
  const a = all.find((x) => x.id === id);
  if (!a) return;
  await writeJson(
    FILE(),
    all.filter((x) => x.id !== id),
  );
  if (a.file) await fsp.rm(absFromRel(a.file), { force: true }).catch(() => {});
}

export async function renameAsset(id: string, name: string) {
  const all = await listAssets();
  const a = all.find((x) => x.id === id);
  if (!a) throw new Error('资产不存在');
  a.name = name;
  await writeJson(FILE(), all);
  return a;
}
