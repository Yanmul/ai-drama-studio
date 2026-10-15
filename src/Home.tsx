// 主页：上面「新建画布创作」，下面是历史画布
import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, LayoutGrid, Loader2, MoreHorizontal, PenLine, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '../shared/types';
import { api, fileUrl } from './api';
import { fileKind } from './lib';

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Cover({ files }: { files: string[] }) {
  if (!files.length)
    return (
      <div className="cover empty">
        <LayoutGrid size={28} strokeWidth={1.3} />
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
  onOpen,
  onOpenModels,
  toast,
}: {
  onOpen: (pid: string, eid?: string) => void;
  onOpenModels: () => void;
  toast: (m: string, k?: 'info' | 'error', a?: { label: string; onClick: () => void }) => void;
}) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.home().then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);

  const shown = useMemo(() => (items || []).filter((p) => !q || p.name.includes(q)), [items, q]);

  const create = async () => {
    setCreating(true);
    try {
      const d = new Date();
      const p = await api.createProject(`未命名画布 ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      onOpen(p.id);
    } catch (e: any) {
      toast(e.message, 'error');
      setCreating(false);
    }
  };

  return (
    <div className="home" onClick={() => setMenu(null)}>
      <header className="home-top">
        <div className="logo">
          <span className="logo-mark">
            <Clapperboard size={16} />
          </span>
          短剧工作台
        </div>
        <span className="spacer" />
        <button className="ghost" onClick={onOpenModels}>
          <SlidersHorizontal size={15} /> 模型管理
        </button>
      </header>

      <main className="home-main">
        <section className="hero" onClick={create}>
          <div className="hero-dots" />
          <button className="hero-plus" disabled={creating} aria-label="新建画布">
            {creating ? <Loader2 size={30} className="spin" /> : <Plus size={34} strokeWidth={1.6} />}
          </button>
          <div className="hero-title">新建画布创作</div>
          <div className="hero-sub">从一个空白画布开始：拖入素材、连线、生成</div>
        </section>

        <div className="home-bar">
          <h2>历史画布</h2>
          <span className="muted">{items ? `${items.length} 个` : ''}</span>
          <span className="spacer" />
          <div className="home-search">
            <Search size={14} />
            <input placeholder="搜索画布" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {!items && (
          <div className="home-empty">
            <Loader2 className="spin" size={18} /> 加载中…
          </div>
        )}
        {items && shown.length === 0 && <div className="home-empty">{q ? '没有找到' : '还没有画布，点上面新建一个'}</div>}

        <div className="cards">
          {shown.map((p) => (
            <div key={p.id} className="card" onClick={() => onOpen(p.id, p.lastEpisodeId)}>
              <Cover files={p.covers} />
              <div className="card-info">
                <div className="card-name" title={p.name}>
                  {p.name}
                </div>
                <div className="card-meta">
                  {ago(p.updatedAt)} · {p.nodeCount} 个节点{p.episodeCount > 1 ? ` · ${p.episodeCount} 集` : ''}
                </div>
              </div>
              <button
                className="card-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === p.id ? null : p.id);
                }}
              >
                <MoreHorizontal size={16} />
              </button>
              {menu === p.id && (
                <div className="card-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={async () => {
                      setMenu(null);
                      const name = prompt('画布名称', p.name);
                      if (!name) return;
                      await api.updateProject(p.id, { name });
                      load();
                    }}
                  >
                    <PenLine size={14} /> 重命名
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      setMenu(null);
                      if (!confirm(`删除画布「${p.name}」？\n文件会挪到 workspace/.trash，不会立刻消失。`)) return;
                      await api.deleteProject(p.id);
                      load();
                    }}
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
