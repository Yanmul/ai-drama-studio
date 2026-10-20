import type { Capability, Character, GenState, ModelInfo, NodeData, NodeKind, SettingImage, SettingKind, Version } from '../shared/types';

export const newId = (p = 'n_') => p + Math.random().toString(36).slice(2, 10);

export const KIND_LABEL: Record<NodeKind, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  script: '脚本',
  cut: '成片',
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

// —— 记住上次用的模型和参数：新节点直接用，不用每次重选 ——
// 模型按类型（图片 / 视频 / 文本）记；参数按模型记（换回这个模型时参数也回来）；
// 比例按项目记（竖屏项目一直竖屏，不串到别的项目）；随机种子不记。
interface GenPrefs {
  model: Partial<Record<Capability, string>>;
  params: Record<string, Record<string, string | number | boolean>>;
  mode: Record<string, string>;
  ratio: Record<string, string>;
}
const PREFS_KEY = 'genPrefs';
// 生成声音不记：新节点一律默认开声音（用户要求），单个节点想关再手动关
const NOT_REMEMBERED = new Set(['seed', 'ratio', 'generate_audio']);

function loadPrefs(): GenPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { model: p.model || {}, params: p.params || {}, mode: p.mode || {}, ratio: p.ratio || {} };
  } catch {
    return { model: {}, params: {}, mode: {}, ratio: {} };
  }
}

/** 用户改了模型 / 参数 / 模式，或者点了生成：记下来，之后新建的节点照这个来 */
export function rememberGen(kind: NodeKind, projectId: string | undefined, gen: Pick<GenState, 'modelId' | 'mode' | 'params'>) {
  const cap = KIND_CAP[kind];
  if (!cap || !gen.modelId) return;
  const p = loadPrefs();
  p.model[cap] = gen.modelId;
  if (gen.mode) p.mode[gen.modelId] = gen.mode;
  p.params[gen.modelId] = Object.fromEntries(Object.entries(gen.params || {}).filter(([k]) => !NOT_REMEMBERED.has(k)));
  if (projectId && gen.params?.ratio !== undefined) p.ratio[projectId] = String(gen.params.ratio);
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

/** 记住的参数里，这个模型还认的那些（模型的选项改过、换了预设时，过期的值丢掉） */
function validParams(m: ModelInfo, saved: Record<string, string | number | boolean> = {}) {
  const out: Record<string, string | number | boolean> = {};
  for (const def of m.params) {
    const v = saved[def.key];
    if (v === undefined) continue;
    if (def.type === 'select' && !def.options?.some((o) => String(o) === String(v))) continue;
    out[def.key] = v;
  }
  return out;
}

export function emptyGen(models: ModelInfo[], kind: NodeKind, project?: { id?: string; ratio?: string }, preferredModel?: string): GenState {
  const cap = KIND_CAP[kind];
  const prefs = loadPrefs();
  const m = cap ? pickModel(models, cap, preferredModel || prefs.model[cap]) : undefined;
  const params = { ...defaultParams(m), ...(m ? validParams(m, prefs.params[m.id]) : {}) };
  // 比例：这个项目上次用的 → 项目默认比例
  const ratioDef = m?.params.find((p) => p.key === 'ratio');
  const ratio = [project?.id ? prefs.ratio[project.id] : undefined, project?.ratio].find((r) => r && ratioDef?.options?.some((o) => String(o) === r));
  if (ratio) params.ratio = ratio;
  const remembered = m && prefs.mode[m.id] && m.modes.some((x) => x.id === prefs.mode[m.id]) ? prefs.mode[m.id] : undefined;
  const mode = remembered || (kind === 'video' ? (m?.modes.find((x) => x.id === 'omni') || m?.modes[0])?.id : m?.modes[0]?.id);
  return { modelId: m?.id, mode, prompt: '', params, refRoles: {} };
}

export function makeNodeData(kind: NodeKind, title: string, models: ModelInfo[], project?: { id?: string; ratio?: string }, extra: Partial<NodeData> = {}): NodeData {
  return {
    kind,
    title,
    versions: [],
    current: -1,
    gen: emptyGen(models, kind, project),
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

// —— 设定库（角色 / 场景 / 道具） ——
export const SETTING_WORD: Record<SettingKind, string> = { character: '角色', scene: '场景', prop: '道具' };
export const settingKind = (c?: Character): SettingKind => c?.kind || 'character';
/** 设定的全部图（旧数据只有 image 一张） */
export const settingImages = (c?: Character): SettingImage[] => (c?.images?.length ? c.images : c?.image ? [{ file: c.image }] : []);

// —— 智能引用：在提示词里找设定库的名字（规则匹配，不靠大模型） ——
export interface SettingMatch {
  setting: Character;
  /** 用设定的哪一张图（提示词里出现了某张图的备注就用那张，否则主图） */
  image?: SettingImage;
  /** 名字在提示词里第一次出现的位置（台词里的不算） */
  index: number;
}

/**
 * 规则：
 * 1. 台词（"…" “…” 「…」里）不算——林骁说「苏婉啊」不代表苏婉在镜头里；
 * 2. 名字后面紧跟「（画外」的不算——只有声音，人不在画面里；
 * 3. skill 格式的提示词（有「场景：」「第一个可见帧已包含」）按结构认：
 *    场景只在「场景：画风；地点，时段，光线；」的地点段里认（别处顺带提到的地名不算），
 *    角色 / 道具只认「第一个可见帧已包含 …」那句里列出的（画面里真有的）；
 *    不是这种格式的，全文找；
 * 4. 长名字先匹配：「老周办公室」里的「老周」不再单独算；少于 2 个字的名字不匹配；
 * 5. 设定有多张图时，提示词里出现了哪张图的备注（如「傍晚」）就用哪张。
 */
export function matchSettings(prompt: string, settings: Character[]): SettingMatch[] {
  // 台词、已插入的 @标记 用同长度空白盖住，位置不变
  const masked = prompt.replace(/"[^"]*"|“[^”]*”|「[^」]*」|（@[^）]*）|@(图|视频|音频)\d+/g, (m) => ' '.repeat(m.length));
  // —— 结构化区域 ——
  let sceneZone: [number, number] | null = null; // 「场景：画风；【地点段】；…」
  const sm = /场景：[^；;\n]*[；;]([^；;\n]*)/.exec(masked);
  if (sm) {
    const start = sm.index + sm[0].length - sm[1].length;
    sceneZone = [start, start + sm[1].length];
  }
  let frameZone: [number, number] | null = null; // 「第一个可见帧已包含 …。」
  const fm = /第一个可见帧已(?:经)?包含([^。\n]*)/.exec(masked);
  if (fm) frameZone = [fm.index, fm.index + fm[0].length];
  const inZone = (z: [number, number] | null, a: number, b: number) => !z || (a >= z[0] && b <= z[1]);

  const covered: [number, number][] = [];
  const inCovered = (a: number, b: number) => covered.some(([x, y]) => a < y && b > x);
  const out: SettingMatch[] = [];
  const sorted = settings.filter((c) => c.name && c.name.trim().length >= 2).sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const name = c.name.trim();
    const isScene = settingKind(c) === 'scene';
    // 场景按地点段认；角色 / 道具按首帧声明认；没有对应结构就全文
    const zone = isScene ? sceneZone : frameZone;
    let first = -1;
    let inside = false;
    for (let i = masked.indexOf(name); i >= 0; i = masked.indexOf(name, i + 1)) {
      const end = i + name.length;
      if (inCovered(i, end)) continue;
      covered.push([i, end]);
      if (masked.startsWith('（画外', end)) continue;
      if (inZone(zone, i, end)) inside = true;
      // 标记插在第一次出现的地方（场景插在地点段里）
      if (first < 0 && (!isScene || inZone(zone, i, end))) first = i;
    }
    if (!inside || first < 0) continue;
    const imgs = settingImages(c);
    const noted = imgs.filter((im) => im.note && masked.includes(im.note)).sort((a, b) => (b.note || '').length - (a.note || '').length);
    out.push({ setting: c, image: noted[0] || imgs[0], index: first });
  }
  return out.sort((a, b) => a.index - b.index);
}
