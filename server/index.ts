import { spawn } from 'node:child_process';
// 本地后端：只监听本机 127.0.0.1，局域网里的其他设备访问不到。
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
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
  updateEpisode,
  updateProject,
  listCanvasBackups,
  restoreCanvasBackup,
} from './projects.js';
import { ADAPTERS, deleteProvider, listModels, listProviderViews, remoteModels, resolveModel, testModel, testProvider, upsertProvider } from './providers/index.js';
import { buildPrompt } from './prompt.js';
import { cleanupStatus, runCleanup, startCleanupSchedule } from './cleanup.js';
import { cancelJob, enqueue, events, getJob, listJobs, recover, resumeJob, runQuickText } from './queue.js';
import { addAssets, deleteAsset, listAssets, renameAsset, type AssetInput } from './assets.js';
import { PROJECT_ROOT, WORKSPACE, absFromRel, ensureDir, kindOfFile, newId, paths, readJson, rel, writeJson } from './storage.js';

const PORT = Number(process.env.PORT || 6688);
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });

app.setErrorHandler((err: any, req, reply) => {
  // 硬盘满了、没权限、读写出错这类（ENOSPC / EACCES / EIO…）是服务器自己的问题，算 500；
  // 我们自己 throw new Error('…') 的、参数校验没过的，都算请求的问题，400
  const sysErr = typeof err?.code === 'string' && err.code.startsWith('E') && Boolean(err.syscall);
  const status = err?.statusCode >= 500 || sysErr ? 500 : err?.statusCode >= 400 ? err.statusCode : 400;
  if (status >= 500) console.error(`${req.method} ${req.url} 出错：`, err?.stack || err);
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
  const host = hostnameOf(`http://${req.headers.host || ''}`);
  const origin = req.headers.origin;
  const originOk = !origin || LOCAL_HOSTS.has(hostnameOf(origin));
  if (LOCAL_HOSTS.has(host) && originOk) return;
  // 「参考图传法 = 给公网链接」时，厂商会从你配置的公网地址来取素材：只放行这个地址上的 GET /files/
  // 只放行参考素材（上传的、生成的、资产库），配置、任务记录、画布这些不让外网读
  if (req.method === 'GET' && PUBLIC_FILES.test(req.url.split('?')[0]) && !req.url.includes('..') && host && (await publicHosts()).has(host)) return;
  return reply.status(403).send({ error: '只允许从本机访问' });
});
const PUBLIC_FILES = /^\/files\/(projects\/[^/]+\/uploads\/[^/]+|projects\/[^/]+\/episodes\/[^/]+\/assets\/[^/]+\/[^/]+\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a)|assets\/files\/[^/]+)$/i;
async function publicHosts(): Promise<Set<string>> {
  const ps = await listProviderViews();
  return new Set(ps.filter((p) => p.refMode === 'public' && p.publicBaseUrl).map((p) => hostnameOf(p.publicBaseUrl!)));
}

await ensureDir(WORKSPACE);
const UPLOAD_MAX_MB = 500;
const TOO_LARGE = `文件太大了：单个文件最大 ${UPLOAD_MAX_MB} MB`;
await app.register(multipart, { limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 } });
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
app.put('/api/projects/:pid/episodes/:eid/canvas', async (req, reply) => {
  const { pid, eid } = req.params as any;
  const r = await saveCanvas(pid, eid, req.body as CanvasFile);
  if ('conflict' in r) return reply.status(409).send({ error: '这一集在别的窗口里改过了', conflict: true, savedAt: r.savedAt });
  return r;
});

app.get('/api/projects/:pid/episodes/:eid/backups', async (req) => {
  const { pid, eid } = req.params as any;
  return listCanvasBackups(pid, eid);
});
app.post('/api/projects/:pid/episodes/:eid/backups/:name/restore', async (req) => {
  const { pid, eid, name } = req.params as any;
  return restoreCanvasBackup(pid, eid, name);
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
  // 项目不存在（删掉了）就别建孤儿目录
  if (!fs.existsSync(paths.projectFile(pid))) throw new Error('这个项目不存在了');
  const part = await (req as any).file();
  if (!part) throw new Error('没有收到文件');
  const MIME_EXT: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a',
  };
  // 先按扩展名 / 类型判断，不是图片、视频、音频就不落盘
  const ext = path.extname(part.filename || '').toLowerCase() || MIME_EXT[part.mimetype] || '';
  const kind = ext ? kindOfFile(`x${ext}`) : 'other';
  if (kind === 'other') {
    part.file.resume(); // 把剩下的数据读掉，连接才能正常结束
    throw new Error('只支持图片、视频、音频文件');
  }
  const dir = paths.uploads(pid);
  await ensureDir(dir);
  const file = path.join(dir, `${newId('up_')}${ext}`);
  // 边收边写进临时文件，大视频不会整个塞进内存；写完再改名
  const tmp = `${file}.uploading`;
  try {
    await pipeline(part.file, fs.createWriteStream(tmp));
    if (part.file.truncated) throw new Error(TOO_LARGE);
    await fsp.rename(tmp, file);
  } catch (e: any) {
    await fsp.rm(tmp, { force: true });
    if (e?.code === 'FST_REQ_FILE_TOO_LARGE') throw new Error(TOO_LARGE);
    throw e;
  }
  return { file: rel(file), kind, name: part.filename };
});

// —— 视频截帧（首帧 / 尾帧 / 指定时间）：用 ffmpeg 从原文件取，分辨率和原视频一样 ——
// 电脑上没装 ffmpeg 时返回 501，前端改在浏览器里截
app.post('/api/projects/:pid/frame', async (req, reply) => {
  const { pid } = req.params as any;
  const { file, at } = (req.body || {}) as { file: string; at: 'first' | 'last' | number };
  const src = absFromRel(file);
  const dir = paths.uploads(pid);
  await ensureDir(dir);
  const out = path.join(dir, `${newId('frame_')}.png`);
  const args =
    at === 'last'
      ? ['-y', '-sseof', '-0.6', '-i', src, '-update', '1', '-vsync', '0', out] // 读最后 0.6 秒，一帧帧覆盖，留下的就是最后一帧
      : at === 'first'
        ? ['-y', '-i', src, '-frames:v', '1', out]
        : ['-y', '-ss', String(Math.max(0, Number(at) || 0)), '-i', src, '-frames:v', '1', out];
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn('ffmpeg', args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  if (!ok || !fs.existsSync(out)) return reply.status(501).send({ error: '没有 ffmpeg' });
  return { file: rel(out), kind: 'image' };
});

// —— 全局设置（常用模型等） ——
app.get('/api/settings', async () => readJson<Record<string, unknown>>(paths.settings(), {}));
app.put('/api/settings', async (req) => {
  const cur = await readJson<Record<string, unknown>>(paths.settings(), {});
  const next = { ...cur, ...((req.body as object) || {}) };
  await ensureDir(paths.config());
  await writeJson(paths.settings(), next);
  return next;
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
        .filter((o) => o.file && fileExists(o.file)) // 被自动清理删掉的不再列出
        .map((o) => ({ file: o.file!, kind: o.kind, jobId: j.id, createdAt: j.finishedAt || j.createdAt, prompt: j.request.prompt, model: j.modelName })),
    );
});

function fileExists(relPath: string) {
  try {
    return fs.existsSync(absFromRel(relPath));
  } catch {
    return false;
  }
}

// —— 自动清理（每 3 天删 3 天前的生成 / 上传文件） ——
app.get('/api/cleanup', async () => cleanupStatus());
app.post('/api/cleanup/run', async () => {
  await runCleanup();
  return cleanupStatus();
});

// —— 生成与队列 ——
app.post('/api/generate', async (req) => enqueue(req.body as GenerateRequest));
// 预览最终提示词：和真正生成时同一套拼法（画风 + 连进来的文本 + 角色描述 + @图1 换成厂商叫法）
app.post('/api/preview-prompt', async (req) => {
  const r = req.body as GenerateRequest;
  const { provider, model } = await resolveModel(r.modelId);
  return { prompt: await buildPrompt(r, ADAPTERS[provider.type], model) };
});
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
  // 没有构建好的界面 = 在用开发模式：直接跳到热更新的界面（vite.config.ts 里固定的 5188）
  reply.redirect(`http://127.0.0.1:5188${req.url}`);
});

await recover();
startCleanupSchedule();
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`\n  短剧工作台已启动： http://127.0.0.1:${PORT}\n  工作文件夹：${WORKSPACE}\n`);
