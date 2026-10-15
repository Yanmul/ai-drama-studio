// 适配器接口：接一家新厂商 = 写一个实现了 Adapter 的文件，再在 providers/index.ts 里登记一行。
import type { Capability, ProviderModelConfig, ProviderType, RefInput } from '../../shared/types.js';

/** providers.json 里存的服务商（key 是加密过的） */
export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyEnc: string;
  enabled: boolean;
  concurrency: number;
  /** 参考图怎么交给厂商：base64 直接塞进请求，或者给一个公网地址 */
  refMode: 'base64' | 'public';
  publicBaseUrl?: string;
  models: ProviderModelConfig[];
  lastTest?: { ok: boolean; message: string; at: string };
}

export interface AdapterContext {
  provider: ProviderRecord;
  apiKey: string;
  model: ProviderModelConfig;
}

/** 已经组装好的请求：提示词里的 @图1 已换成厂商认识的叫法 */
export interface PreparedRequest {
  capability: Capability;
  mode: string;
  prompt: string;
  refs: RefInput[];
  params: Record<string, string | number | boolean>;
}

export interface RemoteOutput {
  kind: Capability;
  url?: string; // 厂商给的下载链接
  base64?: string; // 或者直接给的内容
  mime?: string;
  text?: string;
  /** 适配器自己在本地生成好的文件（演示模型用） */
  localFile?: string;
}

export type SubmitResult =
  | { kind: 'done'; outputs: RemoteOutput[]; cost?: number }
  | { kind: 'pending'; remoteId: string };

export interface PollResult {
  status: 'running' | 'succeeded' | 'failed';
  outputs?: RemoteOutput[];
  error?: string;
  note?: string;
  cost?: number;
}

export interface Adapter {
  type: ProviderType;
  label: string;
  defaultBaseUrl: string;
  /** 测试 key 和地址能不能用，成功返回一句说明，失败抛错 */
  test(ctx: Omit<AdapterContext, 'model'>): Promise<string>;
  submit(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult>;
  poll?(ctx: AdapterContext, remoteId: string): Promise<PollResult>;
  cancel?(ctx: AdapterContext, remoteId: string): Promise<void>;
  /** 提示词里怎么称呼第 n 个参考素材 */
  refLabel?(kind: 'image' | 'video' | 'audio', n: number, model: ProviderModelConfig): string;
}

/** 适配器抛的错。retryable = 网络抖动、限流这类可以自动重试的 */
export class AdapterError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}

/** 带超时的请求，统一把厂商的报错翻成一句话 */
export async function httpJson<T = any>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: any; timeoutMs?: number; form?: FormData } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method || (init.body || init.form ? 'POST' : 'GET'),
      headers: init.form ? init.headers : { 'Content-Type': 'application/json', ...(init.headers || {}) },
      body: init.form ? init.form : init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? '请求超时' : `网络错误：${e?.cause?.code || e?.message || e}`;
    throw new AdapterError(`${msg}（${shortUrl(url)}）`, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* 不是 JSON */
  }
  if (!resp.ok) {
    const retryable = resp.status === 429 || resp.status >= 500;
    throw new AdapterError(`HTTP ${resp.status}：${errorText(data, text)}`, retryable);
  }
  return (data ?? {}) as T;
}

export function errorText(data: any, raw = ''): string {
  if (data && typeof data === 'object') {
    const e = data.error ?? data.message ?? data.msg ?? data.detail;
    if (typeof e === 'string') return e.slice(0, 500);
    if (e && typeof e === 'object') return `${e.code ? e.code + ' ' : ''}${e.message || JSON.stringify(e)}`.slice(0, 500);
    return JSON.stringify(data).slice(0, 500);
  }
  return (raw || '没有返回内容').slice(0, 500);
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

export function joinUrl(base: string, p: string): string {
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}
