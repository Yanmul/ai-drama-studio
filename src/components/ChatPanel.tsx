// 对话框：右侧弹出的聊天面板（顶栏「对话」按钮开关）。
// 多个对话、记录存在本机；能发图片；回复用 Markdown 显示，能复制、重新生成、放到画布；
// 在画布里打开时会把当前项目的画风、设定库、这一集的脚本告诉模型。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  ImagePlus,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { Chat, ChatMessage, ChatSummary } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp } from '../context';
import { confirmDialog, promptDialog } from './Dialog';
import { Popover } from './Popover';

const LAST_CHAT = 'chatLast';
const LAST_MODEL = 'chatModel';
const WITH_PROJECT = 'chatWithProject';

const SUGGESTIONS = ['帮我构思一个 1 分钟的校园短剧，给出分镜表', '把下面这段剧情拆成 6 个镜头，每个镜头写一条生视频提示词：', '帮我设计女主角的外貌，写成生图提示词'];

/** 画布在监听这个事件：把一段文字变成文本 / 脚本节点 */
export function addTextToCanvas(text: string, kind: 'text' | 'script') {
  window.dispatchEvent(new CustomEvent('ads:add-text-node', { detail: { text, kind } }));
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="chat-act"
      title="复制"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? <Check size={13} /> : <Copy size={13} />} {label}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in (node as any)) return textOf((node as any).props.children);
  return '';
}

const Markdown = ({ text }: { text: string }) => (
  <div className="md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
        // 代码块右上角放复制按钮（生图 / 生视频提示词一般放在代码块里）
        pre: ({ node: _n, children, ...p }) => (
          <div className="md-pre">
            <CopyButton text={textOf(children).replace(/\n$/, '')} label="复制" />
            <pre {...p}>{children}</pre>
          </div>
        ),
        table: ({ node: _n, ...p }) => (
          <div className="md-table">
            <table {...p} />
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
);

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { project, episode, models, toast, openModels } = useApp();
  const textModels = useMemo(() => models.filter((m) => m.capability === 'text'), [models]);
  const [list, setList] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [modelId, setModelId] = useState('');
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState<string | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [withProject, setWithProject] = useState(() => localStorage.getItem(WITH_PROJECT) !== '0');
  const [dragOver, setDragOver] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 用户没往上翻时，新内容自动滚到底
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = streaming !== null;
  const inCanvas = Boolean(project && episode);

  // 默认模型：这个对话上次用的 → 上次选的 → 名字带 opus 的 → 第一个文本模型
  useEffect(() => {
    if (!textModels.length) return;
    const ok = (id?: string | null) => Boolean(id && textModels.some((m) => m.id === id));
    const pick =
      [chat?.modelId, localStorage.getItem(LAST_MODEL)].find(ok) ||
      textModels.find((m) => /opus/i.test(m.name))?.id ||
      textModels[0].id;
    setModelId((cur) => (ok(cur) && !chat?.modelId ? cur : pick!));
  }, [textModels, chat?.id]);

  const refreshList = () => api.chats().then(setList).catch(() => undefined);
  useEffect(() => {
    refreshList();
    const last = localStorage.getItem(LAST_CHAT);
    if (last) api.chat(last).then(setChat).catch(() => localStorage.removeItem(LAST_CHAT));
    setTimeout(() => ta.current?.focus(), 50);
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat?.messages.length, streaming]);

  // 输入框跟着内容变高（最多 8 行左右）
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [input]);

  const open = (id: string) => {
    if (busy) return;
    setListOpen(false);
    api
      .chat(id)
      .then((c) => {
        setChat(c);
        setImages([]);
        stick.current = true;
        localStorage.setItem(LAST_CHAT, c.id);
      })
      .catch((e) => toast(e.message, 'error'));
  };

  const newChat = () => {
    if (busy) return;
    setChat(null);
    setImages([]);
    setInput('');
    setListOpen(false);
    localStorage.removeItem(LAST_CHAT);
    ta.current?.focus();
  };

  /** 还没有对话（第一次发消息 / 第一次加图）时才建 */
  const ensureChat = async (): Promise<Chat> => {
    if (chat) return chat;
    const c = await api.createChat(modelId || undefined);
    setChat(c);
    localStorage.setItem(LAST_CHAT, c.id);
    return c;
  };

  const addImages = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setUploading((n) => n + imgs.length);
    try {
      const c = await ensureChat();
      for (const f of imgs) {
        try {
          const r = await api.chatUpload(c.id, f);
          setImages((xs) => [...xs, r.file]);
        } catch (e: any) {
          toast(e.message, 'error');
        } finally {
          setUploading((n) => n - 1);
        }
      }
    } catch (e: any) {
      toast(e.message, 'error');
      setUploading(0);
    }
  };

  const run = async (body: { text?: string; images?: string[]; regenerate?: boolean }) => {
    if (!modelId) return toast('先选一个模型', 'error');
    let c: Chat;
    try {
      c = await ensureChat();
    } catch (e: any) {
      return toast(e.message, 'error');
    }
    localStorage.setItem(LAST_MODEL, modelId);
    const ctrl = new AbortController();
    abort.current = ctrl;
    stick.current = true;
    setStreaming('');
    let acc = '';
    let finished = false;
    try {
      await api.chatSend(
        c.id,
        { ...body, modelId, projectId: withProject ? project?.id : undefined, episodeId: withProject ? episode?.id : undefined },
        (ev) => {
          if (ev.t === 'user') setChat((x) => (x ? { ...x, messages: [...x.messages, ev.message] } : x));
          else if (ev.t === 'delta') {
            acc += ev.text;
            setStreaming(acc);
          } else if (ev.t === 'done' || ev.t === 'error') {
            finished = true;
            const m = ev.message;
            if (m && (m.text || m.error)) setChat((x) => (x ? { ...x, title: ev.t === 'done' ? ev.title : x.title, messages: [...x.messages, m] } : x));
            if (ev.t === 'error' && !m) toast(ev.error, 'error');
          }
        },
        ctrl.signal,
      );
      // 点了停止：服务器会把已经写出来的部分存下来，这里先照样显示
      if (!finished && acc) {
        const m: ChatMessage = { id: `local_${Date.now()}`, role: 'assistant', text: acc, stopped: true, createdAt: new Date().toISOString() };
        setChat((x) => (x ? { ...x, messages: [...x.messages, m] } : x));
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      abort.current = null;
      setStreaming(null);
      refreshList();
    }
  };

  const send = () => {
    const text = input.trim();
    if (busy || uploading || (!text && !images.length)) return;
    setInput('');
    setImages([]);
    run({ text, images });
  };

  const regenerate = () => {
    if (busy || !chat) return;
    setChat({ ...chat, messages: chat.messages.slice(0, chat.messages.map((m) => m.role).lastIndexOf('user') + 1) });
    run({ regenerate: true });
  };

  const rename = async (c: ChatSummary | Chat) => {
    const title = await promptDialog({ title: '对话改名', defaultValue: c.title });
    if (!title) return;
    try {
      await api.updateChat(c.id, { title });
      if (chat?.id === c.id) setChat({ ...chat, title });
      refreshList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (c: ChatSummary) => {
    const ok = await confirmDialog({ title: `删除对话「${c.title}」？`, message: '聊天记录和里面发过的图片都会删掉，找不回来。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteChat(c.id);
      if (chat?.id === c.id) newChat();
      refreshList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const msgs = chat?.messages || [];
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant');

  return (
    <aside
      className={`chat-panel ${dragOver ? 'drag' : ''}`}
      onKeyDown={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addImages([...e.dataTransfer.files]);
      }}
    >
      <header className="chat-head">
        <span className="chip-wrap chat-title-wrap">
          <button className="chat-title" onClick={() => setListOpen(!listOpen)} title="切换对话">
            <span>{chat?.title || '新对话'}</span> <ChevronDown size={14} />
          </button>
          <Popover open={listOpen} onClose={() => setListOpen(false)} placement="bottom" className="list-pop chat-list-pop">
            {list.length === 0 && <div className="muted pad">还没有聊过</div>}
            {list.map((c) => (
              <div key={c.id} className={`chat-list-item ${chat?.id === c.id ? 'on' : ''}`}>
                <button className="chat-list-open" onClick={() => open(c.id)}>
                  <span className="chat-list-name">{c.title}</span>
                  <span className="muted">{new Date(c.updatedAt).toLocaleDateString()}</span>
                </button>
                <button className="icon" title="改名" onClick={() => rename(c)}>
                  <Pencil size={13} />
                </button>
                <button className="icon" title="删除" onClick={() => remove(c)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </Popover>
        </span>
        <span className="spacer" />
        <button className="icon" title="新对话" onClick={newChat} disabled={busy}>
          <MessageSquarePlus size={16} />
        </button>
        <button className="icon" title="关闭" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div
        className="chat-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {textModels.length === 0 ? (
          <div className="chat-empty">
            <Sparkles size={26} />
            <div className="chat-empty-title">还没有能对话的模型</div>
            <div className="muted">去「模型管理」点「添加服务商 → Anthropic」，填上 key，就能用 Claude 了</div>
            <button className="primary" onClick={openModels}>
              打开模型管理
            </button>
          </div>
        ) : msgs.length === 0 && !busy ? (
          <div className="chat-empty">
            <Sparkles size={26} />
            <div className="chat-empty-title">想做什么短剧？</div>
            <div className="chat-sugs">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => (setInput(s), ta.current?.focus())}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m, i) =>
            m.role === 'user' ? (
              <div key={m.id} className="chat-msg user">
                {m.images?.length ? (
                  <div className="chat-imgs">
                    {m.images.map((f) => (
                      <a key={f} href={fileUrl(f)} target="_blank" rel="noreferrer">
                        <img src={fileUrl(f)} />
                      </a>
                    ))}
                  </div>
                ) : null}
                {m.text && <div className="chat-bubble">{m.text}</div>}
              </div>
            ) : (
              <div key={m.id} className="chat-msg assistant">
                {m.text && <Markdown text={m.text} />}
                {m.stopped && <div className="chat-note">{m.error ? '' : '（回复没写完：被停止了，或超出了长度上限）'}</div>}
                {m.error && <div className="chat-error">{m.error}</div>}
                <div className="chat-acts">
                  {m.text && <CopyButton text={m.text} label="复制" />}
                  {m.text && inCanvas && (
                    <span className="chip-wrap">
                      <button className="chat-act" title="把这条回复变成画布上的节点" onClick={() => setCanvasMenu(canvasMenu === m.id ? null : m.id)}>
                        <LayoutDashboard size={13} /> 放到画布
                      </button>
                      <Popover open={canvasMenu === m.id} onClose={() => setCanvasMenu(null)} placement="top" className="list-pop">
                        <button className="list-item" onClick={() => (addTextToCanvas(m.text, 'text'), setCanvasMenu(null))}>
                          文本节点
                        </button>
                        <button className="list-item" onClick={() => (addTextToCanvas(m.text, 'script'), setCanvasMenu(null))}>
                          脚本节点
                        </button>
                      </Popover>
                    </span>
                  )}
                  {i === lastAssistant && !busy && (
                    <button className="chat-act" title="重新生成这条回复" onClick={regenerate}>
                      <RotateCcw size={13} /> 重新生成
                    </button>
                  )}
                  {m.model && <span className="chat-model muted">{m.model}</span>}
                </div>
              </div>
            ),
          )
        )}
        {busy && (
          <div className="chat-msg assistant">
            {streaming ? <Markdown text={streaming} /> : null}
            <div className="chat-typing">
              <Loader2 size={14} className="spin" /> {streaming ? '正在写…' : '正在想…'}
            </div>
          </div>
        )}
      </div>

      <div className="chat-input">
        <div className="chat-box" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), ta.current?.focus())}>
        {(images.length > 0 || uploading > 0) && (
          <div className="chat-pending">
            {images.map((f) => (
              <span key={f} className="chat-pending-img">
                <img src={fileUrl(f)} />
                <button title="不发这张" onClick={() => setImages((xs) => xs.filter((x) => x !== f))}>
                  <X size={11} />
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className="chat-pending-img loading">
                <Loader2 size={16} className="spin" />
              </span>
            )}
          </div>
        )}
        <textarea
          ref={ta}
          rows={3}
          value={input}
          placeholder={busy ? '正在回复…' : '问点什么，Enter 发送，Shift + Enter 换行；可以粘贴或拖入图片'}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              addImages(files);
            }
          }}
          onKeyDown={(e) => {
            // 中文输入法选字时按的回车不算发送
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-tools">
          <button className="icon" title="发图片（也可以直接粘贴、拖进来）" onClick={() => fileInput.current?.click()} disabled={!textModels.length}>
            <ImagePlus size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              addImages([...(e.target.files || [])]);
              e.target.value = '';
            }}
          />
          {project && (
            <button
              className={`chat-ctx ${withProject ? 'on' : ''}`}
              title={withProject ? '会把项目的画风、设定库、这一集的脚本告诉模型；点一下关掉' : '不带项目信息；点一下打开'}
              onClick={() => {
                localStorage.setItem(WITH_PROJECT, withProject ? '0' : '1');
                setWithProject(!withProject);
              }}
            >
              <FolderOpen size={13} /> {withProject ? `带上「${project.name}」` : '不带项目信息'}
            </button>
          )}
          <span className="spacer" />
          {textModels.length > 0 && (
            <span className="chip-wrap chat-model-wrap">
              <button className="sel chat-model-btn" title="换模型" onClick={() => setModelMenu(!modelMenu)}>
                <Sparkles size={13} />
                <span className="sel-text">{textModels.find((m) => m.id === modelId)?.name || '选模型'}</span>
                <ChevronDown size={13} />
              </button>
              <Popover open={modelMenu} onClose={() => setModelMenu(false)} placement="top" className="right list-pop chat-model-pop">
                {textModels.map((m) => (
                  <button
                    key={m.id}
                    className={`list-item ${m.id === modelId ? 'on' : ''}`}
                    onClick={() => {
                      setModelId(m.id);
                      setModelMenu(false);
                    }}
                  >
                    <span className="chat-model-name">{m.name}</span>
                    <span className="muted">{m.providerName}</span>
                    {m.id === modelId && <Check size={14} className="chat-model-check" />}
                  </button>
                ))}
              </Popover>
            </span>
          )}
          {busy ? (
            <button className="chat-send stop" title="停止" onClick={() => abort.current?.abort()}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="chat-send" title="发送（Enter）" onClick={send} disabled={!!uploading || (!input.trim() && !images.length) || !modelId}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
        </div>
      </div>
      {dragOver && <div className="chat-drop">松手发图片</div>}
    </aside>
  );
}
