// 组装最终提示词：项目画风 + 连进来的文本 + 角色外形描述 + 你写的提示词。
// 你在面板里写的 @图1 / @视频1 / @音频1，会换成厂商认识的叫法（火山是「图片1」）。
import type { Character, GenerateRequest, Project, ProviderModelConfig } from '../shared/types.js';
import type { Adapter } from './providers/types.js';
import { paths, readJson, safe } from './storage.js';
import path from 'node:path';

export async function loadProject(pid: string): Promise<Project | null> {
  return readJson<Project | null>(paths.projectFile(pid), null);
}

export async function loadCharacter(pid: string, cid: string): Promise<Character | null> {
  return readJson<Character | null>(path.join(paths.characters(pid), `${safe(cid)}.json`), null);
}

const KIND_ZH = { image: '图', video: '视频', audio: '音频' } as const;
const KIND_WORD = { character: '角色', scene: '场景', prop: '道具' } as const;

export async function buildPrompt(req: GenerateRequest, adapter: Adapter, model: ProviderModelConfig): Promise<string> {
  const counters = { image: 0, video: 0, audio: 0 };
  const labelOf = new Map<string, string>(); // '@图1' -> '图片1'
  const characterLines: string[] = [];
  let firstFrameLine = '';
  for (const r of req.refs) {
    counters[r.kind] += 1;
    const n = counters[r.kind];
    const label = adapter.refLabel ? adapter.refLabel(r.kind, n, model) : `${r.kind} ${n}`;
    labelOf.set(`@${KIND_ZH[r.kind]}${n}`, label);
    // 接上一条尾帧：这一条要从那张图的画面开始
    if (r.kind === 'image' && req.firstFrameNodeId && r.nodeId === req.firstFrameNodeId) {
      firstFrameLine = `首帧为${label}：画面从这张图开始，人物位置、景别、光线和它一致，再往下演。`;
    }
    if (r.characterId) {
      const c = await loadCharacter(req.projectId, r.characterId);
      if (c) characterLines.push(`${label}是${KIND_WORD[c.kind || 'character']}「${c.name}」${r.variant ? `（${r.variant}）` : ''}${c.description ? `：${c.description}` : ''}`);
    }
  }
  for (const cid of req.characterIds || []) {
    const c = await loadCharacter(req.projectId, cid);
    if (c && !characterLines.some((l) => l.includes(`「${c.name}」`))) characterLines.push(`${KIND_WORD[c.kind || 'character']}「${c.name}」${c.description ? `：${c.description}` : ''}`);
  }
  const swap = (s: string) => s.replace(/@(图|视频|音频)(\d+)/g, (m) => labelOf.get(m) || m);
  const user = swap(req.prompt || '');
  const inputs = req.inputTexts.map(swap);

  if (model.capability === 'text') {
    return [...inputs, user].filter((s) => s && s.trim()).join('\n\n');
  }
  const project = await loadProject(req.projectId);
  const parts = [
    firstFrameLine,
    project?.style && !req.noStyle ? `画风：${project.style}` : '',
    ...inputs,
    ...characterLines,
    user,
  ];
  return parts.filter((s) => s && s.trim()).join('\n');
}
