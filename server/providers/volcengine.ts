// 火山引擎（方舟）适配器：用你自己的 key 直连，不经过任何中转。
// 接口（方舟原生格式，与 jewelry-image-studio/backend/app/providers/video_seedance.py 一致）：
//   生图  POST {base}/images/generations                      同步返回 data[].url
//   生视频 POST {base}/contents/generations/tasks             返回 {id}
//         GET  {base}/contents/generations/tasks/{id}        queued / running / succeeded / failed / cancelled / expired
//         成功时 content.video_url 是 24 小时有效的签名链接，队列会立刻下载到本地
//   文本  POST {base}/chat/completions                        OpenAI 兼容
// 提示词里按顺序用「图片1」「图片2」指代参考图。
import { fileToDataUrl } from '../storage.js';
import { seedreamSize } from '../presets.js';
import type { Adapter, AdapterContext, PollResult, PreparedRequest, SubmitResult } from './types.js';
import { AdapterError, httpJson, joinUrl } from './types.js';
import type { RefInput } from '../../shared/types.js';

export const ARK_DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

function headers(ctx: { apiKey: string }) {
  if (!ctx.apiKey) throw new AdapterError('还没有填 API key：去「模型管理」里填写');
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

/** 参考素材交给厂商的地址：默认 base64；配置了公网地址就用公网链接 */
export async function refUrl(ctx: Pick<AdapterContext, 'provider'>, ref: RefInput): Promise<string> {
  if (ctx.provider.refMode === 'public' && ctx.provider.publicBaseUrl) {
    return joinUrl(ctx.provider.publicBaseUrl, `files/${ref.file.split('/').map(encodeURIComponent).join('/')}`);
  }
  if (ref.file.endsWith('.svg')) throw new AdapterError('参考图是演示用的 SVG 示意图，真实模型不认，请换成真实图片');
  return fileToDataUrl(ref.file);
}

export async function arkImage(base: string, ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const p = req.params;
  const count = Math.max(1, Math.min(4, Number(p.count) || 1));
  const images = req.mode === 't2i' ? [] : await Promise.all(req.refs.filter((r) => r.kind === 'image').map((r) => refUrl(ctx, r)));
  const body: Record<string, unknown> = {
    model: ctx.model.remoteModel,
    prompt: req.prompt,
    size: seedreamSize(String(p.ratio || '16:9'), String(p.resolution || '2K')),
    response_format: 'url',
    watermark: Boolean(p.watermark),
  };
  if (images.length) body.image = images;
  if (Number(p.seed) >= 0) body.seed = Number(p.seed);
  if (count > 1) {
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = { max_images: count };
  } else {
    body.sequential_image_generation = 'disabled';
  }
  const data = await httpJson<any>(joinUrl(base, 'images/generations'), { headers: headers(ctx), body, timeoutMs: 180_000 });
  const items: any[] = Array.isArray(data?.data) ? data.data : [];
  const outputs = items
    .filter((d) => d?.url || d?.b64_json)
    .map((d) => ({ kind: 'image' as const, url: d.url, base64: d.b64_json, mime: 'image/jpeg' }));
  if (!outputs.length) throw new AdapterError(`方舟没有返回图片：${JSON.stringify(data?.error || data).slice(0, 300)}`);
  return { kind: 'done', outputs };
}

export async function arkVideoSubmit(base: string, ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const p = req.params;
  const content: any[] = [{ type: 'text', text: req.prompt }];
  if (req.mode !== 't2v') {
    for (const r of req.refs) {
      const url = await refUrl(ctx, r);
      if (r.kind === 'image') {
        const role = req.mode === 'flf' ? (r.role === 'last_frame' ? 'last_frame' : 'first_frame') : 'reference_image';
        content.push({ type: 'image_url', image_url: { url }, role });
      } else if (r.kind === 'video') {
        content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
      } else if (r.kind === 'audio') {
        content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: ctx.model.remoteModel,
    content,
    ratio: p.ratio || '16:9',
    duration: Number(p.duration) || 5,
    generate_audio: p.generate_audio !== false,
    watermark: Boolean(p.watermark),
  };
  if (p.resolution) body.resolution = p.resolution;
  if (Number(p.seed) >= 0) body.seed = Number(p.seed);
  const data = await httpJson<any>(joinUrl(base, 'contents/generations/tasks'), { headers: headers(ctx), body, timeoutMs: 120_000 });
  if (!data?.id) throw new AdapterError(`方舟没有返回任务号：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'pending', remoteId: String(data.id) };
}

export async function arkVideoPoll(base: string, ctx: AdapterContext, remoteId: string): Promise<PollResult> {
  const t = await httpJson<any>(joinUrl(base, `contents/generations/tasks/${encodeURIComponent(remoteId)}`), {
    headers: headers(ctx),
    timeoutMs: 30_000,
  });
  const s = String(t?.status || '').toLowerCase();
  if (s === 'succeeded') {
    const url = t?.content?.video_url;
    if (!url) return { status: 'failed', error: '任务成功了，但没有返回视频链接' };
    return { status: 'succeeded', outputs: [{ kind: 'video', url, mime: 'video/mp4' }] };
  }
  if (s === 'failed' || s === 'cancelled' || s === 'expired') {
    const e = t?.error;
    const msg = (e && (e.message || e.code)) || `任务状态 ${s}`;
    return { status: 'failed', error: s === 'expired' ? `任务过期：${msg}` : String(msg) };
  }
  return { status: 'running', note: s === 'queued' ? '方舟排队中' : '方舟生成中' };
}

export async function arkChat(base: string, ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const parts: any[] = [{ type: 'text', text: req.prompt }];
  for (const r of req.refs.filter((x) => x.kind === 'image')) parts.push({ type: 'image_url', image_url: { url: await refUrl(ctx, r) } });
  const data = await httpJson<any>(joinUrl(base, 'chat/completions'), {
    headers: headers(ctx),
    body: {
      model: ctx.model.remoteModel,
      messages: [{ role: 'user', content: parts.length === 1 ? req.prompt : parts }],
      temperature: Number(req.params.temperature ?? 0.7),
    },
  });
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new AdapterError(`没有返回文本：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'done', outputs: [{ kind: 'text', text }] };
}

export const volcengineAdapter: Adapter = {
  type: 'volcengine',
  label: '火山引擎（方舟）',
  defaultBaseUrl: ARK_DEFAULT_BASE,

  async test(ctx) {
    const base = ctx.provider.baseUrl || ARK_DEFAULT_BASE;
    try {
      await httpJson(joinUrl(base, 'contents/generations/tasks?page_num=1&page_size=1'), { headers: headers(ctx), timeoutMs: 20_000 });
      return '连接成功，key 有效';
    } catch (e: any) {
      const m = String(e?.message || e);
      if (/HTTP 40[13]/.test(m)) throw new AdapterError(`key 无效或没有权限：${m}`);
      throw e;
    }
  },

  async submit(ctx, req) {
    const base = ctx.provider.baseUrl || ARK_DEFAULT_BASE;
    if (req.capability === 'image') return arkImage(base, ctx, req);
    if (req.capability === 'video') return arkVideoSubmit(base, ctx, req);
    if (req.capability === 'text') return arkChat(base, ctx, req);
    throw new AdapterError('火山引擎适配器暂不支持音频');
  },

  async poll(ctx, remoteId) {
    return arkVideoPoll(ctx.provider.baseUrl || ARK_DEFAULT_BASE, ctx, remoteId);
  },

  async cancel(ctx, remoteId) {
    const base = ctx.provider.baseUrl || ARK_DEFAULT_BASE;
    // 方舟只能取消还在排队的任务，取消不了也没关系，队列会停止查询
    await httpJson(joinUrl(base, `contents/generations/tasks/${encodeURIComponent(remoteId)}`), {
      method: 'DELETE',
      headers: headers(ctx),
      timeoutMs: 20_000,
    }).catch(() => undefined);
  },

  refLabel(kind, n) {
    return `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}${n}`;
  },
};
