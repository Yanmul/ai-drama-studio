// 任务队列：所有生成都走这里。点「生成」只是入队，关掉浏览器任务也不会丢。
//   排队 → 提交 →（异步模型）轮询 → 成功立刻下载到本地 → 结束后归档到 jobs/done/年-月/
// 每个服务商有自己的并发上限；网络错误、限流自动重试 2 次；内容审核、参数错误不重试。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GenerateRequest, Job, OutputItem } from '../shared/types.js';
import { ADAPTERS, apiKeyOf, resolveModel } from './providers/index.js';
import type { AdapterContext, PreparedRequest, RemoteOutput } from './providers/types.js';
import { AdapterError } from './providers/types.js';
import { buildPrompt } from './prompt.js';
import {
  ensureDir,
  extFromMime,
  listDirs,
  listFiles,
  newId,
  nowIso,
  paths,
  readJson,
  rel,
  writeJson,
} from './storage.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

const jobs = new Map<string, Job>();
const running = new Map<string, number>(); // providerId -> 正在跑的数量
const MAX_RETRY = 2;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// 取消直接看任务状态：cancelJob 会立刻把状态改成 cancelled，正在跑的流程每一步都检查它
const isCancelled = (job: Job) => job.status === 'cancelled';

function activeFile(id: string) {
  return path.join(paths.jobsActive(), `${id}.json`);
}

async function persist(job: Job) {
  jobs.set(job.id, job);
  const done = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
  if (done) {
    const month = (job.finishedAt || nowIso()).slice(0, 7);
    await writeJson(path.join(paths.jobsDone(month), `${job.id}.json`), job);
    await fsp.rm(activeFile(job.id), { force: true });
  } else {
    await writeJson(activeFile(job.id), job);
  }
  events.emit('event', { type: 'job', job });
}

function estimateCost(job: Job, price?: { unit: string; amount: number }): number | undefined {
  if (!price || !(price.amount >= 0)) return undefined;
  const p = job.request.params;
  if (price.unit === 'per_second') return price.amount * (Number(p.duration) || 5);
  if (price.unit === 'per_image') return price.amount * (Number(p.count) || 1);
  return price.amount;
}

/** 入队。视频选了「条数 > 1」时拆成多个任务，每个任务出一条。 */
export async function enqueue(req: GenerateRequest): Promise<Job[]> {
  const { provider, model } = await resolveModel(req.modelId);
  const n = model.capability === 'video' ? Math.max(1, Math.min(4, Number(req.params.count) || 1)) : 1;
  const created: Job[] = [];
  for (let i = 0; i < n; i++) {
    const request: GenerateRequest = { ...req, params: { ...req.params, ...(model.capability === 'video' ? { count: 1 } : {}) } };
    const job: Job = {
      id: newId('job_'),
      status: 'queued',
      capability: model.capability,
      providerId: provider.id,
      modelName: `${provider.name} · ${model.name}`,
      request,
      attempts: 0,
      createdAt: nowIso(),
    };
    job.cost = estimateCost(job, model.price);
    job.costEstimated = job.cost !== undefined;
    await persist(job);
    created.push(job);
  }
  pump();
  return created;
}

function pump() {
  const queued = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of queued) {
    resolveModel(job.request.modelId)
      .then(({ provider }) => {
        const cur = running.get(provider.id) || 0;
        if (cur >= provider.concurrency || job.status !== 'queued') return;
        running.set(provider.id, cur + 1);
        job.status = 'running';
        start(job).finally(() => {
          running.set(provider.id, Math.max(0, (running.get(provider.id) || 1) - 1));
          pump();
        });
      })
      .catch(async (e) => {
        if (job.status !== 'queued') return;
        job.status = 'failed';
        job.error = String(e?.message || e);
        job.finishedAt = nowIso();
        await persist(job);
      });
  }
}

async function contextFor(job: Job): Promise<AdapterContext> {
  const { provider, model } = await resolveModel(job.request.modelId);
  return { provider, model, apiKey: apiKeyOf(provider) };
}

async function start(job: Job) {
  job.startedAt = nowIso();
  job.note = '提交中';
  await persist(job);
  let ctx: AdapterContext;
  let prepared: PreparedRequest;
  try {
    ctx = await contextFor(job);
    const adapter = ADAPTERS[ctx.provider.type];
    prepared = {
      capability: job.capability,
      mode: job.request.mode,
      prompt: await buildPrompt(job.request, adapter, ctx.model),
      refs: job.request.refs,
      params: job.request.params,
    };
    job.finalPrompt = prepared.prompt;
  } catch (e: any) {
    return fail(job, e);
  }
  const adapter = ADAPTERS[ctx.provider.type];
  for (;;) {
    if (isCancelled(job)) return;
    job.attempts += 1;
    try {
      const r = await adapter.submit(ctx, prepared);
      if (isCancelled(job)) {
        // 提交途中点了取消：远端任务已经建好，顺手取消掉，免得白白跑完扣费
        if (r.kind === 'pending') adapter.cancel?.(ctx, r.remoteId).catch(() => undefined);
        return;
      }
      if (r.kind === 'done') return succeed(job, r.outputs, r.cost);
      job.remoteId = r.remoteId;
      job.note = '已提交，等待结果';
      await persist(job);
      return pollLoop(job, ctx);
    } catch (e: any) {
      if (isCancelled(job)) return;
      if (e instanceof AdapterError && e.retryable && job.attempts <= MAX_RETRY) {
        job.note = `出错重试（第 ${job.attempts} 次）：${e.message}`;
        await persist(job);
        await sleep(2000 * job.attempts);
        continue;
      }
      if (e instanceof AdapterError && e.uncertain) {
        return fail(job, new Error(`${e.message}。厂商可能已经收下这个任务并扣费，为避免重复扣费没有自动重试，请先到厂商控制台确认`));
      }
      return fail(job, e);
    }
  }
}

async function pollLoop(job: Job, ctx: AdapterContext) {
  const adapter = ADAPTERS[ctx.provider.type];
  if (!adapter.poll) return fail(job, new Error('这个适配器不支持查询任务'));
  // 从这一轮开始查询时起算：服务重启后接着查的任务不会因为「关机那一夜」直接判超时
  const startAt = Date.now();
  let delay = 3000;
  let errors = 0;
  for (;;) {
    await sleep(delay);
    delay = Math.min(15000, Math.round(delay * 1.4));
    if (job.status !== 'running') return;
    try {
      const r = await adapter.poll(ctx, job.remoteId!);
      errors = 0;
      if (job.status !== 'running') return;
      if (r.status === 'succeeded') return succeed(job, r.outputs || [], r.cost);
      if (r.status === 'failed') return fail(job, new Error(r.error || '生成失败'));
      if (Date.now() - startAt > POLL_TIMEOUT_MS) {
        return fail(job, new Error('查了 30 分钟还没出结果，先停止查询。厂商那边可能还在生成，可以在队列里点「重新查询」'));
      }
      if (r.note && r.note !== job.note) {
        job.note = r.note;
        await persist(job);
      }
    } catch (e: any) {
      if (job.status !== 'running') return;
      errors += 1;
      if (errors >= 5) return fail(job, e);
      job.note = `查询出错，稍后再试：${e?.message || e}`;
      await persist(job);
    }
  }
}

async function download(o: RemoteOutput): Promise<{ buf: Buffer; mime: string }> {
  if (o.localFile) {
    const buf = await fsp.readFile(o.localFile);
    await fsp.rm(o.localFile, { force: true });
    return { buf, mime: o.mime || '' };
  }
  if (o.base64) return { buf: Buffer.from(o.base64, 'base64'), mime: o.mime || '' };
  if (!o.url) throw new Error('结果里既没有链接也没有内容');
  if (o.url.startsWith('data:')) {
    const [head, b64] = o.url.split(',', 2);
    return { buf: Buffer.from(b64, 'base64'), mime: head.slice(5).split(';')[0] };
  }
  // 厂商的结果链接是带签名的临时链接，不能带我们的 key
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(o.url, { signal: AbortSignal.timeout(300_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { buf: Buffer.from(await resp.arrayBuffer()), mime: resp.headers.get('content-type') || o.mime || '' };
    } catch (e: any) {
      lastErr = String(e?.message || e);
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`结果下载失败：${lastErr}`);
}

async function nextVersionNo(dir: string): Promise<number> {
  try {
    const names = await fsp.readdir(dir);
    const nums = names.map((n) => Number(n.match(/^v(\d+)\./)?.[1] || 0));
    return Math.max(0, ...nums) + 1;
  } catch {
    return 1;
  }
}

// 同一个节点的结果排队落盘，避免两条同时完成时版本号撞车
const nodeLocks = new Map<string, Promise<void>>();

function succeed(job: Job, outs: RemoteOutput[], cost?: number): Promise<void> {
  const key = `${job.request.projectId}/${job.request.episodeId}/${job.request.nodeId}`;
  const prev = nodeLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(() => saveOutputs(job, outs, cost));
  nodeLocks.set(key, next);
  next.finally(() => {
    if (nodeLocks.get(key) === next) nodeLocks.delete(key);
  });
  return next;
}

async function saveOutputs(job: Job, outs: RemoteOutput[], cost?: number) {
  try {
    const { projectId, episodeId, nodeId } = job.request;
    const dir = paths.nodeAssets(projectId, episodeId, nodeId);
    await ensureDir(dir);
    // 先全部下载完，确认没被取消再落盘，免得「已取消」的任务把文件塞进节点
    const fetched: { o: RemoteOutput; buf?: Buffer; mime?: string }[] = [];
    for (const o of outs) fetched.push(o.kind === 'text' ? { o } : { o, ...(await download(o)) });
    if (isCancelled(job)) return;
    const saved: OutputItem[] = [];
    for (const { o, buf, mime } of fetched) {
      if (!buf) {
        saved.push({ kind: 'text', text: o.text || '' });
        continue;
      }
      const fallback = o.kind === 'video' ? '.mp4' : o.kind === 'audio' ? '.mp3' : '.png';
      const ext = extFromMime(mime || o.mime || '', fallback);
      const no = await nextVersionNo(dir);
      const file = path.join(dir, `v${no}${ext}`);
      await fsp.writeFile(file, buf);
      await writeJson(path.join(dir, `v${no}.json`), {
        jobId: job.id,
        model: job.modelName,
        prompt: job.request.prompt,
        finalPrompt: job.finalPrompt,
        params: job.request.params,
        refs: job.request.refs.map((r) => r.file),
        createdAt: nowIso(),
      });
      saved.push({ kind: o.kind, file: rel(file) });
    }
    if (isCancelled(job)) return;
    job.outputs = saved;
    job.status = 'succeeded';
    job.note = undefined;
    job.error = undefined;
    if (cost !== undefined) {
      job.cost = cost;
      job.costEstimated = false;
    }
    job.finishedAt = nowIso();
    await persist(job);
  } catch (e) {
    await fail(job, e);
  }
}

async function fail(job: Job, e: any) {
  if (isCancelled(job)) return;
  job.status = 'failed';
  job.error = String(e?.message || e);
  job.note = undefined;
  job.finishedAt = nowIso();
  await persist(job);
}

export async function cancelJob(id: string): Promise<Job | undefined> {
  const job = jobs.get(id);
  if (!job || !['queued', 'running'].includes(job.status)) return job;
  // 先改状态：正在跑的提交、轮询、下载看到 cancelled 就会停下，不会再把它改回成功
  const remoteId = job.status === 'running' ? job.remoteId : undefined;
  job.status = 'cancelled';
  job.note = undefined;
  job.finishedAt = nowIso();
  await persist(job);
  if (remoteId) {
    // 远端取消可能要等十几秒，放后台做；取消不了就只是不再查询
    contextFor(job)
      .then((ctx) => ADAPTERS[ctx.provider.type].cancel?.(ctx, remoteId))
      .catch(() => undefined);
  }
  return job;
}

export function listJobs(filter: { projectId?: string; episodeId?: string; limit?: number } = {}): Job[] {
  return [...jobs.values()]
    .filter((j) => !filter.projectId || j.request.projectId === filter.projectId)
    .filter((j) => !filter.episodeId || j.request.episodeId === filter.episodeId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, filter.limit ?? 500);
}

export function getJob(id: string) {
  return jobs.get(id);
}

/** 启动时恢复：排队的继续排；已提交的继续查询；没提交成功的标失败 */
export async function recover() {
  for (const month of await listDirs(paths.jobsDoneRoot())) {
    for (const f of await listFiles(paths.jobsDone(month))) {
      const j = await readJson<Job | null>(f, null);
      if (j) jobs.set(j.id, j);
    }
  }
  if (!fs.existsSync(paths.jobsActive())) return;
  for (const f of await listFiles(paths.jobsActive())) {
    const j = await readJson<Job | null>(f, null);
    if (!j) continue;
    jobs.set(j.id, j);
    if (j.status === 'queued') continue;
    if (j.status === 'running' && j.remoteId) {
      contextFor(j)
        .then((ctx) => {
          const cur = running.get(ctx.provider.id) || 0;
          running.set(ctx.provider.id, cur + 1);
          return pollLoop(j, ctx).finally(() => {
            running.set(ctx.provider.id, Math.max(0, (running.get(ctx.provider.id) || 1) - 1));
            pump();
          });
        })
        .catch((e) => fail(j, e));
    } else if (j.status === 'running') {
      await fail(j, new Error('服务重启时这个任务还没提交成功，请重新生成'));
    }
  }
  pump();
}

/** 同步跑一次文本模型（翻译提示词这类小事，不进画布） */
export async function runQuickText(modelId: string, prompt: string): Promise<string> {
  const { provider, model } = await resolveModel(modelId);
  if (model.capability !== 'text') throw new Error('请选一个文本模型');
  const ctx: AdapterContext = { provider, model, apiKey: apiKeyOf(provider) };
  const adapter = ADAPTERS[provider.type];
  const r = await adapter.submit(ctx, { capability: 'text', mode: 'chat', prompt, refs: [], params: { temperature: 0.2 } });
  if (r.kind === 'done') return r.outputs.find((o) => o.kind === 'text')?.text || '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const p = await adapter.poll!(ctx, r.remoteId);
    if (p.status === 'succeeded') return p.outputs?.find((o) => o.kind === 'text')?.text || '';
    if (p.status === 'failed') throw new Error(p.error || '失败');
  }
  throw new Error('超时');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
