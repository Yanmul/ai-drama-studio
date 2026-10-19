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
  CleanupStatus,
  ProviderView,
  RemoteModelGuess,
  Chat,
  ChatStreamEvent,
  ChatSummary,
  StylePreset,
} from '../shared/types';

/** 请求失败：message 是给人看的中文；status / data 留给需要细分处理的地方（比如保存冲突） */
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any = {}) {
    super(message);
  }
  get conflict() {
    return this.status === 409 || Boolean(this.data?.conflict);
  }
}

const OFFLINE = '连不上本机服务：确认启动用的终端窗口还开着（双击「启动.command」或运行 npm run dev）';

async function call<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      keepalive,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data as any)?.error || (resp.status === 502 || resp.status === 504 ? OFFLINE : `请求失败（${resp.status}）`);
    throw new ApiError(msg, resp.status, data);
  }
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
  remoteModels: (id: string) => call<RemoteModelGuess[]>('GET', `/api/providers/${id}/remote-models`),
  testModel: (id: string, mid: string) => call<{ ok: boolean; message: string }>('POST', `/api/providers/${id}/models/${mid}/test`),

  projects: () => call<Project[]>('GET', '/api/projects'),
  home: () => call<ProjectSummary[]>('GET', '/api/home'),
  deleteProject: (pid: string) => call('DELETE', `/api/projects/${pid}`),
  createProject: (name: string, extra: { style?: string; styleId?: string; ratio?: string } = {}) => call<Project>('POST', '/api/projects', { name, ...extra }),
  styles: () => call<StylePreset[]>('GET', '/api/styles'),
  addStyle: (name: string, prompt: string) => call<StylePreset>('POST', '/api/styles', { name, prompt }),
  updateStyle: (id: string, patch: { name?: string; prompt?: string }) => call<StylePreset>('PUT', `/api/styles/${id}`, patch),
  deleteStyle: (id: string) => call('DELETE', `/api/styles/${id}`),
  updateProject: (pid: string, patch: Partial<Project>) => call<Project>('PUT', `/api/projects/${pid}`, patch),
  episodes: (pid: string) => call<Episode[]>('GET', `/api/projects/${pid}/episodes`),
  createEpisode: (pid: string, title?: string) => call<Episode>('POST', `/api/projects/${pid}/episodes`, { title }),
  renameEpisode: (pid: string, eid: string, title: string) => call<Episode>('PUT', `/api/projects/${pid}/episodes/${eid}`, { title }),
  canvas: (pid: string, eid: string) => call<CanvasFile>('GET', `/api/projects/${pid}/episodes/${eid}/canvas`),
  /** keepalive：关页面时用，浏览器会在页面关掉后把请求发完（请求体要小于 64KB） */
  saveCanvas: (pid: string, eid: string, c: CanvasFile, keepalive = false) =>
    call<{ ok: boolean; savedAt?: string }>('PUT', `/api/projects/${pid}/episodes/${eid}/canvas`, c, keepalive),
  canvasBackups: (pid: string, eid: string) =>
    call<{ name: string; savedAt?: string; nodeCount: number; kept?: 'empty' | 'restore' }[]>('GET', `/api/projects/${pid}/episodes/${eid}/backups`),
  restoreBackup: (pid: string, eid: string, name: string) => call('POST', `/api/projects/${pid}/episodes/${eid}/backups/${encodeURIComponent(name)}/restore`),

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

  cleanupStatus: () => call<CleanupStatus>('GET', '/api/cleanup'),
  runCleanup: () => call<CleanupStatus>('POST', '/api/cleanup/run'),

  stitch: (pid: string, eid: string, nodeId: string, files: string[]) =>
    call<{ file: string; duration: number }>('POST', `/api/projects/${pid}/episodes/${eid}/stitch`, { nodeId, files }),
  previewPrompt: (req: GenerateRequest) => call<{ prompt: string }>('POST', '/api/preview-prompt', req),
  generate: (req: GenerateRequest) => call<Job[]>('POST', '/api/generate', req),
  allJobs: () => call<Job[]>('GET', '/api/jobs?limit=300'),
  settings: () => call<{ favoriteModels?: string[] }>('GET', '/api/settings'),
  saveSettings: (patch: { favoriteModels?: string[] }) => call<{ favoriteModels?: string[] }>('PUT', '/api/settings', patch),
  jobs: (pid: string) => call<Job[]>('GET', `/api/jobs?projectId=${encodeURIComponent(pid)}`),
  cancelJob: (id: string) => call<Job>('POST', `/api/jobs/${id}/cancel`),
  resumeJob: (id: string) => call<Job>('POST', `/api/jobs/${id}/resume`),
  retryJob: (id: string) => call<Job[]>('POST', `/api/jobs/${id}/retry`),
  quickText: (modelId: string, prompt: string) => call<{ text: string }>('POST', '/api/quick-text', { modelId, prompt }),

  /** 用 ffmpeg 截帧；没装 ffmpeg 时会抛错（前端改在浏览器里截） */
  frame: (pid: string, file: string, at: 'first' | 'last' | number) =>
    call<{ file: string; kind: 'image' }>('POST', `/api/projects/${pid}/frame`, { file, at }),

  async upload(pid: string, file: File): Promise<{ file: string; kind: 'image' | 'video' | 'audio'; name: string }> {
    const form = new FormData();
    form.append('file', file);
    let resp: Response;
    try {
      resp = await fetch(`/api/projects/${pid}/upload`, { method: 'POST', body: form });
    } catch {
      throw new ApiError(OFFLINE, 0);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new ApiError(data?.error || (resp.status === 413 ? '文件太大了' : '上传失败'), resp.status, data);
    return data;
  },

  // —— 对话框 ——
  chats: () => call<ChatSummary[]>('GET', '/api/chats'),
  chat: (id: string) => call<Chat>('GET', `/api/chats/${id}`),
  createChat: (modelId?: string) => call<Chat>('POST', '/api/chats', { modelId }),
  updateChat: (id: string, patch: { title?: string; modelId?: string }) => call<Chat>('PUT', `/api/chats/${id}`, patch),
  deleteChat: (id: string) => call('DELETE', `/api/chats/${id}`),
  async chatUpload(id: string, file: File): Promise<{ file: string }> {
    const form = new FormData();
    form.append('file', file);
    let resp: Response;
    try {
      resp = await fetch(`/api/chats/${id}/upload`, { method: 'POST', body: form });
    } catch {
      throw new ApiError(OFFLINE, 0);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new ApiError(data?.error || (resp.status === 413 ? '图片太大了' : '上传失败'), resp.status, data);
    return data;
  },
  /** 发消息：服务器一行一个 JSON 推回来，每行调一次 onEvent；signal 中止 = 停止生成 */
  async chatSend(
    id: string,
    body: { text?: string; images?: string[]; modelId: string; projectId?: string; episodeId?: string; regenerate?: boolean },
    onEvent: (e: ChatStreamEvent) => void,
    signal: AbortSignal,
  ) {
    let resp: Response;
    try {
      resp = await fetch(`/api/chats/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      throw new ApiError(OFFLINE, 0);
    }
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw new ApiError((data as any)?.error || `请求失败（${resp.status}）`, resp.status, data);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      throw new ApiError('连接中断了：回复没收完', 0);
    }
  },
};
