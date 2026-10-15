// 中转站适配器：一个地址 + 一个 key 调多家模型。
// 各家中转站接口不完全一样，所以每个模型单独选「接口格式」：
//   openai-chat    文本，POST {base}/chat/completions
//   openai-images  生图，POST {base}/images/generations；有参考图时走 {base}/images/edits
//   ark-image / ark-video  中转站原样转发火山方舟格式时，直接复用火山适配器的代码
//   custom         自定义模板：填好提交地址、请求体、查询地址、各字段在哪，不写代码接新模型
// 注意（来自 jewelry-image-studio 的经验）：像 4sapi 这类网关按 key 分组，不同分组能用的模型不同，
// 所以同一家中转站可以添加成多个服务商，各填各的 key。
import fs from 'node:fs/promises';
import path from 'node:path';
import { absFromRel, mimeOf } from '../storage.js';
import type { Adapter, AdapterContext, PollResult, PreparedRequest, SubmitResult } from './types.js';
import { AdapterError, httpJson, joinUrl } from './types.js';
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

async function openaiImages(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult> {
  const n = Math.max(1, Math.min(4, Number(req.params.count) || 1));
  const imgs = req.mode === 't2i' ? [] : req.refs.filter((r) => r.kind === 'image');
  let data: any;
  if (imgs.length) {
    const form = new FormData();
    form.append('model', ctx.model.remoteModel);
    form.append('prompt', req.prompt);
    form.append('n', String(n));
    if (req.params.size && req.params.size !== 'auto') form.append('size', String(req.params.size));
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
    if (req.params.size && req.params.size !== 'auto') body.size = req.params.size;
    if (req.params.quality && req.params.quality !== 'auto') body.quality = req.params.quality;
    data = await httpJson<any>(joinUrl(base(ctx), 'images/generations'), { headers: headers(ctx), body, timeoutMs: 300_000 });
  }
  const outputs = (Array.isArray(data?.data) ? data.data : [])
    .filter((d: any) => d?.url || d?.b64_json)
    .map((d: any) => ({ kind: 'image' as const, url: d.url, base64: d.b64_json, mime: 'image/png' }));
  if (!outputs.length) throw new AdapterError(`中转站没有返回图片：${JSON.stringify(data).slice(0, 300)}`);
  return { kind: 'done', outputs };
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
    const data = await httpJson<any>(joinUrl(base(ctx), 'models'), { headers: headers(ctx), timeoutMs: 20_000 }).catch((e: any) => {
      if (/HTTP 40[13]/.test(String(e?.message))) throw new AdapterError(`key 无效或没有权限：${e.message}`);
      throw e;
    });
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    return list.length ? `连接成功，这个 key 能看到 ${list.length} 个模型` : '连接成功';
  },

  async submit(ctx, req) {
    switch (ctx.model.protocol) {
      case 'openai-chat':
        return openaiChat(ctx, req);
      case 'openai-images':
        return openaiImages(ctx, req);
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
    if (ctx.model.protocol === 'custom') return customPoll(ctx, remoteId);
    return { status: 'failed', error: '这个接口格式不需要查询' };
  },

  refLabel(kind, n, model) {
    if (model.protocol === 'ark-image' || model.protocol === 'ark-video') return `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}${n}`;
    return `${kind} ${n}`;
  },
};
