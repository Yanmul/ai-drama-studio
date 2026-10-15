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
      { key: 'duration', label: '时长', type: 'select', options: [4, 5, 6, 8, 10, 12, 15], default: 5, unit: 's' },
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
      { key: 'size', label: '尺寸', type: 'select', options: ['1536x1024', '1024x1536', '1024x1024', 'auto'], default: '1536x1024' },
      { key: 'count', label: '张数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '张' },
      { key: 'quality', label: '质量', type: 'select', options: ['auto', 'high', 'medium', 'low'], default: 'auto', advanced: true },
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

  // —— 演示模型（不联网、不花钱，用来试界面） ——
  'mock-image': {
    label: '演示生图',
    modes: imageModes,
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: RATIOS_IMAGE, default: '16:9' },
      { key: 'count', label: '张数', type: 'select', options: [1, 2, 3, 4], default: 1, unit: '张' },
      seedAdvanced,
    ],
  },
  'mock-video': {
    label: '演示生视频',
    modes: videoModes,
    params: [
      { key: 'ratio', label: '比例', type: 'select', options: RATIOS_VIDEO, default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'select', options: ['480p', '720p', '1080p'], default: '720p' },
      { key: 'duration', label: '时长', type: 'select', options: [5, 10], default: 5, unit: 's' },
      { key: 'count', label: '条数', type: 'select', options: [1, 2], default: 1, unit: '个' },
      { key: 'generate_audio', label: '生成声音', type: 'boolean', default: true },
    ],
  },
  'mock-audio': {
    label: '演示配音',
    modes: [{ id: 'tts', label: '文字转语音', maxRefs: { audio: 1 } }],
    params: [{ key: 'voice', label: '音色', type: 'select', options: ['少年', '中年男', '中年女'], default: '少年' }],
  },
};

export function getPreset(name: string): Preset {
  return PRESETS[name] || { label: name, modes: [{ id: 'default', label: '默认', maxRefs: { image: 4 } }], params: [] };
}

/** 比例 + 清晰度 → Seedream 要的像素尺寸 */
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
