import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Clapperboard, ListChecks, Plus, Settings, SlidersHorizontal } from 'lucide-react';
import type { Character, Episode, Job, ModelInfo, Project, ServerEvent } from '../shared/types';
import { api } from './api';
import { Canvas } from './Canvas';
import { Home } from './Home';
import { AppContext, type AppCtx } from './context';
import { CharacterLibrary, HistoryPicker, ProjectSettings } from './components/Modals';
import { ModelManager } from './components/ModelManager';
import { QueuePanel } from './components/QueuePanel';
import { DialogHost, promptDialog } from './components/Dialog';
import { Select } from './components/Select';

interface Toast {
  id: number;
  msg: string;
  kind: 'info' | 'error';
  action?: { label: string; onClick: () => void };
}

/** 地址：#/ 主页；#/c/<项目>/<集> 画布 */
function parseHash(): { pid?: string; eid?: string } {
  const m = location.hash.match(/^#\/c\/([^/]+)(?:\/([^/]+))?/);
  return m ? { pid: decodeURIComponent(m[1]), eid: m[2] ? decodeURIComponent(m[2]) : undefined } : {};
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [project, setProject] = useState<Project>();
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode>();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<'' | 'models' | 'chars' | 'history' | 'project'>('');
  const [showQueue, setShowQueue] = useState(false);
  const [cleanup, setCleanup] = useState<AppCtx['cleanup']>();
  const [editingName, setEditingName] = useState(false);
  const historyCb = useRef<((file: string, kind: 'image' | 'video' | 'audio') => void) | undefined>(undefined);

  const toast = useCallback((msg: string, kind: 'info' | 'error' = 'info', action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 8000 : 3500);
  }, []);

  const refreshModels = useCallback(() => {
    api.models().then(setModels).catch((e) => toast(e.message, 'error'));
  }, []);

  const refreshCharacters = useCallback(() => {
    if (project) api.characters(project.id).then(setCharacters);
  }, [project?.id]);

  const go = (pid?: string, eid?: string) => {
    location.hash = pid ? `#/c/${encodeURIComponent(pid)}${eid ? `/${encodeURIComponent(eid)}` : ''}` : '#/';
  };

  useEffect(() => {
    refreshModels();
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  // 打开画布
  useEffect(() => {
    if (!route.pid) {
      setProject(undefined);
      setEpisode(undefined);
      setShowQueue(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const ps = await api.projects();
        const p = ps.find((x) => x.id === route.pid);
        if (!p) {
          toast('这个画布不存在了', 'error');
          return go();
        }
        const es = await api.episodes(p.id);
        if (!alive) return;
        setProject(p);
        setEpisodes(es);
        setEpisode(es.find((e) => e.id === route.eid) || es[0]);
        api.characters(p.id).then(setCharacters);
        api.jobs(p.id).then(setJobs);
      } catch (e: any) {
        toast(e.message, 'error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [route.pid, route.eid]);

  // 服务器推送：任务状态实时更新
  const projectIdRef = useRef<string | undefined>(undefined);
  projectIdRef.current = project?.id;
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      // 每次连上（包括后端重启、电脑睡醒后自动重连）都补拉一次：断线期间完成的任务不会推送过来
      if (ev.type === 'hello') {
        const pid = projectIdRef.current;
        if (pid) {
          api
            .jobs(pid)
            .then((list) => setJobs((prev) => [...list, ...prev.filter((p) => !list.some((j) => j.id === p.id))]))
            .catch(() => undefined);
        }
        return;
      }
      if (ev.type === 'cleanup') {
        if (ev.files > 0) {
          setCleanup({ deleted: ev.deleted, at: Date.now() });
          toast(`已自动清理 ${ev.files} 个 3 天前的文件，释放 ${(ev.bytes / 1024 / 1024).toFixed(1)} MB（定稿和角色图已保留）`);
        }
        return;
      }
      if (ev.type !== 'job') return;
      const j = ev.job;
      setJobs((prev) => {
        const i = prev.findIndex((p) => p.id === j.id);
        if (i < 0) return [j, ...prev];
        const next = prev.slice();
        next[i] = j;
        return next;
      });
      if (j.status === 'failed') toast(`生成失败：${j.error}`, 'error');
    };
    return () => es.close();
  }, []);

  const projectJobs = useMemo(() => jobs.filter((j) => j.request.projectId === project?.id), [jobs, project?.id]);
  const activeCount = projectJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  const ctx: AppCtx = {
    project,
    episode,
    models,
    characters,
    jobs: projectJobs,
    setJobs,
    toast,
    refreshModels,
    refreshCharacters,
    cleanup,
    openCharacters: () => setModal('chars'),
    openModels: () => setModal('models'),
    pickFromHistory: (cb) => {
      historyCb.current = cb;
      setModal('history');
    },
  };

  const renameProject = async (name: string) => {
    if (!project || !name.trim() || name === project.name) return;
    const p = await api.updateProject(project.id, { name: name.trim() });
    setProject(p);
  };

  const inCanvas = Boolean(route.pid);

  return (
    <AppContext.Provider value={ctx}>
      <ReactFlowProvider>
        <div className="app">
          {!inCanvas && <Home onOpen={(pid, eid) => go(pid, eid)} onOpenModels={() => setModal('models')} toast={toast} />}

          {inCanvas && (
            <>
              <header className="topbar">
                <button className="back" onClick={() => go()} title="回到主页">
                  <ChevronLeft size={18} />
                  <span className="logo-mark small">
                    <Clapperboard size={13} />
                  </span>
                </button>
                {editingName ? (
                  <input
                    className="name-input"
                    autoFocus
                    defaultValue={project?.name}
                    onBlur={(e) => {
                      renameProject(e.target.value);
                      setEditingName(false);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <span className="proj-name" onDoubleClick={() => setEditingName(true)} title="双击改名">
                    {project?.name || '…'}
                  </span>
                )}
                <span className="slash">/</span>
                <Select
                  className="ep-select"
                  value={episode?.id || ''}
                  options={[...episodes.map((ep) => ({ value: ep.id, label: ep.title })), { value: '__new', label: '+ 新建一集' }]}
                  onChange={async (v) => {
                    if (!project) return;
                    if (v === '__new') {
                      try {
                        const ep = await api.createEpisode(project.id);
                        setEpisodes((es) => [...es, ep]);
                        go(project.id, ep.id);
                      } catch (e: any) {
                        toast(e.message, 'error');
                      }
                      return;
                    }
                    go(project.id, v);
                  }}
                />
                {episode && project && (
                  <button
                    className="ghost small"
                    title="给这一集改名"
                    onClick={async () => {
                      const t = await promptDialog({ title: '给这一集改名', defaultValue: episode.title, placeholder: '比如：第2集 放学路上' });
                      if (!t || t === episode.title) return;
                      try {
                        const ep = await api.renameEpisode(project.id, episode.id, t);
                        setEpisodes((es) => es.map((x) => (x.id === ep.id ? ep : x)));
                        setEpisode(ep);
                      } catch (e: any) {
                        toast(e.message, 'error');
                      }
                    }}
                  >
                    改名
                  </button>
                )}
                <span className="spacer" />
                <button className="ghost" onClick={() => setModal('project')} title="画风、默认比例">
                  <Settings size={15} /> 设置
                </button>
                <button className="ghost" onClick={() => setModal('models')}>
                  <SlidersHorizontal size={15} /> 模型
                  {models.length ? (
                    <span className="pill">{models.length}</span>
                  ) : (
                    <span className="pill warn">未接入</span>
                  )}
                </button>
                <button className={`ghost ${showQueue ? 'on' : ''}`} onClick={() => setShowQueue(!showQueue)}>
                  <ListChecks size={15} /> 队列
                  {activeCount > 0 && <span className="pill hot">{activeCount}</span>}
                </button>
              </header>

              <main className="main">
                {project && episode ? (
                  <Canvas key={`${project.id}/${episode.id}`} project={project} episode={episode} />
                ) : (
                  <div className="empty-tip">
                    <Plus size={14} /> 加载中…
                  </div>
                )}
                {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
              </main>
            </>
          )}

          {modal === 'models' && <ModelManager onClose={() => (setModal(''), refreshModels())} />}
          {modal === 'chars' && <CharacterLibrary onClose={() => setModal('')} />}
          {modal === 'history' && <HistoryPicker onClose={() => setModal('')} onPick={(f, k) => historyCb.current?.(f, k)} />}
          {modal === 'project' && project && (
            <ProjectSettings
              project={project}
              onClose={() => setModal('')}
              onSaved={(p) => {
                setProject(p);
                toast('已保存');
              }}
            />
          )}

          <DialogHost />

          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast ${t.kind} ${t.action ? 'has-action' : ''}`}>
                {t.msg}
                {t.action && (
                  <button
                    className="toast-action"
                    onClick={() => {
                      t.action!.onClick();
                      setToasts((all) => all.filter((x) => x.id !== t.id));
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </ReactFlowProvider>
    </AppContext.Provider>
  );
}
