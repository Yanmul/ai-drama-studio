// 从连进来的节点算出「参考素材」和「输入文本」，面板显示和提交生成共用这一份逻辑。
import type { GenerateRequest, ModeDef, ModelInfo, NodeData, RefRole } from '../shared/types';
import { activeVersion, defaultParams, fileKind } from './lib';

export interface MediaInput {
  nodeId: string;
  kind: 'image' | 'video' | 'audio';
  title: string;
  file: string;
  characterId?: string;
  /** 在提示词里的叫法：@图1 / @视频1 / @音频1 */
  token: string;
  role: RefRole;
}

export interface CharInput {
  nodeId: string;
  title: string;
  characterId: string;
}

export interface TextInput {
  nodeId: string;
  title: string;
  text: string;
}

const TOKEN = { image: '图', video: '视频', audio: '音频' } as const;

export function collectInputs(
  sources: { id: string; data: NodeData }[],
  gen: NodeData['gen'],
  mode?: ModeDef,
): { media: MediaInput[]; texts: TextInput[]; chars: CharInput[] } {
  const media: MediaInput[] = [];
  const texts: TextInput[] = [];
  const chars: CharInput[] = [];
  const count = { image: 0, video: 0, audio: 0 };
  for (const s of sources) {
    const d = s.data;
    if (!d) continue;
    if (d.kind === 'text' || d.kind === 'script') {
      if (d.text?.trim()) texts.push({ nodeId: s.id, title: d.title, text: d.text.trim() });
      continue;
    }
    const v = activeVersion(d);
    if (!v?.file) {
      if (d.characterId) chars.push({ nodeId: s.id, title: d.title, characterId: d.characterId });
      continue;
    }
    const k = fileKind(v.file);
    const kind: MediaInput['kind'] = k === 'video' ? 'video' : k === 'audio' ? 'audio' : 'image';
    count[kind] += 1;
    media.push({
      nodeId: s.id,
      kind,
      title: d.title,
      file: v.file,
      characterId: d.characterId,
      token: `@${TOKEN[kind]}${count[kind]}`,
      role: 'reference',
    });
  }
  // 首尾帧模式：图片按顺序默认第 1 张首帧、第 2 张尾帧，可以在面板里点角标切换
  const imgs = media.filter((m) => m.kind === 'image');
  if (mode?.imageRoles?.includes('first_frame')) {
    imgs.forEach((m, i) => {
      m.role = gen.refRoles[m.nodeId] || (i === 0 ? 'first_frame' : 'last_frame');
    });
  }
  return { media, texts, chars };
}

export function buildRequest(
  projectId: string,
  episodeId: string,
  nodeId: string,
  data: NodeData,
  model: ModelInfo,
  sources: { id: string; data: NodeData }[],
): GenerateRequest {
  const mode = model.modes.find((m) => m.id === data.gen.mode) || model.modes[0];
  const { media, texts, chars } = collectInputs(sources, data.gen, mode);
  const max = mode?.maxRefs || {};
  const usable = media.filter((m) => {
    const limit = max[m.kind] || 0;
    const idx = media.filter((x) => x.kind === m.kind).indexOf(m);
    return idx < limit;
  });
  const inputTexts = texts.map((t) => t.text);
  // 文本节点自己的正文也是输入（比如让模型改写这段）
  if (data.kind === 'text' && data.text?.trim()) inputTexts.unshift(data.text.trim());
  return {
    projectId,
    episodeId,
    nodeId,
    modelId: model.id,
    mode: mode?.id || 'default',
    prompt: data.gen.prompt || '',
    inputTexts,
    refs: usable.map((m) => ({ nodeId: m.nodeId, kind: m.kind, file: m.file, role: m.role, characterId: m.characterId })),
    // 没有定妆图的角色，以及被模式限制用不上的角色图，都至少把外形描述带上
    characterIds: [
      ...chars.map((c) => c.characterId),
      ...media.filter((m) => m.characterId && !usable.includes(m)).map((m) => m.characterId!),
    ],
    params: data.gen.params,
  };
}

/** 预估花费（元）；模型没填单价返回 undefined */
export function estimateCostNumber(model: ModelInfo | undefined, raw: Record<string, unknown>): number | undefined {
  const pr = model?.price;
  if (!pr) return undefined;
  const params = { ...defaultParams(model), ...raw };
  let n = pr.amount;
  if (pr.unit === 'per_second') n = pr.amount * (Number(params.duration) || 5) * (model?.capability === 'video' ? Number(params.count) || 1 : 1);
  if (pr.unit === 'per_image') n = pr.amount * (Number(params.count) || 1);
  if (pr.unit === 'per_call' && model?.capability === 'video') n = pr.amount * (Number(params.count) || 1);
  return n;
}

export function estimateCost(model: ModelInfo | undefined, params: Record<string, unknown>): string {
  const n = estimateCostNumber(model, params);
  return n === undefined ? '—' : `¥${n.toFixed(2)}`;
}
