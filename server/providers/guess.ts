// 从服务商拉到的模型 ID，按名字猜它是干什么的、该用哪种接口格式。
// 只是给个默认值，猜错了在模型表格里改就行。
import type { RemoteModelGuess } from '../../shared/types.js';

const has = (id: string, re: RegExp) => re.test(id);

export function guessModel(remoteModel: string): RemoteModelGuess {
  const id = remoteModel.toLowerCase();
  const base = { remoteModel };

  // 这些不是生成用的模型（向量、审核、语音识别、语音合成），界面里接不了
  if (has(id, /embed|rerank|moderation|whisper|transcri|tts|speech|audio/)) {
    return { ...base, capability: 'text', preset: 'chat', supported: false, note: '向量 / 审核 / 语音类模型，这里用不上' };
  }

  // —— 视频 ——
  if (has(id, /seedance/)) return { ...base, capability: 'video', protocol: 'ark-video', preset: 'seedance', supported: true };
  if (has(id, /video|veo|sora|kling|hailuo|minimax-h|vidu|runway|pika|happyhorse|^wan-|wan.*(t2v|i2v)|t2v|i2v/)) {
    return { ...base, capability: 'video', protocol: 'openai-videos', preset: 'openai-videos', supported: true };
  }

  // —— 图片 ——
  if (has(id, /seedream/)) return { ...base, capability: 'image', protocol: 'ark-image', preset: 'seedream', supported: true };
  if (has(id, /gpt-image|dall-e|flux|imagen|midjourney|^mj|stable-diffusion|sdxl|kolors|qwen-image|image-gen|-image|image-/)) {
    return { ...base, capability: 'image', protocol: 'openai-images', preset: 'openai-images', supported: true };
  }

  // —— 其余都当文本对话（DeepSeek、Claude、GPT、通义、Kimi……） ——
  return { ...base, capability: 'text', protocol: 'openai-chat', preset: 'chat', supported: true };
}
