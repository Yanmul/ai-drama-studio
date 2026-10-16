// 首页（参考 LibTV）：左侧栏只在首页这几页出现
//  首页 —— 新建画布、常用模型 + 快捷入口（一键建好画布和节点）、最近项目
//  项目 —— 全部画布
//  资产 —— 资产库（所有画布共用）
import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  AudioLines,
  Check,
  ChevronRight,
  Clapperboard,
  Eraser,
  Download,
  Film,
  FolderKanban,
  House,
  ImagePlus,
  LayoutGrid,
  ListChecks,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PenLine,
  Plus,
  ScrollText,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react';
import type { Asset, Capability, CleanupStatus, ModelInfo, NodeKind, ProjectSummary } from '../shared/types';
import { api, fileUrl } from './api';
import { useApp, useJobs } from './context';
import { confirmDialog, promptDialog } from './components/Dialog';
import { fileKind } from './lib';

export type HomeView = 'home' | 'projects' | 'assets';

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return day(iso);
}
function day(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const stamp = () => {
  const d = new Date();
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const CAP_ICON: Record<Capability, typeof Film> = { video: Film, image: ImagePlus, audio: AudioLines, text: MessageSquareText };
const CAP_KIND: Record<Capability, NodeKind> = { video: 'video', image: 'image', audio: 'audio', text: 'text' };
const CAP_LABEL: Record<Capability, string> = { video: '视频', image: '图片', audio: '音频', text: '文本' };

/** 快捷入口：建一个新画布，放好节点，打开生成框 */
const TOOLS: { label: string; kind: NodeKind; icon: typeof Film }[] = [
  { label: '视频生成', kind: 'video', icon: Clapperboard },
  { label: '图片生成', kind: 'image', icon: ImagePlus },
  { label: '音频生成', kind: 'audio', icon: AudioLines },
  { label: '剧本创作', kind: 'script', icon: ScrollText },
];

function Cover({ files }: { files: string[] }) {
  if (!files.length)
    return (
      <div className="cover empty">
        <LayoutGrid size={26} strokeWidth={1.3} />
      </div>
    );
  const shown = files.slice(0, files.length >= 4 ? 4 : 1);
  return (
    <div className={`cover n${shown.length}`}>
      {shown.map((f) =>
        fileKind(f) === 'video' ? <video key={f} src={fileUrl(f)} muted preload="metadata" /> : <img key={f} src={fileUrl(f)} loading="lazy" />,
      )}
    </div>
  );
}

export function Home({
  view,
  onNav,
  onOpen,
  onOpenModels,
  onToggleQueue,
  queueOpen,
}: {
  view: HomeView;
  onNav: (v: HomeView) => void;
  onOpen: (pid: string, eid?: string) => void;
  onOpenModels: () => void;
  onToggleQueue: () => void;
  queueOpen: boolean;
}) {
  const { models, toast } = useApp();
  const jobs = useJobs();
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [favs, setFavs] = useState<string[]>([]);

  const load = () => api.home().then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
    api.settings().then((s) => setFavs(s.favoriteModels || []));
  }, []);
  useEffect(() => {
    if (view !== 'assets') load();
  }, [view]);

  const real = models.filter((m) => m.providerId !== 'demo');
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  /** 新建画布；带 kind 时顺便放好一个节点（可指定模型） */
  const create = async (key: string, name: string, node?: { kind: NodeKind; modelId?: string }) => {
    if (creating) return;
    setCreating(key);
    try {
      const p = await api.createProject(name);
      if (node) sessionStorage.setItem('pendingNode', JSON.stringify({ pid: p.id, ...node }));
      onOpen(p.id);
    } catch (e: any) {
      toast(e.message, 'error');
      setCreating(null);
    }
  };

  const saveFavs = async (next: string[]) => {
    setFavs(next);
    try {
      await api.saveSettings({ favoriteModels: next });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="home-shell">
      <aside className="side">
        <div className="logo side-logo">
          <span className="logo-mark">
            <Clapperboard size={16} />
          </span>
          短剧工作台
        </div>
        <nav className="side-nav">
          <button className={view === 'home' ? 'on' : ''} onClick={() => onNav('home')}>
            <House size={17} /> 首页
          </button>
          <button className={view === 'projects' ? 'on' : ''} onClick={() => onNav('projects')}>
            <FolderKanban size={17} /> 项目
          </button>
          <button className={view === 'assets' ? 'on' : ''} onClick={() => onNav('assets')}>
            <Archive size={17} /> 资产
          </button>
        </nav>
        <div className="side-label">创作</div>
        <nav className="side-nav">
          <button onClick={() => create('blank', `未命名画布 ${stamp()}`)}>
            <Plus size={17} /> 新建画布
          </button>
        </nav>
        <span className="spacer" />
        <nav className="side-nav">
          <button onClick={onOpenModels}>
            <SlidersHorizontal size={17} /> 模型管理
          </button>
        </nav>
      </aside>

      <div className="home">
        <header className="home-top">
          <span className="spacer" />
          <CleanupInfo toast={toast} />
          <button className={`ghost ${queueOpen ? 'on' : ''}`} onClick={onToggleQueue}>
            <ListChecks size={15} /> 队列
            {active > 0 ? <span className="pill hot">{active} 生成中</span> : null}
          </button>
          <button className="ghost" onClick={onOpenModels}>
            <SlidersHorizontal size={15} /> 模型
            {real.length ? <span className="pill">已接入 {real.length}</span> : <span className="pill warn">未接入</span>}
          </button>
        </header>

        <main className="home-main">
          {view === 'home' && (
            <>
              <section className="hero" onClick={() => create('blank', `未命名画布 ${stamp()}`)}>
                <div className="hero-dots" />
                <button className="hero-plus" disabled={!!creating} aria-label="新建画布">
                  {creating === 'blank' ? <Loader2 size={28} className="spin" /> : <Plus size={32} strokeWidth={1.6} />}
                </button>
                <div className="hero-title">新建画布创作</div>
              </section>

              <QuickRow
                models={models}
                favs={favs}
                creating={creating}
                onFavs={saveFavs}
                onModel={(m) => create(m.id, `${m.name} ${stamp()}`, { kind: CAP_KIND[m.capability], modelId: m.id })}
                onTool={(t) => create(t.label, `${t.label} ${stamp()}`, { kind: t.kind })}
                onOpenModels={onOpenModels}
              />

              <div className="home-bar">
                <h2>最近项目</h2>
                <span className="spacer" />
                {items && items.length > 0 && (
                  <button className="see-all" onClick={() => onNav('projects')}>
                    查看全部 <ChevronRight size={15} />
                  </button>
                )}
              </div>
              {!items && (
                <div className="home-empty">
                  <Loader2 className="spin" size={18} /> 加载中…
                </div>
              )}
              {items && items.length === 0 && <div className="home-empty">还没有项目，点上面「新建画布创作」开始</div>}
              <div className="recent">
                {(items || []).slice(0, 6).map((p) => (
                  <div key={p.id} className="recent-card" role="button" tabIndex={0} onClick={() => onOpen(p.id, p.lastEpisodeId)} onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id, p.lastEpisodeId)}>
                    <span className="recent-cover">
                      {p.covers[0] ? (
                        fileKind(p.covers[0]) === 'video' ? (
                          <video src={fileUrl(p.covers[0])} muted preload="metadata" />
                        ) : (
                          <img src={fileUrl(p.covers[0])} loading="lazy" />
                        )
                      ) : (
                        <LayoutGrid size={20} strokeWidth={1.4} />
                      )}
                    </span>
                    <span className="recent-info">
                      <span className="recent-name">
                        {p.starred && <Star size={13} fill="currentColor" className="star-mark" />}
                        {p.name}
                      </span>
                      <span className="recent-meta">
                        {ago(p.updatedAt)} · {p.nodeCount} 个节点
                      </span>
                    </span>
                    <ProjectMenu project={p} reload={load} />
                  </div>
                ))}
              </div>
            </>
          )}

          {view === 'projects' && <ProjectsPage items={items} reload={load} onOpen={onOpen} />}
          {view === 'assets' && <AssetsPage />}
        </main>
      </div>
    </div>
  );
}

// —— 常用模型 + 快捷入口 ——
function QuickRow({
  models,
  favs,
  creating,
  onFavs,
  onModel,
  onTool,
  onOpenModels,
}: {
  models: ModelInfo[];
  favs: string[];
  creating: string | null;
  onFavs: (f: string[]) => void;
  onModel: (m: ModelInfo) => void;
  onTool: (t: (typeof TOOLS)[number]) => void;
  onOpenModels: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const favModels = favs.map((id) => models.find((m) => m.id === id)).filter(Boolean) as ModelInfo[];
  const real = models.filter((m) => m.providerId !== 'demo');
  const pickList = real.length ? real : models;

  useEffect(() => {
    if (!picking) return;
    const close = () => setPicking(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [picking]);

  return (
    <div className="quick">
      {favModels.map((m) => {
        const Icon = CAP_ICON[m.capability];
        return (
          <button key={m.id} className="quick-item" onClick={() => onModel(m)} title={`${m.providerName} · ${CAP_LABEL[m.capability]}模型\n点一下：新建画布并用这个模型生成`}>
            <span className="quick-icon model">{creating === m.id ? <Loader2 size={20} className="spin" /> : <Icon size={21} />}</span>
            <span className="quick-label">{m.name}</span>
          </button>
        );
      })}

      <div className="quick-fav-wrap">
        <button className="quick-item" onClick={() => setPicking(!picking)} title="选择要放在这里的常用模型">
          <span className={`quick-icon dashed ${favModels.length ? '' : 'pulse'}`}>
            <Star size={19} />
          </span>
          <span className="quick-label">{favModels.length ? '管理常用' : '添加常用模型'}</span>
        </button>
        {picking && (
          <div className="fav-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="fav-head">
              <b>常用模型</b>
              <span className="muted">勾上的会出现在首页</span>
            </div>
            {pickList.length === 0 && <div className="muted pad">还没有可用的模型</div>}
            {(['video', 'image', 'audio', 'text'] as Capability[]).map((cap) => {
              const list = pickList.filter((m) => m.capability === cap);
              if (!list.length) return null;
              return (
                <div key={cap} className="fav-group">
                  <div className="fav-cap">{CAP_LABEL[cap]}</div>
                  {list.map((m) => {
                    const on = favs.includes(m.id);
                    return (
                      <button key={m.id} className={`fav-row ${on ? 'on' : ''}`} onClick={() => onFavs(on ? favs.filter((x) => x !== m.id) : [...favs, m.id])}>
                        <span className="fav-check">{on && <Check size={12} strokeWidth={3} />}</span>
                        <span className="fav-name">{m.name}</span>
                        <span className="muted">{m.providerName}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <button
              className="fav-more"
              onClick={() => {
                setPicking(false);
                onOpenModels();
              }}
            >
              <SlidersHorizontal size={13} /> 接入更多模型
            </button>
          </div>
        )}
      </div>

      <span className="quick-sep" />

      {TOOLS.map((t) => (
        <button key={t.label} className="quick-item" onClick={() => onTool(t)} title={`新建画布并放好一个${t.label === '剧本创作' ? '脚本' : ''}节点`}>
          <span className="quick-icon">{creating === t.label ? <Loader2 size={20} className="spin" /> : <t.icon size={21} />}</span>
          <span className="quick-label">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// —— 项目：全部画布 ——
function ProjectsPage({ items, reload, onOpen }: { items: ProjectSummary[] | null; reload: () => void; onOpen: (pid: string, eid?: string) => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const shown = useMemo(() => (items || []).filter((p) => !q || p.name.includes(q)), [items, q]);
  return (
    <>
      <div className="page-head">
        <h1>项目</h1>
        <span className="muted">{items ? `${items.length} 个` : ''}</span>
        <span className="spacer" />
        <div className="home-search">
          <Search size={14} />
          <input placeholder="搜索项目" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!items && (
        <div className="home-empty">
          <Loader2 className="spin" size={18} /> 加载中…
        </div>
      )}
      {items && shown.length === 0 && <div className="home-empty">{q ? '没有找到' : '还没有项目'}</div>}
      <div className="cards">
        {shown.map((p) => (
          <div key={p.id} className="card" onClick={() => onOpen(p.id, p.lastEpisodeId)}>
            <Cover files={p.covers} />
            <div className="card-info">
              <div className="card-name" title={p.name}>
                {p.starred && <Star size={13} fill="currentColor" className="star-mark" />}
                {p.name}
              </div>
              <div className="card-meta">
                {ago(p.updatedAt)} · {p.nodeCount} 个节点{p.episodeCount > 1 ? ` · ${p.episodeCount} 集` : ''}
              </div>
            </div>
            <ProjectMenu project={p} reload={reload} />
          </div>
        ))}
      </div>
    </>
  );
}

// —— 资产库 ——
function AssetsPage() {
  const { toast } = useApp();
  const [items, setItems] = useState<Asset[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'audio' | 'text'>('all');
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const load = () => api.assets().then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  const isText = (a: Asset) => a.kind === 'text' || a.kind === 'script';
  const shown = (items || []).filter(
    (a) => (filter === 'all' || (filter === 'text' ? isText(a) : a.kind === filter)) && (!q || a.name.includes(q) || a.text?.includes(q)),
  );
  const download = (a: Asset) => {
    const el = document.createElement('a');
    if (a.file) {
      el.href = fileUrl(a.file);
      el.download = a.name + (a.file.match(/\.[a-z0-9]+$/i)?.[0] || '');
    } else {
      el.href = URL.createObjectURL(new Blob([a.text || ''], { type: 'text/plain;charset=utf-8' }));
      el.download = `${a.name}.txt`;
    }
    el.click();
  };
  return (
    <>
      <div className="page-head">
        <h1>资产</h1>
        <span className="muted">所有画布共用 · 在画布里框选节点 →「保存到资产」</span>
        <span className="spacer" />
        <div className="home-search">
          <Search size={14} />
          <input placeholder="搜索资产" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="seg page-seg">
        {(['all', 'image', 'video', 'audio', 'text'] as const).map((k) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {{ all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本' }[k]}
          </button>
        ))}
      </div>
      {!items && (
        <div className="home-empty">
          <Loader2 className="spin" size={18} /> 加载中…
        </div>
      )}
      {items && shown.length === 0 && (
        <div className="home-empty">{items.length ? '没有找到' : '资产库是空的。在画布里框选节点，点「保存到资产」就会出现在这里'}</div>
      )}
      <div className="asset-cards">
        {shown.map((a) => (
          <div key={a.id} className="asset-card">
            <div className="asset-cover">
              {a.file && a.kind === 'image' && <img src={fileUrl(a.file)} loading="lazy" />}
              {a.file && a.kind === 'video' && <video src={fileUrl(a.file)} muted preload="metadata" controls />}
              {a.file && a.kind === 'audio' && <audio src={fileUrl(a.file)} controls />}
              {!a.file && <div className="asset-text">{a.text}</div>}
            </div>
            <div className="card-info">
              <div className="card-name" title={a.name}>
                {a.name}
              </div>
              <div className="card-meta">{day(a.createdAt)}</div>
            </div>
            <button
              className="card-more"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setMenu(menu === a.id ? null : a.id)}
            >
              <MoreHorizontal size={16} />
            </button>
            {menu === a.id && (
              <div className="card-menu" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  onClick={async () => {
                    setMenu(null);
                    const name = await promptDialog({ title: '重命名资产', defaultValue: a.name });
                    if (!name || name === a.name) return;
                    try {
                      await api.renameAsset(a.id, name);
                      load();
                    } catch (e: any) {
                      toast(e.message, 'error');
                    }
                  }}
                >
                  <PenLine size={14} /> 重命名
                </button>
                <button
                  onClick={() => {
                    setMenu(null);
                    download(a);
                  }}
                >
                  <Download size={14} /> 下载
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    setMenu(null);
                    const ok = await confirmDialog({ title: `从资产库删除「${a.name}」？`, message: '画布上已经用到的不受影响。', okText: '删除', danger: true });
                    if (!ok) return;
                    try {
                      await api.deleteAsset(a.id);
                      load();
                    } catch (e: any) {
                      toast(e.message, 'error');
                    }
                  }}
                >
                  <Trash2 size={14} /> 删除
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const fmtDay = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 右上角：自动清理的状态 + 立即清理 */
function CleanupInfo({ toast }: { toast: (m: string, k?: 'info' | 'error') => void }) {
  const [s, setS] = useState<CleanupStatus>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.cleanupStatus().then(setS).catch(() => undefined);
  }, []);
  if (!s) return null;
  const tip = [
    `每 ${s.everyDays} 天自动删除 ${s.keepDays} 天前生成 / 上传的图片、视频、音频`,
    '定稿（⭐）的版本、角色库用到的图、资产库里的文件会保留；项目、画布、文字不删',
    s.lastRun ? `上次清理：${fmtDay(s.lastRun)}，删了 ${s.lastResult?.files ?? 0} 个文件` : '',
    s.nextRun ? `下次清理：${fmtDay(s.nextRun)}` : '',
    '点一下立即清理',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button
      className="ghost"
      title={tip}
      disabled={busy}
      onClick={async () => {
        const ok = await confirmDialog({
          title: `现在就删除 ${s.keepDays} 天前生成 / 上传的文件？`,
          message: '定稿（⭐）的版本、角色图、资产库里的文件会保留；其余删了找不回来。',
          okText: '立即清理',
          danger: true,
        });
        if (!ok) return;
        setBusy(true);
        try {
          const before = s.lastRun;
          const next = await api.runCleanup();
          setS(next);
          if (next.lastRun !== before) toast(`清理完成：删除 ${next.lastResult?.files ?? 0} 个文件`);
        } catch (e: any) {
          toast(e.message, 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 size={15} className="spin" /> : <Eraser size={15} />} 自动清理{s.nextRun ? ` · 下次 ${fmtDay(s.nextRun).split(' ')[0]}` : ''}
    </button>
  );
}

/** 项目卡片右下角的「⋯」：收藏 / 重命名 / 删除（首页最近项目、项目页共用） */
function ProjectMenu({ project: p, reload }: { project: ProjectSummary; reload: () => void }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if ((e.target as Element).closest?.('.card-menu, .card-more')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [open]);
  const act = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      await fn();
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <>
      <button
        className={`card-more ${open ? 'on' : ''}`}
        title="更多：收藏、重命名、删除"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="card-menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => act(() => api.updateProject(p.id, { starred: !p.starred }))}>
            <Star size={14} fill={p.starred ? 'currentColor' : 'none'} className={p.starred ? 'star-mark' : ''} /> {p.starred ? '取消收藏' : '收藏'}
          </button>
          <button
            onClick={async () => {
              setOpen(false);
              const name = await promptDialog({ title: '重命名项目', defaultValue: p.name });
              if (!name || name === p.name) return;
              act(() => api.updateProject(p.id, { name }));
            }}
          >
            <PenLine size={14} /> 重命名
          </button>
          <button
            className="danger"
            onClick={async () => {
              setOpen(false);
              const ok = await confirmDialog({ title: `删除项目「${p.name}」？`, message: '文件会挪到 workspace/.trash，不会立刻消失。', okText: '删除', danger: true });
              if (ok) act(() => api.deleteProject(p.id));
            }}
          >
            <Trash2 size={14} /> 删除
          </button>
        </div>
      )}
    </>
  );
}
