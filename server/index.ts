// 本地后端：只监听本机 127.0.0.1，局域网里的其他设备访问不到。
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CanvasFile, GenerateRequest, ServerEvent } from '../shared/types.js';
import { PRESETS } from './presets.js';
import {
  createEpisode,
  createProject,
  deleteCharacter,
  listCharacters,
  listEpisodes,
  listProjects,
  projectSummaries,
  trashProject,
  readCanvas,
  saveCanvas,
  saveCharacter,
  seedIfEmpty,
  updateEpisode,
  updateProject,
} from './projects.js';
import { ADAPTERS, deleteProvider, listModels, listProviderViews, remoteModels, testModel, testProvider, upsertProvider } from './providers/index.js';
import { cancelJob, enqueue, events, getJob, listJobs, recover, resumeJob, runQuickText } from './queue.js';
import { addAssets, deleteAsset, listAssets, renameAsset, type AssetInput } from './assets.js';
import { PROJECT_ROOT, WORKSPACE, ensureDir, kindOfFile, newId, paths, rel } from './storage.js';

const PORT = Number(process.env.PORT || 6688);
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });

app.setErrorHandler((err: any, _req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 400;
  reply.status(status).send({ error: String(err?.message || err) });
});

// 只接受本机来的请求。光监听 127.0.0.1 不够：恶意网页可以用 DNS 重绑定（Host 是它的域名）
// 或跨站表单（Origin 是它的网站）调我们的接口，比如改掉服务商地址再点「测试」把 key 发过去。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostnameOf = (s: string) => {
  try {
    return new URL(s).hostname;
  } catch {
    return '';
  }
};
app.addHook('onRequest', async (req, reply) => {
  const hostOk = LOCAL_HOSTS.has(hostnameOf(`http://${req.headers.host || ''}`));
  const origin = req.headers.origin;
  const originOk = !origin || LOCAL_HOSTS.has(hostnameOf(origin));
  if (!hostOk || !originOk) return reply.status(403).send({ error: '只允许从本机访问' });
});

await ensureDir(WORKSPACE);
await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: WORKSPACE, prefix: '/files/', decorateReply: false });
const dist = path.join(PROJECT_ROOT, 'dist');
if (fs.existsSync(dist)) await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: false });

// —— 模型与服务商 ——
app.get('/api/models', async () => listModels());
app.get('/api/providers', async () => listProviderViews());
app.get('/api/adapters', async () =>
  Object.values(ADAPTERS).map((a) => ({ type: a.type, label: a.label, defaultBaseUrl: a.defaultBaseUrl })),
);
app.get('/api/presets', async () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })));
app.post('/api/providers', async (req) => upsertProvider(null, req.body as any));
app.put('/api/providers/:id', async (req) => upsertProvider((req.params as any).id, req.body as any));
app.delete('/api/providers/:id', async (req) => {
  await deleteProvider((req.params as any).id);
  return { ok: true };
});
app.post('/api/providers/:id/test', async (req) => testProvider((req.params as any).id));
app.get('/api/providers/:id/remote-models', async (req) => remoteModels((req.params as any).id));
app.post('/api/providers/:id/models/:mid/test', async (req) => {
  const { id, mid } = req.params as any;
  return testModel(id, mid);
});

// —— 项目、剧集、画布 ——
app.get('/api/projects', async () => listProjects());
app.post('/api/projects', async (req) => {
  const b = req.body as any;
  return createProject(b?.name, b?.style, b?.ratio);
});
app.put('/api/projects/:pid', async (req) => updateProject((req.params as any).pid, req.body as any));
app.get('/api/home', async () => projectSummaries());
app.delete('/api/projects/:pid', async (req) => {
  await trashProject((req.params as any).pid);
  return { ok: true };
});
app.get('/api/projects/:pid/episodes', async (req) => listEpisodes((req.params as any).pid));
app.post('/api/projects/:pid/episodes', async (req) => createEpisode((req.params as any).pid, (req.body as any)?.title));
app.put('/api/projects/:pid/episodes/:eid', async (req) => {
  const { pid, eid } = req.params as any;
  return updateEpisode(pid, eid, (req.body as any)?.title);
});
app.get('/api/projects/:pid/episodes/:eid/canvas', async (req) => {
  const { pid, eid } = req.params as any;
  return readCanvas(pid, eid);
});
app.put('/api/projects/:pid/episodes/:eid/canvas', async (req) => {
  const { pid, eid } = req.params as any;
  await saveCanvas(pid, eid, req.body as CanvasFile);
  return { ok: true };
});

// —— 角色库 ——
app.get('/api/projects/:pid/characters', async (req) => listCharacters((req.params as any).pid));
app.post('/api/projects/:pid/characters', async (req) => saveCharacter((req.params as any).pid, req.body as any));
app.put('/api/projects/:pid/characters/:cid', async (req) => {
  const { pid, cid } = req.params as any;
  return saveCharacter(pid, { ...(req.body as any), id: cid });
});
app.delete('/api/projects/:pid/characters/:cid', async (req) => {
  const { pid, cid } = req.params as any;
  await deleteCharacter(pid, cid);
  return { ok: true };
});

// —— 上传素材 ——
app.post('/api/projects/:pid/upload', async (req) => {
  const { pid } = req.params as any;
  const part = await (req as any).file();
  if (!part) throw new Error('没有收到文件');
  const MIME_EXT: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a',
  };
  const ext = path.extname(part.filename || '').toLowerCase() || MIME_EXT[part.mimetype] || '.bin';
  const dir = paths.uploads(pid);
  await ensureDir(dir);
  const file = path.join(dir, `${newId('up_')}${ext}`);
  await fsp.writeFile(file, await part.toBuffer());
  const kind = kindOfFile(file);
  if (kind === 'other') {
    await fsp.rm(file, { force: true });
    throw new Error('只支持图片、视频、音频文件');
  }
  return { file: rel(file), kind, name: part.filename };
});

// —— 资产库 ——
app.get('/api/assets', async () => listAssets());
app.post('/api/assets', async (req) => addAssets(((req.body as any)?.items || []) as AssetInput[]));
app.put('/api/assets/:id', async (req) => renameAsset((req.params as any).id, String((req.body as any)?.name || '').trim() || '未命名'));
app.delete('/api/assets/:id', async (req) => {
  await deleteAsset((req.params as any).id);
  return { ok: true };
});

// —— 生成历史（从生成历史选择） ——
app.get('/api/projects/:pid/history', async (req) => {
  const { pid } = req.params as any;
  return listJobs({ projectId: pid })
    .filter((j) => j.status === 'succeeded')
    .flatMap((j) =>
      (j.outputs || [])
        .filter((o) => o.file)
        .map((o) => ({ file: o.file!, kind: o.kind, jobId: j.id, createdAt: j.finishedAt || j.createdAt, prompt: j.request.prompt, model: j.modelName })),
    );
});

// —— 生成与队列 ——
app.post('/api/generate', async (req) => enqueue(req.body as GenerateRequest));
app.get('/api/jobs', async (req) => {
  const q = req.query as any;
  return listJobs({ projectId: q.projectId, episodeId: q.episodeId, limit: Number(q.limit) || 300 });
});
app.post('/api/jobs/:id/cancel', async (req) => cancelJob((req.params as any).id));
app.post('/api/jobs/:id/resume', async (req) => resumeJob((req.params as any).id));
app.post('/api/jobs/:id/retry', async (req) => {
  const j = getJob((req.params as any).id);
  if (!j) throw new Error('任务不存在');
  return enqueue(j.request);
});
app.post('/api/quick-text', async (req) => {
  const b = req.body as any;
  return { text: await runQuickText(b.modelId, b.prompt) };
});

// —— 服务器推送：任务状态实时更新 ——
app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (e: ServerEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  send({ type: 'hello' });
  events.on('event', send);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    events.off('event', send);
  });
});

// 前端路由兜底
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/files/')) return reply.status(404).send({ error: '不存在' });
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) return reply.type('text/html').send(fs.readFileSync(index));
  reply.status(404).send('前端还没有构建：请运行 npm run build，或用 npm run dev 开发模式');
});

await seedIfEmpty();
await recover();
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`\n  短剧工作台已启动： http://127.0.0.1:${PORT}\n  工作文件夹：${WORKSPACE}\n`);
