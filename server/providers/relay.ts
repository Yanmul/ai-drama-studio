// 中转站适配器：一个地址 + 一个 key 调多家模型。
// 各家中转站接口不完全一样，所以每个模型单独选「接口格式」：
//   openai-chat    文本，POST {base}/chat/completions
//   openai-images  生图，POST {base}/images/generations；有参考图时走 {base}/images/edits
//   openai-videos  视频，OpenAI 风格统一视频接口：POST {base}/videos 提交，GET {base}/videos/{id} 查询，
//                  GET {base}/videos/{id}/content 下载（要带 key）。New API 类中转站（如 AI派）的视频模型都走这个
//   ark-image / ark-video  中转站原样转发火山方舟格式时，直接复用火山适配器的代码
//   custom         自定义模板：填好提交地址、请求体、查询地址、各字段在哪，不写代码接新模型
// 注意（来自 jewelry-image-studio 的经验）：像 4sapi 这类网关按 key 分组，不同分组能用的模型不同，
// 所以同一家中转站可以添加成多个服务商，各填各的 key。
import fs from 'node:fs/promises';
import path from 'node:path';
import { absFromRel, mimeOf } from '../storage.js';
import { openaiImageSize } from '../presets.js';
import type { Adapter, AdapterContext, PollResult, PreparedRequest, SubmitResult } from './types.js';
import { AdapterError, explainVendorError, httpJson, joinUrl } from './types.js';
import { arkImage, arkVideoPoll, arkVideoSubmit, refUrl } from './volcengine.js';

function headers(ctx: { apiKey: string }) {
  if (!ctx.apiKey) throw new AdapterError('还没有填 API key：去「模型管理」里填写');
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

function base(ctx: { provider: { baseUrl: string } }) {
  if (!ctx.provider.baseUrl) throw new AdapterError('还没有填中转站地址：去「模型管理」里填写');
  return ctx.provider.baseUrl;
}

/** 取 a.b.0.c 这种路径上的值 */
export function getPath(obj: any, p: string): any {
  if (!p) return obj;
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

/** 把模板里的 {{…}} 换成实际值。整个值就是占位符时保留原类型（数字、数组）。 */
function fill(node: any, vars: Record<string, any>): any {
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return getPath(vars, whole[1]);
    return node.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = getPath(vars, k);
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((x) => fill(x, vars)).filter((x) => x !== undefined && x !== '');
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      const fv = fill(v, vars);
      if (fv !== undefined) out[k] = fv;
    }
    return out;
  }
  return node;
}

async function openaiChat(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const parts: any[] = [{ type: 'text', text: req.prompt }];
  for (const r of req.refs.filter((x) => x.kind === 'image')) parts.push({ type: 'image_url', image_url: { url: await refUrl(ctx, r) } });
  const data = await httpJson<any>(joinUrl(base(ctx), 'chat/completions'), {
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

/** 尺寸：新的「比例 + 清晰度」优先；老节点只有 size 的照旧 */
function imageSize(p: PreparedRequest['params']): string | undefined {
  if (p.ratio || p.resolution) return openaiImageSize(String(p.ratio || '1:1'), String(p.resolution || '1K'));
  return p.size && p.size !== 'auto' ? String(p.size) : undefined;
}

async function openaiImages(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const n = Math.max(1, Math.min(4, Number(req.params.count) || 1));
  const size = imageSize(req.params);
  const imgs = req.mode === 't2i' ? [] : req.refs.filter((r) => r.kind === 'image');
  let data: any;
  if (imgs.length) {
    const form = new FormData();
    form.append('model', ctx.model.remoteModel);
    form.append('prompt', req.prompt);
    form.append('n', String(n));
    if (size) form.append('size', size);
    if (req.params.quality && req.params.quality !== 'auto') form.append('quality', String(req.params.quality));
    for (const r of imgs) {
      if (r.file.endsWith('.svg')) throw new AdapterError('参考图是演示用的 SVG 示意图，真实模型不认，请换成真实图片');
      const abs = absFromRel(r.file);
      const buf = await fs.readFile(abs);
      form.append('image[]', new Blob([buf], { type: mimeOf(abs) }), path.basename(abs));
    }
    data = await httpJson<any>(joinUrl(base(ctx), 'images/edits'), { headers: headers(ctx), form, timeoutMs: 300_000 });
  } else {
    const body: Record<string, unknown> = { model: ctx.model.remoteModel, prompt: req.prompt, n };
    if (size) body.size = size;
    if (req.params.quality && req.params.quality !== 'auto') body.quality = req.params.quality;
    data = await httpJson<any>(joinUrl(base(ctx), 'images/generations'), { headers: headers(ctx), body, timeoutMs: 300_000 });
  }
  const outputs = (Array.isArray(data?.data) ? data.data : [])
    .filter((d: any) => d?.url || d?.b64_json)
    .map((d: any) => ({ kind: 'image' as const, url: d.url, base64: d.b64_json, mime: 'image/png' }));
  if (!outputs.length) throw new AdapterError(`中转站没有返回图片：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'done', outputs };
}

// —— OpenAI 风格统一视频接口 /v1/videos ——
const REF_ROLE = { image: 'reference_image', video: 'reference_video', audio: 'reference_audio' } as const;
const URL_KEY = { image: 'image_url', video: 'video_url', audio: 'audio_url' } as const;

/** 有的模型按名字固定画质，要求 resolution 跟模型名对上（AI派文档：minimax-h3 = 1440p，minimax-h3-768p = 768p） */
function resolutionOf(model: string, params: PreparedRequest['params']): string | undefined {
  if (params.resolution) return String(params.resolution);
  const m = model.toLowerCase().match(/-(\d{3,4}p)$/);
  if (m) return m[1];
  if (/^minimax-h3$/i.test(model)) return '1440p';
  return undefined;
}

async function openaiVideosSubmit(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const p = req.params;
  const model = ctx.model.remoteModel;
  const duration = Number(p.duration) || 5;
  const ratio = String(p.ratio || '16:9');
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    duration,
    seconds: String(duration), // 兼容按 OpenAI 原版字段收时长的模型
    aspect_ratio: ratio,
    ratio, // 有的模型（Seedance）认 ratio
  };
  const resolution = resolutionOf(model, p);
  if (resolution) body.resolution = resolution;
  if (p.generate_audio !== undefined) body.generate_audio = Boolean(p.generate_audio);
  if (p.seed !== undefined && Number(p.seed) >= 0) body.seed = Number(p.seed);
  // 参考素材放在顶层 content 数组里，每项一个唯一 name；提示词里的 @图1 已经换成同名的 image_1
  const refs = req.mode === 't2v' ? [] : req.refs;
  if (refs.length) {
    const count = { image: 0, video: 0, audio: 0 };
    const content: any[] = [{ type: 'text', text: req.prompt }];
    for (const r of refs) {
      count[r.kind] += 1;
      const key = URL_KEY[r.kind];
      content.push({ type: key, [key]: { url: await refUrl(ctx, r) }, role: REF_ROLE[r.kind], name: `${r.kind}_${count[r.kind]}` });
    }
    body.content = content;
    // Seedance 的全能参考要额外声明模式（AI派文档）
    if (/seedance/i.test(model)) {
      body.mode = 'reference_material';
      body.function_mode = 'omni_reference';
    }
  }
  const data = await httpJson<any>(joinUrl(base(ctx), 'videos'), { headers: headers(ctx), body, timeoutMs: 120_000 });
  const id = data?.id ?? data?.data?.id ?? (typeof data?.data === 'string' ? data.data : undefined) ?? data?.task_id;
  if (!id) throw new AdapterError(`中转站没有返回任务号：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'pending', remoteId: String(id) };
}

async function openaiVideosPoll(ctx: AdapterContext, remoteId: string): Promise<PollResult> {
  const url = joinUrl(base(ctx), `videos/${encodeURIComponent(remoteId)}`);
  const data = await httpJson<any>(url, { headers: headers(ctx), timeoutMs: 30_000 });
  const d = data?.data && typeof data.data === 'object' ? data.data : {};
  const status = String(data?.status ?? d.status ?? '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(status)) {
    // 结果统一从 /content 下载，要带 key
    return { status: 'succeeded', outputs: [{ kind: 'video', url: `${url}/content`, mime: 'video/mp4', headers: { ...headers(ctx), Accept: 'video/mp4' } }] };
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) {
    const e = data?.error ?? d.error;
    const msg = typeof e === 'string' ? e : e?.message ? `${e.code ? e.code + ' ' : ''}${e.message}` : `任务状态 ${status}`;
    return { status: 'failed', error: explainVendorError(msg) };
  }
  const progress = data?.progress ?? d.progress;
  return { status: 'running', note: `中转站${status === 'queued' ? '排队中' : '生成中'}${progress != null && progress !== '' ? ` ${progress}%` : ''}` };
}

async function customSubmit(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const t = ctx.model.custom;
  if (!t) throw new AdapterError('这个模型选了「自定义模板」，但还没有填模板');
  let tpl: any;
  try {
    tpl = JSON.parse(t.submitBody || '{}');
  } catch {
    throw new AdapterError('自定义模板的请求体不是合法的 JSON');
  }
  const images = await Promise.all(req.refs.filter((r) => r.kind === 'image').map((r) => refUrl(ctx, r)));
  const vars: Record<string, any> = { model: ctx.model.remoteModel, prompt: req.prompt, mode: req.mode, images, params: req.params };
  images.forEach((u, i) => (vars[`image_${i + 1}`] = u));
  const first = req.refs.find((r) => r.role === 'first_frame');
  const last = req.refs.find((r) => r.role === 'last_frame');
  if (first) vars.first_frame = await refUrl(ctx, first);
  if (last) vars.last_frame = await refUrl(ctx, last);
  const data = await httpJson<any>(joinUrl(base(ctx), fill(t.submitPath, vars)), { headers: headers(ctx), body: fill(tpl, vars) });
  // 有的接口直接同步返回结果
  const direct = getPath(data, t.resultUrlPath);
  if (direct) return { kind: 'done', outputs: [{ kind: t.resultKind, url: String(direct) }] };
  const id = getPath(data, t.taskIdPath);
  if (!id) throw new AdapterError(`按模板没找到任务号（${t.taskIdPath}）：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'pending', remoteId: String(id) };
}

async function customPoll(ctx: AdapterContext, remoteId: string): Promise<PollResult> {
  const t = ctx.model.custom!;
  const data = await httpJson<any>(joinUrl(base(ctx), fill(t.pollPath, { taskId: remoteId })), { headers: headers(ctx), timeoutMs: 30_000 });
  const status = String(getPath(data, t.statusPath) ?? '').toLowerCase();
  if (t.successValues.map((s) => s.toLowerCase()).includes(status)) {
    const url = getPath(data, t.resultUrlPath);
    if (!url) return { status: 'failed', error: `任务成功，但按模板没找到结果链接（${t.resultUrlPath}）` };
    return { status: 'succeeded', outputs: [{ kind: t.resultKind, url: String(url) }] };
  }
  if (t.failValues.map((s) => s.toLowerCase()).includes(status)) {
    const err = t.errorPath ? getPath(data, t.errorPath) : undefined;
    return { status: 'failed', error: String(err || `任务状态 ${status}`) };
  }
  return { status: 'running', note: status ? `中转站状态：${status}` : '中转站处理中' };
}

export const relayAdapter: Adapter = {
  type: 'relay',
  label: '中转站',
  defaultBaseUrl: '',

  async test(ctx) {
    const list = await this.listModels!(ctx);
    return list.length ? `连接成功，这个 key 能看到 ${list.length} 个模型` : '连接成功';
  },

  async listModels(ctx) {
    // 401 / 403 的中文说明 httpJson 里已经加了
    const data = await httpJson<any>(joinUrl(base(ctx), 'models'), { headers: headers(ctx), timeoutMs: 20_000 });
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    return [...new Set(list.map((m) => String(m?.id ?? '')).filter(Boolean))].sort();
  },

  async submit(ctx, req) {
    switch (ctx.model.protocol) {
      case 'openai-chat':
        return openaiChat(ctx, req);
      case 'openai-images':
        return openaiImages(ctx, req);
      case 'openai-videos':
        return openaiVideosSubmit(ctx, req);
      case 'ark-image':
        return arkImage(base(ctx), ctx, req);
      case 'ark-video':
        return arkVideoSubmit(base(ctx), ctx, req);
      case 'custom':
        return customSubmit(ctx, req);
      default:
        throw new AdapterError(`没有选接口格式（模型：${ctx.model.name}）`);
    }
  },

  async poll(ctx, remoteId) {
    if (ctx.model.protocol === 'ark-video') return arkVideoPoll(base(ctx), ctx, remoteId);
    if (ctx.model.protocol === 'openai-videos') return openaiVideosPoll(ctx, remoteId);
    if (ctx.model.protocol === 'custom') return customPoll(ctx, remoteId);
    return { status: 'failed', error: '这个接口格式不需要查询' };
  },

  refLabel(kind, n, model) {
    if (model.protocol === 'ark-image' || model.protocol === 'ark-video') return `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}${n}`;
    if (model.protocol === 'openai-videos') return `${kind}_${n}`; // 和 content 里每项的 name 对上
    return `${kind} ${n}`;
  },
};
