// Anthropic 官方（Claude）：只有文本。画布里的文本节点、对话框都能用。
//   对话  POST {base}/messages（x-api-key + anthropic-version 头）
//   模型  GET  {base}/models
import type { Adapter } from './types.js';
import { AdapterError, httpJson, joinUrl } from './types.js';
import { anthropicChat, anthropicHeaders } from './chatStream.js';

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1';

const baseOf = (p: { baseUrl: string }) => p.baseUrl || ANTHROPIC_DEFAULT_BASE;

export const anthropicAdapter: Adapter = {
  type: 'anthropic',
  label: 'Anthropic 官方',
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE,

  async test(ctx) {
    const list = await this.listModels!(ctx);
    return list.length ? `连接成功，这个 key 能用 ${list.length} 个模型` : '连接成功';
  },

  async listModels(ctx) {
    const data = await httpJson<any>(joinUrl(baseOf(ctx.provider), 'models?limit=100'), { headers: anthropicHeaders(ctx.apiKey), timeoutMs: 20_000 });
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    return list.map((m) => String(m?.id ?? '')).filter(Boolean);
  },

  async submit(ctx, req) {
    if (req.capability !== 'text') throw new AdapterError('Anthropic 只能用来写文本（剧本、分镜、提示词），不能生图 / 生视频');
    const r = await anthropicChat(
      baseOf(ctx.provider),
      ctx.apiKey,
      ctx.model.remoteModel,
      { system: '', turns: [{ role: 'user', text: req.prompt, images: req.refs.filter((x) => x.kind === 'image').map((x) => x.file) }] },
      () => undefined,
      AbortSignal.timeout(300_000),
    );
    return { kind: 'done', outputs: [{ kind: 'text', text: r.text }] };
  },
};
