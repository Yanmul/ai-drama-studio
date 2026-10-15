// 服务商注册表：读写 config/providers.json，把配置拼成界面要的模型列表。
// 新增一种适配器：在 ADAPTERS 里加一行。
import type { ModelInfo, ProviderModelConfig, ProviderType, ProviderView, RemoteModelGuess } from '../../shared/types.js';
import { guessModel } from './guess.js';
import { decrypt, encrypt, hint } from '../secrets.js';
import { getPreset } from '../presets.js';
import { newId, nowIso, paths, readJson, writeJson } from '../storage.js';
import { relayAdapter } from './relay.js';
import type { Adapter, ProviderRecord } from './types.js';
import { ARK_DEFAULT_BASE, volcengineAdapter } from './volcengine.js';

export const ADAPTERS: Record<ProviderType, Adapter> = {
  volcengine: volcengineAdapter,
  relay: relayAdapter,
};

interface ProvidersFile {
  version: 1;
  providers: ProviderRecord[];
}

let cache: ProvidersFile | null = null;

function defaults(): ProvidersFile {
  return {
    version: 1,
    providers: [
      {
        id: 'ark',
        name: '火山引擎',
        type: 'volcengine',
        baseUrl: ARK_DEFAULT_BASE,
        apiKeyEnc: '',
        enabled: true,
        concurrency: 3,
        refMode: 'base64',
        models: [
          // 模型 ID 会随版本更新，以方舟控制台「模型推理」里显示的为准
          { id: 'seedance2', name: 'Seedance 2.0', capability: 'video', remoteModel: 'doubao-seedance-2-0-260615', preset: 'seedance', enabled: true },
          { id: 'seedance2-mini', name: 'Seedance 2.0 mini', capability: 'video', remoteModel: 'doubao-seedance-2-0-mini-260615', preset: 'seedance', enabled: true },
          { id: 'seedream', name: 'Seedream 4.0', capability: 'image', remoteModel: 'doubao-seedream-4-0-250828', preset: 'seedream', enabled: true },
          { id: 'doubao', name: '豆包（文本）', capability: 'text', remoteModel: 'doubao-seed-1-6-250615', preset: 'chat', enabled: true },
        ],
      },
    ],
  };
}

export async function loadProviders(): Promise<ProvidersFile> {
  if (cache) return cache;
  const file = await readJson<ProvidersFile | null>(paths.providers(), null);
  cache = file || defaults();
  // 去掉已经不支持的服务商类型（比如以前的「演示模型」）
  const before = cache.providers.length;
  cache.providers = cache.providers.filter((p) => p.type in ADAPTERS);
  if (!file || cache.providers.length !== before) await writeJson(paths.providers(), cache);
  return cache;
}

async function save() {
  if (cache) await writeJson(paths.providers(), cache);
}

export async function getProvider(id: string): Promise<ProviderRecord> {
  const f = await loadProviders();
  const p = f.providers.find((x) => x.id === id);
  if (!p) throw new Error(`找不到服务商 ${id}`);
  return p;
}

export function apiKeyOf(p: ProviderRecord): string {
  return p.apiKeyEnc ? decrypt(p.apiKeyEnc) : '';
}

function isReady(p: ProviderRecord): boolean {
  return p.enabled && Boolean(p.apiKeyEnc);
}

export function toView(p: ProviderRecord): ProviderView {
  let keyHint = '';
  try {
    keyHint = hint(apiKeyOf(p));
  } catch {
    keyHint = '（解密失败，请重填）';
  }
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    keyHint,
    enabled: p.enabled,
    concurrency: p.concurrency,
    refMode: p.refMode,
    publicBaseUrl: p.publicBaseUrl,
    models: p.models,
    lastTest: p.lastTest,
  };
}

export async function listProviderViews(): Promise<ProviderView[]> {
  return (await loadProviders()).providers.map(toView);
}

/** 界面下拉框用的模型列表：只列能用的（服务商启用 + 填了 key + 模型启用） */
export async function listModels(): Promise<ModelInfo[]> {
  const f = await loadProviders();
  const out: ModelInfo[] = [];
  for (const p of f.providers) {
    if (!isReady(p)) continue;
    for (const m of p.models) {
      if (!m.enabled) continue;
      const preset = getPreset(m.preset);
      out.push({
        id: `${p.id}/${m.id}`,
        providerId: p.id,
        providerName: p.name,
        name: m.name,
        capability: m.capability,
        modes: preset.modes,
        params: preset.params,
        price: m.price,
      });
    }
  }
  return out;
}

export async function resolveModel(modelId: string): Promise<{ provider: ProviderRecord; model: ProviderModelConfig }> {
  const [pid, mid] = modelId.split('/');
  const provider = await getProvider(pid);
  const model = provider.models.find((m) => m.id === mid);
  if (!model) throw new Error(`找不到模型 ${modelId}`);
  if (!provider.enabled) throw new Error(`服务商「${provider.name}」已停用`);
  if (!model.enabled) throw new Error(`模型「${model.name}」已停用`);
  return { provider, model };
}

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string; // 不传 = 不改；传空字符串 = 清空
  enabled: boolean;
  concurrency: number;
  refMode: 'base64' | 'public';
  publicBaseUrl?: string;
  models: ProviderModelConfig[];
}

export async function upsertProvider(id: string | null, input: ProviderInput): Promise<ProviderView> {
  const f = await loadProviders();
  let p = id ? f.providers.find((x) => x.id === id) : undefined;
  if (!p) {
    p = {
      id: id || newId('p_'),
      name: input.name || '新服务商',
      type: input.type,
      baseUrl: '',
      apiKeyEnc: '',
      enabled: true,
      concurrency: 2,
      refMode: 'base64',
      models: [],
    };
    f.providers.push(p);
  }
  p.name = input.name || p.name;
  p.type = input.type || p.type;
  p.baseUrl = (input.baseUrl || '').trim() || ADAPTERS[p.type].defaultBaseUrl;
  if (input.apiKey !== undefined) p.apiKeyEnc = input.apiKey.trim() ? encrypt(input.apiKey.trim()) : '';
  p.enabled = Boolean(input.enabled);
  p.concurrency = Math.max(1, Math.min(10, Number(input.concurrency) || 2));
  p.refMode = input.refMode === 'public' ? 'public' : 'base64';
  p.publicBaseUrl = (input.publicBaseUrl || '').trim() || undefined;
  p.models = (input.models || []).map((m) => ({
    ...m,
    id: m.id?.trim() || newId('m_'),
    name: m.name?.trim() || m.remoteModel,
    remoteModel: (m.remoteModel || '').trim(),
  }));
  await save();
  return toView(p);
}

export async function deleteProvider(id: string) {
  const f = await loadProviders();
  f.providers = f.providers.filter((p) => p.id !== id);
  await save();
}

/** 拉这个 key 能用的模型列表，顺便按名字猜好类型和接口格式 */
export async function remoteModels(id: string): Promise<RemoteModelGuess[]> {
  const p = await getProvider(id);
  const adapter = ADAPTERS[p.type];
  if (!adapter.listModels) throw new Error(`「${adapter.label}」类型的服务商不支持拉取模型列表，请手动添加`);
  const ids = await adapter.listModels({ provider: p, apiKey: apiKeyOf(p) });
  return ids.map(guessModel);
}

/**
 * 试一下单个模型：
 * - 文本模型真的发一句话（几乎不花钱），能确认模型 ID、分组权限、接口格式都对；
 * - 图片 / 视频模型生成一次会扣费，只核对模型 ID 在不在这个 key 的模型列表里。
 */
export async function testModel(id: string, mid: string): Promise<{ ok: boolean; message: string }> {
  const p = await getProvider(id);
  const model = p.models.find((m) => m.id === mid);
  if (!model) throw new Error('找不到这个模型，请先保存');
  if (!model.remoteModel) return { ok: false, message: '还没有填模型 ID' };
  const adapter = ADAPTERS[p.type];
  const ctx = { provider: p, model, apiKey: apiKeyOf(p) };

  let listed: boolean | undefined;
  if (adapter.listModels) {
    try {
      listed = (await adapter.listModels(ctx)).includes(model.remoteModel);
    } catch {
      listed = undefined; // 有的中转站不开放模型列表，不影响下面真正调用
    }
  }

  if (model.capability === 'text') {
    try {
      const started = Date.now();
      const r = await adapter.submit(ctx, { capability: 'text', mode: 'chat', prompt: '请只回复两个字母：OK', refs: [], params: { temperature: 0 } });
      const text = r.kind === 'done' ? r.outputs.find((o) => o.kind === 'text')?.text?.trim() : '';
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      return { ok: true, message: `能用，${secs} 秒回复${text ? `：「${text.slice(0, 40)}」` : ''}` };
    } catch (e: any) {
      const hint = listed === false ? `（这个 key 的模型列表里也没有「${model.remoteModel}」，多半是 ID 拼错了或分组没开通）` : '';
      return { ok: false, message: `${e?.message || e}${hint}` };
    }
  }

  const costNote = '图片 / 视频模型试一次会扣费，所以没有真的生成，第一次用请先生成一条短的';
  if (listed === true) return { ok: true, message: `模型列表里有这个 ID。${costNote}` };
  if (listed === false) return { ok: false, message: `这个 key 的模型列表里没有「${model.remoteModel}」：可能 ID 拼错了，或这个分组没开通这个模型` };
  return { ok: true, message: `这家服务商查不了模型列表，没法核对 ID。${costNote}` };
}

export async function testProvider(id: string): Promise<{ ok: boolean; message: string }> {
  const p = await getProvider(id);
  let result: { ok: boolean; message: string };
  try {
    const msg = await ADAPTERS[p.type].test({ provider: p, apiKey: apiKeyOf(p) });
    result = { ok: true, message: msg };
  } catch (e: any) {
    result = { ok: false, message: String(e?.message || e) };
  }
  p.lastTest = { ...result, at: nowIso() };
  await save();
  return result;
}
