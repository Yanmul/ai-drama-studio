// 服务商注册表：读写 config/providers.json，把配置拼成界面要的模型列表。
// 新增一种适配器：在 ADAPTERS 里加一行。
import type { ModelInfo, ProviderModelConfig, ProviderType, ProviderView } from '../../shared/types.js';
import { decrypt, encrypt, hint } from '../secrets.js';
import { getPreset } from '../presets.js';
import { newId, nowIso, paths, readJson, writeJson } from '../storage.js';
import { mockAdapter } from './mock.js';
import { relayAdapter } from './relay.js';
import type { Adapter, ProviderRecord } from './types.js';
import { ARK_DEFAULT_BASE, volcengineAdapter } from './volcengine.js';

export const ADAPTERS: Record<ProviderType, Adapter> = {
  mock: mockAdapter,
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
        id: 'demo',
        name: '演示模型（不花钱）',
        type: 'mock',
        baseUrl: '',
        apiKeyEnc: '',
        enabled: true,
        concurrency: 3,
        refMode: 'base64',
        models: [
          { id: 'image', name: '演示生图', capability: 'image', remoteModel: 'mock', preset: 'mock-image', enabled: true },
          { id: 'video', name: '演示生视频', capability: 'video', remoteModel: 'mock', preset: 'mock-video', enabled: true },
          { id: 'text', name: '演示文本', capability: 'text', remoteModel: 'mock', preset: 'chat', enabled: true },
          { id: 'audio', name: '演示配音', capability: 'audio', remoteModel: 'mock', preset: 'mock-audio', enabled: true },
        ],
      },
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
      {
        id: 'relay-4sapi',
        name: '4sapi 中转站（示例）',
        type: 'relay',
        baseUrl: 'https://4sapi.com/v1',
        apiKeyEnc: '',
        enabled: true,
        concurrency: 2,
        refMode: 'base64',
        models: [
          { id: 'gpt-image', name: 'GPT 生图', capability: 'image', remoteModel: 'gpt-image-2', preset: 'openai-images', protocol: 'openai-images', enabled: true },
          { id: 'claude', name: 'Claude（文本）', capability: 'text', remoteModel: 'claude-sonnet-4-6', preset: 'chat', protocol: 'openai-chat', enabled: true },
          {
            id: 'custom-video',
            name: '自定义视频模型（模板示例）',
            capability: 'video',
            remoteModel: '在这里填中转站给的模型名',
            preset: 'generic-video',
            protocol: 'custom',
            enabled: false,
            custom: {
              submitPath: '/video/generations',
              submitBody: JSON.stringify(
                { model: '{{model}}', prompt: '{{prompt}}', images: '{{images}}', aspect_ratio: '{{params.ratio}}', duration: '{{params.duration}}' },
                null,
                2,
              ),
              taskIdPath: 'id',
              pollPath: '/video/generations/{{taskId}}',
              statusPath: 'status',
              successValues: ['succeeded', 'success', 'completed'],
              failValues: ['failed', 'error', 'cancelled'],
              resultUrlPath: 'video_url',
              errorPath: 'error.message',
              resultKind: 'video',
            },
          },
        ],
      },
    ],
  };
}

export async function loadProviders(): Promise<ProvidersFile> {
  if (cache) return cache;
  const file = await readJson<ProvidersFile | null>(paths.providers(), null);
  cache = file || defaults();
  if (!file) await writeJson(paths.providers(), cache);
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
  return p.enabled && (p.type === 'mock' || Boolean(p.apiKeyEnc));
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
