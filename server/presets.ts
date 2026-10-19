// 参数预设：一个模型「有哪些生成模式、有哪些参数」。
// 界面按这里自动画出模式下拉框和参数表单，接新模型时选一个预设即可，不用写界面。
import type { ModeDef, ParamDef } from '../shared/types.js';

export interface Preset {
  label: string;
  modes: ModeDef[];
  params: ParamDef[];
}

const RATIOS_VIDEO = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const RATIOS_IMAGE = ['16:9', '9:16', '1:1', '4:3', '3:4'];

const seedAdvanced: ParamDef = { key: 'seed', label: '种子（-1 = 随机）', type: 'number', default: -1, min: -1, max: 2147483647, step: 1, advanced: true };
const watermark: ParamDef = { key: 'watermark', label: '加水印', type: 'boolean', default: false, advanced: true };

const textModes: ModeDef[] = [{ id: 'chat', label: '对话', maxRefs: { image: 4 } }];

const videoModes: ModeDef[] = [
  { id: 't2v', label: '文生视频', maxRefs: {} },
  { id: 'flf', label: '首尾帧', maxRefs: { image: 2 }, imageRoles: ['first_frame', 'last_frame'] },
  { id: 'omni', label: '全能参考', maxRefs: { image: 9, video: 3, audio: 3 }, imageRoles: ['reference'] },
];

const imageModes: ModeDef[] = [
  { id: 't2i', label: '文生图', maxRefs: {} },
  { id: 'i2i', label: '参考图生图', maxRefs: { image: 10 }, imageRoles: ['reference'] },
];

export const PRESETS: Record<string, Preset> = {
  // —— 文本 ——
  chat: {
    label: '文本对话',
    modes: textModes,
    params: [{ key: 'temperature', label: '发散程度', type: 'number', default: 0.7, min: 0, max: 2, step: 0.1, advanced: true }],
  },

  // —— 图片：火山方舟 Seedream ——
  seedream: {
    label: 'Seedream 生图',
    modes: imageModes,
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: RATIOS_IMAGE, default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'select', options: ['2K', '4K'], default: '2K' },
      { key: 'count', label: '张数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '张' },
      seedAdvanced,
      watermark,
    ],
  },

  // —— 视频：火山方舟 Seedance ——
  seedance: {
    label: 'Seedance 生视频',
    modes: videoModes,
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: [...RATIOS_VIDEO, 'adaptive'], default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'select', options: ['480p', '720p', '1080p'], default: '720p' },
      // Seedance 2.0 支持 4～15 秒任意整数秒
      { key: 'duration', label: '时长', type: 'select', options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 5, unit: 's' },
      { key: 'count', label: '条数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '个' },
      { key: 'generate_audio', label: '生成声音', type: 'boolean', default: true },
      seedAdvanced,
      watermark,
    ],
  },

  // —— 图片：OpenAI 格式（中转站常见） ——
  'openai-images': {
    label: 'OpenAI 格式生图',
    modes: imageModes,
    params: [
      // 比例 + 清晰度，实际像素见 openaiImageSize。
      // OpenAI 官方只认 1K 的 1:1 / 3:2 / 2:3；其余比例和 2K / 4K 要中转站支持（如 AI派，单边最大 4096），不支持会报错
      { key: 'ratio', label: '比例', type: 'select', options: [...RATIOS_IMAGE, '3:2', '2:3'], default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'select', options: ['1K', '2K', '4K'], default: '1K' },
      { key: 'count', label: '张数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '张' },
      { key: 'quality', label: '质量', type: 'select', options: ['auto', 'high', 'medium', 'low'], default: 'auto', advanced: true },
    ],
  },

  // —— 视频：OpenAI 风格统一视频接口 /v1/videos（New API 类中转站：MiniMax、Seedance、Wan……） ——
  // 不放「清晰度」：这类接口多数按模型名区分画质（如 minimax-h3-768p），要的话在模型名里选
  'openai-videos': {
    label: 'OpenAI 视频（/v1/videos）',
    modes: [
      { id: 't2v', label: '文生视频', maxRefs: {} },
      { id: 'omni', label: '参考生视频', maxRefs: { image: 9, video: 3, audio: 3 }, imageRoles: ['reference'] },
    ],
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: RATIOS_VIDEO, default: '16:9' },
      { key: 'duration', label: '时长', type: 'select', options: [5, 6, 8, 10, 12, 15], default: 5, unit: 's' },
      { key: 'count', label: '条数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '个' },
      { key: 'generate_audio', label: '生成声音', type: 'boolean', default: false },
    ],
  },

  // —— 视频：通用（自定义模板用） ——
  'generic-video': {
    label: '通用视频',
    modes: videoModes,
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: RATIOS_VIDEO, default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'select', options: ['480p', '720p', '1080p'], default: '720p' },
      { key: 'duration', label: '时长', type: 'select', options: [5, 10], default: 5, unit: 's' },
      { key: 'count', label: '条数', type: 'select', options: [1, 2], default: 1, unit: '个' },
    ],
  },

  // —— 音频：文字转语音（自定义模板接配音模型时用） ——
  tts: {
    label: '文字转语音',
    modes: [{ id: 'tts', label: '文字转语音', maxRefs: { audio: 1 } }],
    params: [{ key: 'voice', label: '音色', type: 'text', default: '' }],
  },
};

export function getPreset(name: string): Preset {
  return PRESETS[name] || { label: name, modes: [{ id: 'default', label: '默认', maxRefs: { image: 4 } }], params: [] };
}

/** 比例 + 清晰度 → Seedream 要的像素尺寸 */
/** OpenAI 格式生图：比例 + 清晰度 → 宽x高（都取 16 的倍数，长边 1K=1536 / 2K=2048 / 4K=3840，正方形 1024 / 2048 / 4096） */
export function openaiImageSize(ratio: string, resolution: string): string {
  const [rw, rh] = ratio.split(':').map(Number);
  if (!rw || !rh) return '1024x1024';
  const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  if (rw === rh) {
    const side = { '1K': 1024, '2K': 2048, '4K': 4096 }[resolution] || 1024;
    return `${side}x${side}`;
  }
  const long = { '1K': 1536, '2K': 2048, '4K': 3840 }[resolution] || 1536;
  const short = r16((long * Math.min(rw, rh)) / Math.max(rw, rh));
  return rw > rh ? `${long}x${short}` : `${short}x${long}`;
}

export function seedreamSize(ratio: string, resolution: string): string {
  const k2: Record<string, string> = {
    '1:1': '2048x2048',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
  };
  const k4: Record<string, string> = {
    '1:1': '4096x4096',
    '16:9': '4096x2304',
    '9:16': '2304x4096',
    '4:3': '4096x3072',
    '3:4': '3072x4096',
  };
  return (resolution === '4K' ? k4 : k2)[ratio] || '2048x2048';
}
