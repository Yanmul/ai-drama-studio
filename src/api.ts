// 前端调后端的小封装
import type {
  Asset,
  CanvasFile,
  Character,
  Episode,
  GenerateRequest,
  Job,
  ModelInfo,
  Project,
  ProjectSummary,
  ProviderView,
} from '../shared/types';

async function call<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  const resp = await fetch(url, {
    method,
    keepalive,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data as any)?.error || `请求失败 ${resp.status}`);
  return data as T;
}

export const fileUrl = (rel?: string) => (rel ? `/files/${rel.split('/').map(encodeURIComponent).join('/')}` : '');

export const api = {
  models: () => call<ModelInfo[]>('GET', '/api/models'),
  providers: () => call<ProviderView[]>('GET', '/api/providers'),
  adapters: () => call<{ type: string; label: string; defaultBaseUrl: string }[]>('GET', '/api/adapters'),
  presets: () => call<{ id: string; label: string }[]>('GET', '/api/presets'),
  saveProvider: (id: string | null, body: unknown) =>
    id ? call<ProviderView>('PUT', `/api/providers/${id}`, body) : call<ProviderView>('POST', '/api/providers', body),
  deleteProvider: (id: string) => call('DELETE', `/api/providers/${id}`),
  testProvider: (id: string) => call<{ ok: boolean; message: string }>('POST', `/api/providers/${id}/test`),

  projects: () => call<Project[]>('GET', '/api/projects'),
  home: () => call<ProjectSummary[]>('GET', '/api/home'),
  deleteProject: (pid: string) => call('DELETE', `/api/projects/${pid}`),
  createProject: (name: string) => call<Project>('POST', '/api/projects', { name }),
  updateProject: (pid: string, patch: Partial<Project>) => call<Project>('PUT', `/api/projects/${pid}`, patch),
  episodes: (pid: string) => call<Episode[]>('GET', `/api/projects/${pid}/episodes`),
  createEpisode: (pid: string, title?: string) => call<Episode>('POST', `/api/projects/${pid}/episodes`, { title }),
  renameEpisode: (pid: string, eid: string, title: string) => call<Episode>('PUT', `/api/projects/${pid}/episodes/${eid}`, { title }),
  canvas: (pid: string, eid: string) => call<CanvasFile>('GET', `/api/projects/${pid}/episodes/${eid}/canvas`),
  /** keepalive：关页面时用，浏览器会在页面关掉后把请求发完（请求体要小于 64KB） */
  saveCanvas: (pid: string, eid: string, c: CanvasFile, keepalive = false) =>
    call('PUT', `/api/projects/${pid}/episodes/${eid}/canvas`, c, keepalive),

  characters: (pid: string) => call<Character[]>('GET', `/api/projects/${pid}/characters`),
  saveCharacter: (pid: string, c: Partial<Character>) =>
    c.id ? call<Character>('PUT', `/api/projects/${pid}/characters/${c.id}`, c) : call<Character>('POST', `/api/projects/${pid}/characters`, c),
  deleteCharacter: (pid: string, cid: string) => call('DELETE', `/api/projects/${pid}/characters/${cid}`),

  history: (pid: string) =>
    call<{ file: string; kind: string; jobId: string; createdAt: string; prompt: string; model: string }[]>('GET', `/api/projects/${pid}/history`),

  assets: () => call<Asset[]>('GET', '/api/assets'),
  addAssets: (items: { kind: string; name: string; file?: string; text?: string; projectId?: string }[]) =>
    call<{ added: Asset[]; skipped: number }>('POST', '/api/assets', { items }),
  renameAsset: (id: string, name: string) => call<Asset>('PUT', `/api/assets/${id}`, { name }),
  deleteAsset: (id: string) => call('DELETE', `/api/assets/${id}`),

  generate: (req: GenerateRequest) => call<Job[]>('POST', '/api/generate', req),
  jobs: (pid: string) => call<Job[]>('GET', `/api/jobs?projectId=${encodeURIComponent(pid)}`),
  cancelJob: (id: string) => call<Job>('POST', `/api/jobs/${id}/cancel`),
  resumeJob: (id: string) => call<Job>('POST', `/api/jobs/${id}/resume`),
  retryJob: (id: string) => call<Job[]>('POST', `/api/jobs/${id}/retry`),
  quickText: (modelId: string, prompt: string) => call<{ text: string }>('POST', '/api/quick-text', { modelId, prompt }),

  async upload(pid: string, file: File): Promise<{ file: string; kind: 'image' | 'video' | 'audio'; name: string }> {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch(`/api/projects/${pid}/upload`, { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error || '上传失败');
    return data;
  },
};
