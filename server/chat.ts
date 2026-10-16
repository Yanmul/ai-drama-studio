// 对话框：聊天记录存在 workspace/chats/<id>.json，用户发的图存在 workspace/chats/files/<id>/。
// 发消息时边生成边推给前端（一行一个 JSON），生成完 / 停止 / 出错都会把结果存下来。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Chat, ChatMessage, ChatStreamEvent, ChatSummary } from '../shared/types.js';
import { listCharacters, listEpisodes, listProjects, readCanvas } from './projects.js';
import { anthropicChat, openaiChatStream, type ChatRequest, type ChatResult, type ChatTurn } from './providers/chatStream.js';
import { ANTHROPIC_DEFAULT_BASE } from './providers/anthropic.js';
import { apiKeyOf, resolveModel } from './providers/index.js';
import { ARK_DEFAULT_BASE } from './providers/volcengine.js';
import { absFromRel, listFiles, newId, nowIso, paths, readJson, writeJson } from './storage.js';

const NEW_TITLE = '新对话';
/** 太早的消息不再发给模型（省钱，也避免超过上下文长度）；记录里还在 */
const MAX_TURNS = 40;

export async function listChats(): Promise<ChatSummary[]> {
  const files = await listFiles(paths.chats());
  const out: ChatSummary[] = [];
  for (const f of files) {
    const c = await readJson<Chat | null>(f, null);
    if (c?.id) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getChat(id: string): Promise<Chat> {
  const c = await readJson<Chat | null>(paths.chat(id), null);
  if (!c) throw new Error('这个对话不存在了');
  return c;
}

export async function createChat(modelId?: string): Promise<Chat> {
  const now = nowIso();
  const c: Chat = { id: newId('chat_'), title: NEW_TITLE, modelId, messages: [], createdAt: now, updatedAt: now };
  await writeJson(paths.chat(c.id), c);
  return c;
}

export async function updateChat(id: string, patch: { title?: string; modelId?: string }): Promise<Chat> {
  const c = await getChat(id);
  if (patch.title?.trim()) c.title = patch.title.trim().slice(0, 60);
  if (patch.modelId) c.modelId = patch.modelId;
  await writeJson(paths.chat(id), c);
  return c;
}

export async function deleteChat(id: string) {
  await fsp.rm(paths.chat(id), { force: true });
  await fsp.rm(paths.chatFiles(id), { recursive: true, force: true });
}

/** 系统提示：助手的身份 + 当前项目的信息（画风、设定库、这一集的脚本） */
async function systemPrompt(projectId?: string, episodeId?: string): Promise<string> {
  const lines = [
    '你是「AI 短剧工作台」里的创作助手，帮用户做 AI 短剧：构思剧情、写剧本和分镜、设计角色 / 场景 / 道具、写给生图和生视频模型的提示词、改台词。',
    '用简体中文回答，用 Markdown 排版。要交给生图 / 生视频模型的提示词，单独放进代码块，方便用户复制。',
  ];
  if (!projectId) return lines.join('\n');
  const project = (await listProjects()).find((p) => p.id === projectId);
  if (!project) return lines.join('\n');
  lines.push('', `## 用户当前打开的项目：「${project.name}」`);
  if (project.style) lines.push(`- 画风：${project.style}`);
  lines.push(`- 默认画幅比例：${project.ratio}`);
  const settings = await listCharacters(projectId).catch(() => []);
  if (settings.length) {
    const word = { character: '角色', scene: '场景', prop: '道具' } as const;
    lines.push('', '### 设定库');
    for (const s of settings) lines.push(`- ${word[s.kind || 'character']}「${s.name}」：${s.description || '（没写描述）'}`);
  }
  if (episodeId) {
    const ep = (await listEpisodes(projectId).catch(() => [])).find((e) => e.id === episodeId);
    const canvas = await readCanvas(projectId, episodeId).catch(() => null);
    const scripts = (canvas?.nodes || []).filter((n) => n.data.kind === 'script' && String(n.data.text || '').trim());
    if (scripts.length) {
      lines.push('', `### 当前这一集（${ep?.title || episodeId}）画布上的脚本`);
      let budget = 8000;
      for (const n of scripts) {
        const t = String(n.data.text).trim().slice(0, budget);
        budget -= t.length;
        lines.push(`#### ${n.data.title}`, t);
        if (budget <= 0) break;
      }
    }
  }
  return lines.join('\n');
}

async function callModel(modelId: string, req: ChatRequest, onDelta: (t: string) => void, signal: AbortSignal): Promise<{ result: ChatResult; name: string }> {
  const { provider, model } = await resolveModel(modelId);
  if (model.capability !== 'text') throw new Error(`「${model.name}」不是文本模型，不能用来对话`);
  const key = apiKeyOf(provider);
  if (!key) throw new Error(`服务商「${provider.name}」还没填 API key`);
  const bearer = { Authorization: `Bearer ${key}` };
  let result: ChatResult;
  if (provider.type === 'anthropic') result = await anthropicChat(provider.baseUrl || ANTHROPIC_DEFAULT_BASE, key, model.remoteModel, req, onDelta, signal);
  else if (provider.type === 'volcengine') result = await openaiChatStream(provider.baseUrl || ARK_DEFAULT_BASE, bearer, model.remoteModel, req, onDelta, signal);
  else if (provider.type === 'relay' && (model.protocol || 'openai-chat') === 'openai-chat') result = await openaiChatStream(provider.baseUrl, bearer, model.remoteModel, req, onDelta, signal);
  else throw new Error(`「${model.name}」的接口格式不支持对话`);
  return { result, name: model.name };
}

export interface SendInput {
  text?: string;
  images?: string[];
  modelId: string;
  projectId?: string;
  episodeId?: string;
  /** 重新生成最后一条回复（不发新消息） */
  regenerate?: boolean;
}

export async function sendMessage(id: string, input: SendInput, emit: (e: ChatStreamEvent) => void, signal: AbortSignal) {
  const chat = await getChat(id);
  if (!input.modelId) throw new Error('还没有选模型');
  if (input.regenerate) {
    while (chat.messages.at(-1)?.role === 'assistant') chat.messages.pop();
    if (!chat.messages.length) throw new Error('没有可以重新生成的消息');
  } else {
    const text = (input.text || '').trim();
    const images = (input.images || []).filter((f) => f.startsWith(`chats/files/${id}/`) && fs.existsSync(absFromRel(f)));
    if (!text && !images.length) throw new Error('消息是空的');
    const msg: ChatMessage = { id: newId('m_'), role: 'user', text, images: images.length ? images : undefined, createdAt: nowIso() };
    chat.messages.push(msg);
    if (chat.title === NEW_TITLE) chat.title = (text || '图片').replace(/\s+/g, ' ').slice(0, 24);
    emit({ t: 'user', message: msg });
  }
  chat.modelId = input.modelId;
  chat.updatedAt = nowIso();
  await writeJson(paths.chat(id), chat);

  // 出错 / 被停止的回复不带进上下文
  const turns: ChatTurn[] = chat.messages
    .filter((m) => m.role === 'user' || (!m.error && m.text))
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, text: m.text, images: m.images }));
  while (turns[0]?.role === 'assistant') turns.shift(); // 必须以用户消息开头

  let partial = '';
  let modelName = '';
  const reply: ChatMessage = { id: newId('m_'), role: 'assistant', text: '', createdAt: nowIso() };
  try {
    const system = await systemPrompt(input.projectId, input.episodeId);
    const { result, name } = await callModel(
      input.modelId,
      { system, turns },
      (d) => {
        partial += d;
        emit({ t: 'delta', text: d });
      },
      signal,
    );
    modelName = name;
    reply.text = result.text;
    if (result.truncated) reply.stopped = true;
  } catch (e: any) {
    reply.text = partial;
    if (signal.aborted) reply.stopped = true;
    else reply.error = String(e?.message || e);
  }
  reply.model = modelName || (await resolveModel(input.modelId).then((r) => r.model.name).catch(() => undefined));
  // 停止了但一个字都没写出来：不留空消息
  if (reply.text || reply.error) chat.messages.push(reply);
  chat.updatedAt = nowIso();
  await writeJson(paths.chat(id), chat);
  if (reply.error) emit({ t: 'error', error: reply.error, message: reply });
  else emit({ t: 'done', message: reply, title: chat.title });
}
