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
  /** 下载结果要带的请求头（比如 /v1/videos/{id}/content 要带 key）。只在内存里用，不存盘 */
  headers?: Record<string, string>;
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
  /** 这个 key 能用的模型 ID 列表（不支持就不实现） */
  listModels?(ctx: Omit<AdapterContext, 'model'>): Promise<string[]>;
  submit(ctx: AdapterContext, req: PreparedRequest): Promise<SubmitResult>;
  poll?(ctx: AdapterContext, remoteId: string): Promise<PollResult>;
  cancel?(ctx: AdapterContext, remoteId: string): Promise<void>;
  /** 提示词里怎么称呼第 n 个参考素材 */
  refLabel?(kind: 'image' | 'video' | 'audio', n: number, model: ProviderModelConfig): string;
}

/**
 * 适配器抛的错。
 * retryable = 请求肯定没被厂商收下（连不上、限流），可以放心自动重试；
 * uncertain = 请求可能已经被收下（超时、连接中断、5xx），重试有重复扣费的风险，不自动重试。
 */
export class AdapterError extends Error {
  constructor(message: string, public retryable = false, public uncertain = false) {
    super(message);
  }
}

// 这些错误说明连接都没建立起来，请求肯定没发到厂商
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

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
    clearTimeout(timer);
    const code = e?.cause?.code;
    const msg = e?.name === 'AbortError' ? '请求超时' : `网络错误：${code || e?.message || e}`;
    const notSent = e?.name !== 'AbortError' && NOT_SENT_CODES.has(code);
    const hint = e?.name === 'AbortError' ? '服务商太久没响应：稍后再试，或去厂商控制台看任务是否已经生成' : '连不上服务商：检查网络、代理和接口地址';
    throw new AdapterError(`${hint}。原始信息：${msg}（${shortUrl(url)}）`, notSent, !notSent);
  }
  // 超时要管到响应体读完：有的服务商回了响应头、响应体却一直不发完
  let text: string;
  try {
    text = await resp.text();
  } catch (e: any) {
    throw new AdapterError(
      `服务商的响应没传完（${e?.name === 'AbortError' ? '超时' : '连接断了'}）：厂商可能已经收下任务，先去控制台确认再重试（${shortUrl(url)}）`,
      false,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* 不是 JSON */
  }
  if (!resp.ok) {
    throw new AdapterError(explainVendorError(`HTTP ${resp.status}：${errorText(data, text)}`, resp.status), resp.status === 429, resp.status >= 500);
  }
  return (data ?? {}) as T;
}

/** 厂商报错 → 前面加一句中文说明和该怎么办，原文留在后面方便排查 */
export function explainVendorError(detail: string, status?: number): string {
  const d = detail.toLowerCase();
  let hint = '';
  // 先看明确的状态码，再看关键词（关键词收紧：别把 "constraint violation"、"case-sensitive" 这类参数错误当成审核没过）
  const moderation = /content[_ ]?(policy|filter|moderation)|moderation|sensitive[_ ]?(content|words?)|safety[_ ]?(system|check|filter)|policy[_ ]?violation|违规|审核|敏感/.test(d);
  const balance = /insufficient[_ ]?(balance|quota|credit|funds)|余额|balance|欠费|credit/.test(d);
  if (status === 401) hint = 'key 无效或没有权限：去「模型管理」检查 key 和分组';
  else if (status === 402 || balance) hint = '余额不足：去服务商后台充值';
  else if (moderation) hint = '内容没通过审核：换个说法或换参考图';
  else if (status === 403) hint = 'key 无效或没有权限：去「模型管理」检查 key 和分组';
  else if (status === 429) hint = '请求太频繁或并发超限：稍后再试，或在模型管理里调低「同时最多」';
  else if (status === 404) hint = '接口地址或模型 ID 不对：去「模型管理」检查';
  else if (status && status >= 500) hint = '服务商那边出错了：稍后再试';
  return hint ? `${hint}。原始信息：${detail}` : detail;
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
