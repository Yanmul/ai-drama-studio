import type { Capability, GenState, ModelInfo, NodeData, NodeKind, Version } from '../shared/types';

export const newId = (p = 'n_') => p + Math.random().toString(36).slice(2, 10);

export const KIND_LABEL: Record<NodeKind, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  script: '脚本',
};

/** 节点种类 → 生成时用哪类模型 */
export const KIND_CAP: Partial<Record<NodeKind, Capability>> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
};

/** 当前给下游用的版本：定稿优先，没有定稿就用正在看的那一版 */
export function activeVersion(d: NodeData): Version | undefined {
  if (d.starred) {
    const s = d.versions.find((v) => v.id === d.starred);
    if (s) return s;
  }
  return d.current >= 0 ? d.versions[d.current] : undefined;
}

export function shownVersion(d: NodeData): Version | undefined {
  return d.current >= 0 ? d.versions[d.current] : undefined;
}

/** 某个模型的参数默认值 */
export function defaultParams(m?: ModelInfo): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of m?.params || []) if (p.default !== undefined) out[p.key] = p.default;
  return out;
}

export function pickModel(models: ModelInfo[], cap: Capability, preferred?: string): ModelInfo | undefined {
  const list = models.filter((m) => m.capability === cap);
  return list.find((m) => m.id === preferred) || list[0];
}

export function emptyGen(models: ModelInfo[], kind: NodeKind, projectRatio?: string): GenState {
  const cap = KIND_CAP[kind];
  const m = cap ? pickModel(models, cap) : undefined;
  const params = defaultParams(m);
  if (projectRatio && m?.params.some((p) => p.key === 'ratio' && p.options?.includes(projectRatio))) params.ratio = projectRatio;
  const mode = kind === 'video' ? (m?.modes.find((x) => x.id === 'omni') || m?.modes[0])?.id : m?.modes[0]?.id;
  return { modelId: m?.id, mode, prompt: '', params, refRoles: {} };
}

export function makeNodeData(kind: NodeKind, title: string, models: ModelInfo[], projectRatio?: string, extra: Partial<NodeData> = {}): NodeData {
  return {
    kind,
    title,
    versions: [],
    current: -1,
    gen: emptyGen(models, kind, projectRatio),
    text: kind === 'text' || kind === 'script' ? '' : undefined,
    ...extra,
  };
}

export function fileKind(file?: string): 'image' | 'video' | 'audio' | 'other' {
  if (!file) return 'other';
  const ext = file.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'other';
}

export function fmtTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 运镜预设：点一下插到提示词里 */
export const CAMERA_MOVES = [
  '固定机位',
  '缓慢推镜头',
  '缓慢拉镜头',
  '水平摇镜头',
  '跟拍',
  '环绕拍摄',
  '俯拍',
  '仰拍',
  '手持轻微晃动',
  '升降镜头',
  '一镜到底',
];
