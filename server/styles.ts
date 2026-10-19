// 风格库：内置一批常用画风，再加上自己保存的（workspace/config/styles.json）。
// 项目选了某个风格 = 把它的描述存进 project.style，生成图片 / 视频时自动拼到提示词前面。
import path from 'node:path';
import type { StylePreset } from '../shared/types.js';
import { newId, paths, readJson, writeJson } from './storage.js';

export const BUILTIN_STYLES: StylePreset[] = [
  { id: 'guoman-campus', name: '国漫校园', prompt: '国漫校园动漫风格，赛璐璐上色，干净利落的线条，明亮通透的色彩，柔和的自然光影，电影感构图' },
  { id: 'jp-anime', name: '日系动漫', prompt: '日系动画电影风格，细腻的手绘背景，清新柔和的色调，通透的光影和天空，人物线条干净，表情细腻' },
  { id: 'real-film', name: '写实电影', prompt: '写实电影质感，真实的人物与场景，电影级布光，浅景深，自然肤色，轻微胶片颗粒感' },
  { id: 'urban-drama', name: '都市短剧', prompt: '真人都市短剧质感，现代都市场景，明亮干净的商业打光，时尚精致的服装妆容，画面清晰锐利' },
  { id: 'manhwa', name: '韩漫', prompt: '韩国条漫风格，精致的人物五官，柔和的厚涂上色，偏冷的时尚色调，干净简洁的背景' },
  { id: 'xianxia', name: '古风仙侠', prompt: '中国古风仙侠风格，飘逸的古装服饰，云雾缭绕的山水背景，青绿与金色点缀，唯美空灵的意境' },
  { id: 'ink', name: '水墨国风', prompt: '中国水墨画风格，宣纸质感，墨色浓淡变化，大面积留白，写意笔触，淡雅设色' },
  { id: '3d-anim', name: '3D 动画', prompt: '3D 动画电影风格，皮克斯质感，圆润可爱的角色造型，柔和的全局光照，饱满明快的色彩' },
  { id: 'hk-retro', name: '复古港风', prompt: '90 年代香港电影风格，暖黄色调，明显的胶片颗粒，霓虹招牌，略带怀旧的柔焦氛围' },
  { id: 'cyberpunk', name: '赛博朋克', prompt: '赛博朋克风格，霓虹灯光，雨夜湿润反光的街道，高对比的青紫色调，密集的未来都市' },
].map((s) => ({ ...s, builtin: true }));

interface StylesFile {
  styles: StylePreset[];
}

const file = () => path.join(paths.config(), 'styles.json');

async function custom(): Promise<StylePreset[]> {
  return (await readJson<StylesFile>(file(), { styles: [] })).styles || [];
}

export async function listStyles(): Promise<StylePreset[]> {
  return [...BUILTIN_STYLES, ...(await custom())];
}

export async function addStyle(input: { name?: string; prompt?: string }): Promise<StylePreset> {
  const name = (input.name || '').trim().slice(0, 20);
  const prompt = (input.prompt || '').trim();
  if (!name) throw new Error('风格要起个名字');
  if (!prompt) throw new Error('风格描述是空的');
  const list = await custom();
  if ([...BUILTIN_STYLES, ...list].some((s) => s.name === name)) throw new Error(`已经有叫「${name}」的风格了，换个名字`);
  const s: StylePreset = { id: newId('style_'), name, prompt };
  await writeJson(file(), { styles: [...list, s] });
  return s;
}

export async function deleteStyle(id: string) {
  if (BUILTIN_STYLES.some((s) => s.id === id)) throw new Error('内置风格不能删除');
  await writeJson(file(), { styles: (await custom()).filter((s) => s.id !== id) });
}
