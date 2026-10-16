// 对话框用的多轮、流式对话：边生成边把文字推给前端。
// 两种格式：Anthropic 官方 Messages 接口；OpenAI 兼容的 /chat/completions（火山方舟、中转站都是这种）。
import fsp from 'node:fs/promises';
import { absFromRel, mimeOf } from '../storage.js';
import { AdapterError, errorText, explainVendorError, joinUrl } from './types.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** 工作文件夹里的相对路径 */
  images?: string[];
}

export interface ChatRequest {
  system: string;
  turns: ChatTurn[];
  maxTokens?: number;
}

export interface ChatResult {
  text: string;
  /** 回复因为长度上限被截断 */
  truncated?: boolean;
}

type OnDelta = (text: string) => void;

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    const code = e?.cause?.code;
    throw new AdapterError(`连不上服务商：检查网络、代理和接口地址。原始信息：${code || e?.message || e}`, NOT_SENT_CODES.has(code));
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 不是 JSON */
    }
    throw new AdapterError(explainVendorError(`HTTP ${resp.status}：${errorText(data, raw)}`, resp.status), resp.status === 429);
  }
  return resp;
}

/** 读 text/event-stream：一条条吐出 data: 后面的内容 */
async function* sseData(resp: Response): AsyncGenerator<string> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

async function imageB64(file: string): Promise<{ mime: string; data: string }> {
  const buf = await fsp.readFile(absFromRel(file));
  return { mime: mimeOf(file), data: buf.toString('base64') };
}

// —— Anthropic 官方 ——

export function anthropicHeaders(apiKey: string) {
  if (!apiKey) throw new AdapterError('还没有填 API key：去「模型管理」里填写');
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

async function anthropicMessages(turns: ChatTurn[]) {
  return Promise.all(
    turns.map(async (t) => {
      if (!t.images?.length) return { role: t.role, content: t.text };
      const imgs = await Promise.all(t.images.map(imageB64));
      return {
        role: t.role,
        content: [
          ...imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
          { type: 'text', text: t.text || '（看图）' },
        ],
      };
    }),
  );
}

export async function anthropicChat(
  base: string,
  apiKey: string,
  model: string,
  req: ChatRequest,
  onDelta: OnDelta,
  signal: AbortSignal,
): Promise<ChatResult> {
  const resp = await post(
    joinUrl(base, 'messages'),
    anthropicHeaders(apiKey),
    { model, max_tokens: req.maxTokens || 16000, system: req.system || undefined, messages: await anthropicMessages(req.turns), stream: true },
    signal,
  );
  let text = '';
  let truncated = false;
  for await (const raw of sseData(resp)) {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      text += ev.delta.text;
      onDelta(ev.delta.text);
    } else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') truncated = true;
    else if (ev.type === 'error') throw new AdapterError(explainVendorError(`${ev.error?.type || ''} ${ev.error?.message || JSON.stringify(ev.error)}`.trim()));
  }
  return { text, truncated };
}

// —— OpenAI 兼容 ——

export async function openaiChatStream(
  base: string,
  headers: Record<string, string>,
  model: string,
  req: ChatRequest,
  onDelta: OnDelta,
  signal: AbortSignal,
): Promise<ChatResult> {
  const messages: any[] = req.system ? [{ role: 'system', content: req.system }] : [];
  for (const t of req.turns) {
    if (!t.images?.length) messages.push({ role: t.role, content: t.text });
    else {
      const imgs = await Promise.all(t.images.map(imageB64));
      messages.push({
        role: t.role,
        content: [{ type: 'text', text: t.text || '（看图）' }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))],
      });
    }
  }
  const resp = await post(joinUrl(base, 'chat/completions'), headers, { model, messages, stream: true, max_tokens: req.maxTokens || 8000 }, signal);
  let text = '';
  let truncated = false;
  for await (const raw of sseData(resp)) {
    if (raw === '[DONE]') break;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.error) throw new AdapterError(explainVendorError(errorText(ev)));
    const c = ev.choices?.[0];
    const d = c?.delta?.content;
    if (typeof d === 'string' && d) {
      text += d;
      onDelta(d);
    }
    if (c?.finish_reason === 'length') truncated = true;
  }
  return { text, truncated };
}
