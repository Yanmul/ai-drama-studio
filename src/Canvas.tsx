// 节点画布（操作方式参考 ComfyUI，节点参考 LibTV）。
// 一集一张画布，存在 workspace/projects/<项目>/episodes/<集>/canvas.json，改动自动保存。
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  SelectionMode,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
  type Viewport,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Archive, Check, Clock, Hand, History, Loader2, Maximize, Minus, MousePointer2, PanelLeft, Plus, Redo2, RotateCcw, Undo2, UsersRound, X } from 'lucide-react';
import type { CanvasFile, Episode, Job, NodeData, NodeKind, Project, StoryboardFile, Version } from '../shared/types';
import { api, fileUrl } from './api';
import { AddNodeMenu, type AddMenuAction } from './components/AddNodeMenu';
import { CanvasContext, useApp, useJobs, type CanvasCtx } from './context';
import { buildRequest, estimateCostNumber } from './inputs';
import { pruneDeletedVersions } from '../shared/cleanup';
import { KIND_CAP, KIND_LABEL, SETTING_WORD, activeVersion, batchProgress, emptyGen, fileKind, makeNodeData, newId, pickModel, settingImages, settingKind } from './lib';
import { askNotifyPermission, notify } from './notify';
import { MediaNode, grabAt } from './nodes/MediaNode';
import { FlowEdge } from './edges/FlowEdge';
import { SelectionBar } from './components/SelectionBar';
import { confirmDialog } from './components/Dialog';
import { AssetPanel } from './components/AssetPanel';

type FlowNode = Node<NodeData>;
const nodeTypes = { media: MediaNode };
const edgeTypes = { flow: FlowEdge };

/** 把成功任务的结果放进对应节点（刷新页面、关过浏览器也能补上） */
function applyJobs(nodes: FlowNode[], jobs: Job[], episodeId: string): FlowNode[] {
  let changed = false;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sorted = jobs
    .filter((j) => j.status === 'succeeded' && j.request.episodeId === episodeId && byId.has(j.request.nodeId))
    .sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  for (const j of sorted) {
    const n = byId.get(j.request.nodeId)!;
    const d = n.data;
    if (d.versions.some((v) => v.jobId === j.id) || (d.removedJobs as string[] | undefined)?.includes(j.id)) continue;
    const versions: Version[] = [...d.versions];
    let text = d.text;
    if (d.kind === 'text' && versions.length === 0 && d.text?.trim()) {
      versions.push({ id: `v_${j.id}_src`, kind: 'text', text: d.text, createdAt: j.createdAt, label: '原文' });
    }
    (j.outputs || []).forEach((o, k) => {
      versions.push({ id: `v_${j.id}_${k}`, kind: o.kind, file: o.file, text: o.text, jobId: j.id, createdAt: j.finishedAt || j.createdAt });
      if (o.kind === 'text') text = o.text;
    });
    byId.set(n.id, { ...n, data: { ...d, versions, current: versions.length - 1, text } });
    changed = true;
  }
  return changed ? nodes.map((n) => byId.get(n.id)!) : nodes;
}

/** 合并两份节点数据里的版本（两个标签页 / 自动清理各自改过版本时用）；没变化返回 null */
function mergeVersions(mine: NodeData, theirs: NodeData): NodeData | null {
  const removed = new Set([...((mine.removedJobs as string[] | undefined) || []), ...((theirs.removedJobs as string[] | undefined) || [])]);
  const byId = new Map<string, Version>();
  for (const v of [...(mine.versions || []), ...(theirs.versions || [])]) if (!byId.has(v.id)) byId.set(v.id, v);
  const versions = [...byId.values()].filter((v) => !v.jobId || !removed.has(v.jobId));
  const same = versions.length === mine.versions.length && versions.every((v, i) => v.id === mine.versions[i]?.id);
  if (same && removed.size === ((mine.removedJobs as string[] | undefined) || []).length) return null;
  const shown = mine.versions[mine.current];
  let current = shown ? versions.findIndex((v) => v.id === shown.id) : -1;
  if (current < 0) current = versions.length - 1;
  const starred = [mine.starred, theirs.starred].find((id) => id && versions.some((v) => v.id === id));
  return { ...mine, versions, current, starred, removedJobs: [...removed] };
}

export function Canvas({ project, episode }: { project: Project; episode: Episode }) {
  const app = useApp();
  const { models, toast, pickFromHistory, characters } = app;
  const jobs = useJobs();
  const rf = useReactFlow<FlowNode, Edge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loaded, setLoaded] = useState(false);
  // 鼠标工具：select = 左键拖动框选（空格 / 中键拖动平移）；hand = 左键拖动平移
  const [tool, setTool] = useState<'select' | 'hand'>(() => (localStorage.getItem('canvasTool') as any) || 'select');
  // 左侧「资产管理」面板
  const [panel, setPanel] = useState<null | 'canvas' | 'assets'>(() => {
    try {
      return (localStorage.getItem('assetPanel') as any) || null;
    } catch {
      return null;
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; connectFrom?: string; connectTo?: string } | null>(null);
  const viewport = useRef<Viewport | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const uploadRef = useRef<HTMLInputElement>(null);
  const storyboardRef = useRef<HTMLInputElement>(null);
  const pendingUploadPos = useRef<{ pos: { x: number; y: number }; connectTo?: string; connectFrom?: string } | null>(null);
  // —— 撤销 / 重做：画布停手 0.4 秒记一个快照，⌘Z 退回上一个 ——
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastSnap = useRef('');
  const restoring = useRef(false);
  const snapTimer = useRef<number | undefined>(undefined);
  const [, bumpHistory] = useState(0);
  // 快照里不比较「版本」相关字段：生成结果到达、切换版本都不算一步，撤销也不会把刚出的结果撤掉
  const snapshot = () =>
    JSON.stringify({
      nodes: rf.getNodes().map((n) => ({ id: n.id, position: n.position, data: n.data })),
      edges: rf.getEdges().map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
    });
  const VOLATILE = ['versions', 'current', 'removedJobs', 'run', 'dismissedError'] as const;
  // 文本节点的正文是生成结果写进去的（等于当前那一版生成的文字）：也不算用户改的
  const textFromJob = (d: any) => {
    const cur = d?.versions?.[d.current];
    return Boolean(cur?.jobId && cur.text !== undefined && cur.text === d.text);
  };
  const stable = (s: string) => {
    const v = JSON.parse(s);
    for (const n of v.nodes) {
      const d = n.data;
      if (textFromJob(d)) delete d.text;
      for (const k of VOLATILE) delete d[k];
    }
    return JSON.stringify(v);
  };
  const lastStable = useRef('');
  const commitSnapshot = () => {
    const s = snapshot();
    const key = stable(s);
    if (key === lastStable.current) {
      lastSnap.current = s; // 只是版本变了：更新当前快照，不新增一步
      return;
    }
    if (lastSnap.current) past.current.push(lastSnap.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    lastSnap.current = s;
    lastStable.current = key;
    bumpHistory((x) => x + 1);
  };
  const applySnapshot = (s: string) => {
    const v = JSON.parse(s);
    restoring.current = true;
    window.clearTimeout(snapTimer.current);
    // 还在画布上的节点保留它现在的版本（撤销只回退内容和布局）；被删又撤回的节点用快照里的版本
    const live = new Map(rf.getNodes().map((n) => [n.id, n.data]));
    setNodes(
      v.nodes.map((n: any) => {
        const cur = live.get(n.id);
        if (!cur) return { ...n, type: 'media' };
        const keep: Record<string, unknown> = Object.fromEntries(VOLATILE.map((k) => [k, cur[k]]));
        if (textFromJob(cur)) keep.text = cur.text;
        return { ...n, type: 'media', data: { ...n.data, ...keep } };
      }),
    );
    setEdges(v.edges);
    lastSnap.current = s;
    lastStable.current = stable(s);
    bumpHistory((x) => x + 1);
  };
  const undo = useCallback(() => {
    window.clearTimeout(snapTimer.current);
    commitSnapshot();
    const prev = past.current.pop();
    if (!prev) return toast('没有可以撤销的了');
    future.current.push(lastSnap.current);
    applySnapshot(prev);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(lastSnap.current);
    applySnapshot(next);
  }, []);

  // 连线：鼠标移上去 / 选中时显示剪刀；选中的线和它下游的线有流动光
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const onEdgeHover = useCallback((id: string | null) => {
    window.clearTimeout(hoverTimer.current);
    if (id) setHoverEdge(id);
    else hoverTimer.current = window.setTimeout(() => setHoverEdge(null), 250);
  }, []);
  const selKey = nodes
    .filter((n) => n.selected)
    .map((n) => n.id)
    .join(',');
  const displayEdges = useMemo(() => {
    const selNodes = new Set(selKey ? selKey.split(',') : []);
    // 框选了多个节点时，框里的线也会被选中；这时不当成「选中了一条线」
    const multi = selNodes.size > 1;
    const selEdges = multi ? [] : edges.filter((e) => e.selected);
    // 顺着选中的线往下游走：它的终点再连出去的线，一路标成 chain
    const chain = new Set<string>();
    const queue = selEdges.map((e) => e.target);
    const seen = new Set<string>();
    while (queue.length) {
      const nid = queue.shift()!;
      if (seen.has(nid)) continue;
      seen.add(nid);
      for (const e of edges) if (e.source === nid && !e.selected) {
        chain.add(e.id);
        queue.push(e.target);
      }
    }
    return edges.map((e) => ({
      ...e,
      type: 'flow',
      data: {
        hover: e.id === hoverEdge,
        multi,
        onHover: onEdgeHover,
        flow: chain.has(e.id) ? 'chain' : selNodes.has(e.source) || selNodes.has(e.target) ? 'node' : undefined,
      },
    }));
  }, [edges, selKey, hoverEdge]);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // —— 读画布 ——
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const savedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError('');
    api
      .canvas(project.id, episode.id)
      .then((c) => {
        if (!alive) return;
        if (c.corrupt) {
          // 不加载这张空画布：加载了自动保存就会把空的写回去
          setLoadError('画布文件内容坏了。坏掉的文件已经另存（canvas.json.corrupt-…），可以从自动留的历史版本恢复。');
          return;
        }
        savedAt.current = c.savedAt;
        lastSavedBody.current = normalize(c);
        lastSavedKey.current = keyOf({ nodes: (c.nodes || []).map((n) => ({ id: n.id, type: 'media', position: n.position, data: n.data })), edges: (c.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })), viewport: c.viewport });
        const ns = applyJobs((c.nodes || []).map((n) => ({ ...n, type: 'media' })) as FlowNode[], jobsRef.current, episode.id);
        setNodes(ns);
        setEdges((c.edges || []) as Edge[]);
        viewport.current = c.viewport;
        if (c.viewport) rf.setViewport(c.viewport);
        else setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
        past.current = [];
        future.current = [];
        lastSnap.current = '';
        lastStable.current = '';
        paused.current = false;
        dirty.current = false;
        setSaveState('saved');
        setLoaded(true);
        // 从队列面板「定位」过来的：加载完把那个节点放到屏幕中间并选中
        const focus = sessionStorage.getItem('focusNode');
        if (focus?.startsWith(`${episode.id}/`)) {
          sessionStorage.removeItem('focusNode');
          const fid = focus.slice(episode.id.length + 1);
          setTimeout(() => {
            const n = rf.getNode(fid);
            if (!n) return toast('对应的节点已经删掉了');
            rf.setNodes((all) => all.map((x) => ({ ...x, selected: x.id === fid })));
            rf.setCenter(n.position.x + 170, n.position.y + 150, { zoom: 0.9, duration: 400 });
          }, 120);
        }
      })
      .catch((e) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [project.id, episode.id, reloadTick]);

  // —— 从首页快捷入口进来：放好一个节点（模型选好），打开生成框 ——
  useEffect(() => {
    if (!loaded) return;
    let p: { pid: string; kind: NodeKind; modelId?: string } | null = null;
    try {
      p = JSON.parse(sessionStorage.getItem('pendingNode') || 'null');
    } catch {}
    if (!p || p.pid !== project.id) return;
    sessionStorage.removeItem('pendingNode');
    const id = addNode(p.kind, { x: 0, y: 0 });
    if (p.modelId) rf.updateNodeData(id, { gen: emptyGen(models, p.kind, project, p.modelId) });
    setTimeout(() => {
      rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      const n = rf.getNode(id);
      const w = n?.measured?.width ?? 340;
      const h = n?.measured?.height ?? 260;
      // 生成框在节点下面，镜头往下偏一点，让节点和生成框都在画面里
      rf.setCenter(w / 2, h / 2 + 150, { zoom: 1, duration: 0 });
    }, 80);
  }, [loaded]);

  // —— 新结果进来，放进节点 ——
  useEffect(() => {
    if (loaded) setNodes((ns) => applyJobs(ns, jobs, episode.id));
  }, [jobs, loaded, episode.id]);

  // —— 定时清理删了文件：正开着的画布也去掉对应版本（不然下次自动保存会把它们写回去） ——
  useEffect(() => {
    if (!loaded || !app.cleanup?.deleted.length) return;
    const deleted = new Set(app.cleanup.deleted);
    setNodes((ns) => {
      let changed = false;
      const next = ns.map((n) => {
        const d = pruneDeletedVersions(n.data, deleted);
        if (!d) return n;
        changed = true;
        return { ...n, data: d };
      });
      return changed ? next : ns;
    });
  }, [app.cleanup, loaded]);

  // —— 自动保存（停手 0.8 秒后存；切集、回主页、关页面时把没存的立刻存掉） ——
  // 用这张画布自己的 nodes / edges 状态，不用 rf.getNodes()：卸载时 React Flow 的 store 可能已经换成下一张画布
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const dirty = useRef(false);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const inFlight = useRef(false);
  const again = useRef(false); // 保存途中又改了：这次存完再存一次
  const loadedRef = useRef(false);
  loadedRef.current = loaded;
  const paused = useRef(false); // 正在处理冲突 / 重新加载：先不保存
  // 上次存下（或刚读进来）的内容：内容没变就不发保存请求。
  // 不然打开画布时节点量尺寸、套用生成结果都会触发一次「保存」，两个标签页开着同一集时会互相顶掉
  const lastSavedKey = useRef('');
  const lastSavedBody = useRef<CanvasFile | null>(null); // 上次存下 / 读进来的内容：冲突时判断「对面改了什么」
  const dirtySince = useRef(0); // 从什么时候开始有没存的改动（一直在操作也最多等 3 秒就存）
  const keyOf = (c: CanvasFile) => JSON.stringify([c.nodes, c.edges, c.viewport]);
  // 统一成保存时的字段，方便比较硬盘上的和页面上的是不是同一份内容
  const normalize = (c: CanvasFile): CanvasFile => ({
    nodes: (c.nodes || []).map((n) => ({ id: n.id, type: 'media', position: n.position, data: n.data })),
    edges: (c.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
    viewport: c.viewport,
  });
  const bodyNow = (): CanvasFile => ({
    nodes: nodesRef.current.map((n) => ({ id: n.id, type: 'media', position: n.position, data: n.data })),
    edges: edgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
    viewport: viewport.current,
  });
  /** 存盘；返回请求体是否小到能用 keepalive（关页面时也能发完） */
  const save = useCallback(
    (keepalive = false, force = false): boolean => {
      window.clearTimeout(saveTimer.current);
      if (!loadedRef.current || paused.current) return true; // 还没读完 / 正在处理冲突：不存
      const body: CanvasFile = { ...bodyNow(), baseSavedAt: force ? undefined : savedAt.current };
      const small = JSON.stringify(body).length < 60_000;
      const key = keyOf(body);
      if (!force && key === lastSavedKey.current) {
        dirty.current = false;
        dirtySince.current = 0;
        if (!inFlight.current) setSaveState('saved');
        return true;
      }
      // 上一次还没存完：排队（dirty 保持为真，关页面时还会补发）；关页面时等不了排队，直接发
      if (inFlight.current && !keepalive) {
        again.current = true;
        return small;
      }
      dirty.current = false;
      dirtySince.current = 0;
      inFlight.current = true;
      setSaveState('saving');
      api
        .saveCanvas(project.id, episode.id, body, keepalive && small)
        .then((r) => {
          saveRetries.current = 0;
          if (r?.savedAt) savedAt.current = r.savedAt;
          lastSavedKey.current = key;
          lastSavedBody.current = normalize(body);
          setSaveState(dirty.current ? 'dirty' : 'saved');
        })
        .catch((e: any) => {
          if (e.conflict) {
            dirty.current = true;
            handleConflict(body);
            return;
          }
          dirty.current = true;
          // 后台重启（改了后端代码、电脑睡醒）这类一两秒就好的：先自己隔 2 秒重试，连着失败 3 次才提醒
          if (saveRetries.current < 3) {
            saveRetries.current += 1;
            setSaveState('dirty');
            window.clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(() => saveRef.current(), 2000);
            return;
          }
          saveRetries.current = 0;
          setSaveState('error');
          toast(`保存失败：${e.message}`, 'error', { label: '重试', onClick: () => saveRef.current() });
        })
        .finally(() => {
          inFlight.current = false;
          if (again.current && !paused.current) {
            again.current = false;
            saveRef.current();
          }
        });
      return small;
    },
    [project.id, episode.id],
  );
  // 保存冲突：硬盘上的版本号变了（别的标签页存过、或自动清理改过）
  const handleConflict = async (body: CanvasFile) => {
    if (paused.current) return;
    paused.current = true;
    again.current = false;
    window.clearTimeout(saveTimer.current);
    setSaveState('error');
    // 两边只差在「版本」上（另一个标签页先存了生成结果、自动清理去掉了版本）：把两边的版本合起来接着存，不打扰用户。
    // 只有正文、节点、连线、位置这些用户改的内容不一样，才问用户留哪边
    try {
      const disk = await api.canvas(project.id, episode.id);
      const theirs = normalize(disk);
      const mine = normalize(body);
      const userKey = (c: CanvasFile) => stable(JSON.stringify({ nodes: c.nodes, edges: c.edges }));
      // 对面相对上次保存只改了版本（或者两边用户内容本来就一样）：合并版本，保留这边没存的修改
      const base = lastSavedBody.current;
      if (!disk.corrupt && (userKey(theirs) === userKey(mine) || (base && userKey(theirs) === userKey(base)))) {
        const diskData = new Map(theirs.nodes.map((n) => [n.id, n.data]));
        setNodes((ns) =>
          ns.map((n) => {
            const other = diskData.get(n.id);
            const merged = other && mergeVersions(n.data, other);
            return merged ? { ...n, data: merged } : n;
          }),
        );
        savedAt.current = disk.savedAt;
        paused.current = false;
        setTimeout(() => saveRef.current(), 30); // 等合并后的节点进到 nodesRef 再存
        return;
      }
    } catch {
      /* 读不到就照常问用户 */
    }
    const overwrite = await confirmDialog({
      title: '这一集在别的窗口里改过了',
      message: '可能同时开了两个标签页。\n「用这里的覆盖」会保存当前页面的内容；「重新加载」会丢掉这里没保存的改动，换成另一个窗口保存的版本。',
      okText: '用这里的覆盖',
      cancelText: '重新加载',
    });
    if (overwrite) {
      paused.current = false;
      saveRef.current(false, true);
    } else {
      // 重新加载：丢掉排队的保存，读完新内容再恢复（paused 在加载完成时解除）
      dirty.current = false;
      again.current = false;
      window.clearTimeout(saveTimer.current);
      setReloadTick((t) => t + 1);
    }
  };

  // 恢复历史版本前：停掉自动保存、丢掉排队的保存（读完新内容后自动恢复）
  const pauseForRestore = () => {
    paused.current = true;
    dirty.current = false;
    again.current = false;
    window.clearTimeout(saveTimer.current);
  };
  const [showHistory, setShowHistory] = useState(false);
  // 弹窗里恢复：页面上没存的改动先存掉（这样「恢复之前另存」里有它），再停掉自动保存
  const flushThenPause = async () => {
    window.clearTimeout(saveTimer.current);
    if (dirty.current && !paused.current) {
      await api.saveCanvas(project.id, episode.id, bodyNow()).catch(() => undefined);
    }
    pauseForRestore();
  };

  const scheduleSave = () => {
    dirty.current = true;
    if (!dirtySince.current) dirtySince.current = Date.now();
    setSaveState((st) => (st === 'saving' ? st : 'dirty'));
    window.clearTimeout(saveTimer.current);
    // 停手 0.8 秒后存；一直在操作（点来点去也会重新计时）的话，最多 3 秒也会存一次
    const wait = Date.now() - dirtySince.current > 3000 ? 0 : 800;
    saveTimer.current = window.setTimeout(() => save(), wait);
  };
  const saveRetries = useRef(0);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!loaded) return;
    scheduleSave();
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    window.clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(() => {
      if (!rf.getNodes().some((n) => n.dragging)) commitSnapshot();
    }, 400);
  }, [nodes, edges, loaded, save]);

  useEffect(() => {
    // 关页面 / 刷新：画布小就用 keepalive 发出去；太大发不完，就让浏览器弹「确定离开吗」，趁这会儿存完
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      if (!saveRef.current(true)) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // 切集、回主页：组件卸载前把还没存的存掉
      if (dirty.current) saveRef.current();
      window.clearTimeout(saveTimer.current);
    };
  }, []);

  // —— 节点操作 ——
  const countOf = (kind: NodeKind) => rf.getNodes().filter((n) => n.data.kind === kind).length;

  const addNode: CanvasCtx['addNode'] = useCallback(
    (kind, pos, opts = {}) => {
      const id = newId();
      const data = makeNodeData(kind, opts.title || `${KIND_LABEL[kind]}节点 ${countOf(kind) + 1}`, models, project, {
        characterId: opts.characterId,
        text: opts.text ?? (kind === 'text' || kind === 'script' ? '' : undefined),
      });
      if (opts.version) {
        data.versions = [{ createdAt: new Date().toISOString(), ...opts.version, id: newId('v_') }];
        data.current = 0;
      }
      rf.addNodes({ id, type: 'media', position: pos, data, selected: false });
      const newEdges: Edge[] = [];
      if (opts.connectTo) newEdges.push({ id: newId('e_'), source: id, target: opts.connectTo });
      if (opts.connectFrom) newEdges.push({ id: newId('e_'), source: opts.connectFrom, target: id });
      if (newEdges.length) rf.addEdges(newEdges);
      return id;
    },
    [models, project.id, project.ratio],
  );

  // 对话框里「放到画布」：放在画布可见区域中间（右边被对话框挡住的部分不算）
  useEffect(() => {
    const h = (e: Event) => {
      const { text, kind } = (e as CustomEvent<{ text: string; kind: 'text' | 'script' }>).detail;
      const panel = document.querySelector('.chat-panel')?.getBoundingClientRect();
      const right = panel ? panel.left : window.innerWidth;
      const pos = rf.screenToFlowPosition({ x: right / 2 - 170, y: window.innerHeight / 2 - 140 });
      const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
      const id = addNode(kind, pos, { text, title: heading ? heading.slice(0, 20) : undefined });
      rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      toast(`已放到画布：${kind === 'script' ? '脚本' : '文本'}节点`);
    };
    window.addEventListener('ads:add-text-node', h);
    return () => window.removeEventListener('ads:add-text-node', h);
  }, [addNode]);

  const uploadAsNode: CanvasCtx['uploadAsNode'] = useCallback(
    async (file, pos, connectTo) => {
      try {
        const up = await api.upload(project.id, file);
        addNode(up.kind, pos, { title: up.name?.replace(/\.[^.]+$/, '') || undefined, version: { kind: up.kind, file: up.file, label: '上传' }, connectTo });
      } catch (e: any) {
        toast(e.message, 'error');
      }
    },
    [project.id, addNode],
  );

  /** 这些节点连着的设定（角色 / 场景 / 道具）里，哪些还没有图：名字 → 用到它的片段 */
  const missingImages = (ids: string[]) => {
    const out = new Map<string, string[]>();
    for (const id of ids) {
      const n = rf.getNode(id) as FlowNode | undefined;
      if (!n) continue;
      for (const e of rf.getEdges().filter((x) => x.target === id)) {
        const s = rf.getNode(e.source) as FlowNode | undefined;
        if (!(s?.data.characterId || s?.data.refName) || activeVersion(s.data)?.file) continue;
        const name = s.data.title.replace(/（.*$/, '').trim();
        out.set(name, [...(out.get(name) || []), n.data.title]);
      }
    }
    return out;
  };
  const missingText = (m: Map<string, string[]>) =>
    [...m].map(([name, used]) => `· ${name}（用在 ${used.slice(0, 4).join('、')}${used.length > 4 ? ` 等 ${used.length} 条` : ''}）`).join('\n');

  /** 标了「接上一条尾帧」、但尾帧还没连上。
   *  上一条当前这版的尾帧已经接过、后来被你手动删了线 / 删了节点的，算你不要了，不再等 */
  const needsFrame = (n?: FlowNode) => {
    if (!n?.data.chainPrev) return false;
    if (n.data.firstFrame && rf.getEdges().some((e) => e.source === n.data.firstFrame && e.target === n.id)) return false;
    const prev = rf.getNode(n.data.chainPrev) as FlowNode | undefined;
    const v = prev && activeVersion(prev.data);
    return !(v?.file && n.data.chainFrom === v.id);
  };

  const activeOf = (nodeId: string) =>
    jobsRef.current.filter((j) => j.request.nodeId === nodeId && j.request.episodeId === episode.id && (j.status === 'queued' || j.status === 'running')).length;

  const submit = useCallback(
    async (nodeId: string, opts: { skipBusyCheck?: boolean; quiet?: boolean; skipMissingCheck?: boolean } = {}) => {
      const n = rf.getNode(nodeId) as FlowNode | undefined;
      if (!n) return;
      const cap = KIND_CAP[n.data.kind];
      if (!cap) return;
      const model = models.find((m) => m.id === n.data.gen.modelId) || pickModel(models, cap);
      if (!model) {
        toast(`还没有可用的${KIND_LABEL[n.data.kind]}模型`, 'error');
        return false;
      }
      const running = activeOf(nodeId);
      if (running && !opts.skipBusyCheck) {
        const ok = await confirmDialog({
          title: `「${n.data.title}」已经有 ${running} 个在生成`,
          message: '再点会再提交一个新任务，会再扣一次费用。确定要再生成一个吗？',
          okText: '再生成一个',
        });
        if (!ok) return false;
      }
      if (!opts.skipMissingCheck) {
        const miss = missingImages([nodeId]);
        if (miss.size) {
          const ok = await confirmDialog({
            title: '有参考还没有图',
            message: `${missingText(miss)}\n\n提示词里只写了名字，没有图的话模型不知道他们长什么样，生成出来多半不像。先去设定库补上图再生成更稳。`,
            okText: '仍然生成',
            cancelText: '先去补图',
          });
          if (!ok) return false;
        }
      }
      askNotifyPermission();
      if (needsFrame(n) && !opts.quiet) {
        const prev = rf.getNode(n.data.chainPrev!) as FlowNode | undefined;
        const prevV = prev && activeVersion(prev.data);
        const prevReady = Boolean(prevV?.file && fileKind(prevV.file) === 'video');
        const ok = await confirmDialog({
          title: `「${n.data.title}」要接上一条的尾帧`,
          message: prevReady
            ? `「${prev!.data.title}」的尾帧没能自动截下来。可以在它的视频右上角点相机手动截尾帧、连到这一条再生成。\n现在就直接生成（不接尾帧）吗？`
            : `${prev ? `「${prev.data.title}」` : '上一条'}还没生成好，没有尾帧可接。等它生成完会自动把最后一帧连过来，再生成这条衔接最顺。\n现在就直接生成（不接尾帧）吗？`,
          okText: '直接生成',
          cancelText: '等上一条',
        });
        if (!ok) return false;
      }
      const sources = rf
        .getEdges()
        .filter((e) => e.target === nodeId)
        .map((e) => rf.getNode(e.source) as FlowNode | undefined)
        .filter(Boolean)
        .map((s) => ({ id: s!.id, data: s!.data }));
      const req = buildRequest(project.id, episode.id, nodeId, n.data, model, sources);
      if (!req.prompt.trim() && !req.inputTexts.length && !req.refs.length) {
        toast(`「${n.data.title}」还没有提示词：先写点提示词，或者连一个文本节点进来`, 'error');
        return false;
      }
      try {
        const created = await api.generate(req);
        app.setJobs((prev) => [...created, ...prev.filter((p) => !created.some((c) => c.id === p.id))]);
        if (!opts.quiet) toast(created.length > 1 ? `已提交 ${created.length} 个任务` : '已提交，生成好了会自动出现在节点里');
        return true;
      } catch (e: any) {
        toast(e.message, 'error');
        return false;
      }
    },
    [models, project.id, episode.id],
  );

  /** 一次生成多个节点：超过 1 个先确认数量和预估花费 */
  const submitMany = useCallback(
    async (idsIn: string[]) => {
      let ids = idsIn;
      if (!ids.length) return;
      if (ids.length === 1) {
        await submit(ids[0]);
        return;
      }
      // 要接上一条尾帧、但上一条还没生成的：这次先不生成，等尾帧自动连上再生成
      const waiting = ids.filter((id) => needsFrame(rf.getNode(id) as FlowNode | undefined));
      ids = ids.filter((id) => !waiting.includes(id));
      if (!ids.length) return toast(`这 ${waiting.length} 条都要接上一条的尾帧，先生成它们的上一条`, 'error');
      let total = 0;
      let unknown = 0;
      for (const id of ids) {
        const n = rf.getNode(id) as FlowNode | undefined;
        const cap = n && KIND_CAP[n.data.kind];
        const m = cap ? models.find((x) => x.id === n!.data.gen.modelId) || pickModel(models, cap) : undefined;
        const c = m ? estimateCostNumber(m, { ...n!.data.gen.params }) : undefined;
        if (c === undefined) unknown += 1;
        else total += c;
      }
      const busy = ids.filter((id) => activeOf(id) > 0).length;
      const miss = missingImages(ids);
      const ok = await confirmDialog({
        title: `一次生成 ${ids.length} 个节点？`,
        message: [
          `预估花费 ¥${total.toFixed(2)}${unknown ? `（另有 ${unknown} 个模型没填单价，没算进去）` : ''}`,
          busy ? `其中 ${busy} 个节点已经有任务在生成，会再各提交一个。` : '',
          waiting.length ? `另有 ${waiting.length} 条要接上一条的尾帧，这次先不生成——上一条生成好后尾帧会自动连上，你再点生成它们（想全自动接着生成，用成片节点上的「生成全部片段」）。` : '',
          miss.size ? `\n⚠️ 这些参考还没有图（只写了名字，模型不知道长什么样）：\n${missingText(miss)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        okText: `生成 ${ids.length} 个`,
      });
      if (!ok) return;
      let done = 0;
      for (const id of ids) if (await submit(id, { skipBusyCheck: true, quiet: true, skipMissingCheck: true })) done += 1;
      if (done) toast(done === ids.length ? `已提交 ${done} 个节点，生成好了会自动出现在各自节点里` : `已提交 ${done} 个，另外 ${ids.length - done} 个没提交上（见上面的提示）`);
    },
    [submit, models],
  );

  const expandScript = useCallback(
    (nodeId: string) => {
      const s = rf.getNode(nodeId) as FlowNode | undefined;
      if (!s) return;
      const parts = (s.data.text || '')
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (!parts.length) return toast('脚本是空的：镜头之间空一行', 'error');
      // 连进脚本节点的角色图，展开后连到每个视频节点
      const charIds = rf
        .getEdges()
        .filter((e) => e.target === nodeId)
        .map((e) => rf.getNode(e.source) as FlowNode | undefined)
        .filter((n) => n?.data.characterId)
        .map((n) => n!.id);
      // 放到画布上现有内容的右边，免得压住别的节点
      const all = rf.getNodes();
      const x0 = Math.max(...all.map((n) => n.position.x + (n.measured?.width || 340))) + 160;
      const y0 = s.position.y;
      const portrait = project.ratio === '9:16' || project.ratio === '3:4';
      const rowH = portrait ? 400 : 290;
      parts.forEach((p, i) => {
        const title = p.match(/^(镜头\s*\d+)/)?.[1] || `镜头${i + 1}`;
        const t = addNode('text', { x: x0, y: y0 + i * rowH }, { title: `${title} · 提示词`, text: p });
        const v = addNode('video', { x: x0 + 400, y: y0 + i * rowH - 30 }, { title: `${title} · 视频`, connectFrom: t });
        if (charIds.length) rf.addEdges(charIds.map((c) => ({ id: newId('e_'), source: c, target: v })));
      });
      // 展开完立刻记一个快照，这样「撤销」一步就能回到展开前
      setTimeout(() => {
        window.clearTimeout(snapTimer.current);
        commitSnapshot();
      }, 50);
      toast(`已展开成 ${parts.length} 个镜头`, 'info', { label: '撤销', onClick: () => undo() });
      setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 60);
    },
    [addNode, project.ratio],
  );

  // —— 导入分镜：novel-to-seedance 技能导出的 E01-片段.json ——
  const importStoryboard = useCallback(
    (sb: StoryboardFile) => {
      if (sb?.format !== 'novel-to-seedance/fragments@1' || !Array.isArray(sb.fragments) || !sb.fragments.length) {
        toast('这不是分镜导出的 JSON：用 novel-to-seedance 技能的 export_fragments.py 导出', 'error');
        return;
      }
      const gen0 = emptyGen(models, 'video', project);
      const model = models.find((m) => m.id === gen0.modelId);
      if (!model) return toast('还没有可用的视频模型：先去模型管理接一个', 'error');
      const durDef = model.params.find((p) => p.key === 'duration');
      const ratioDef = model.params.find((p) => p.key === 'ratio');
      const durOptions = (durDef?.options || []).map(Number).filter((x) => Number.isFinite(x));
      const nearest = (d: number) => (durOptions.length ? durOptions.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a)) : d);
      const portrait = sb.ratio === '9:16' || sb.ratio === '3:4';
      const all = rf.getNodes();
      const x0 = all.length ? Math.max(...all.map((n) => n.position.x + (n.measured?.width || 340))) + 240 : 0;
      const y0 = all.length ? Math.min(...all.map((n) => n.position.y)) : 0;
      const COLS = 4;
      const colW = portrait ? 300 : 400;
      const rowH = (portrait ? 520 : 300) + 300; // 留出下面放尾帧图的位置
      const newNodes: FlowNode[] = [];
      const newEdges: Edge[] = [];

      // 参考图：按名字到设定库里找，每个名字一个图片节点，连到所有用到它的片段
      const names = [...new Set(sb.fragments.flatMap((f) => f.refs || []))];
      const assetOf = new Map<string, string>();
      const missing: string[] = [];
      const noImage: string[] = [];
      // 名字匹配要严：完全同名，或者「名字·变体」（变体按图片备注挑图）。
      // 不做模糊包含——「老周办公室」不能配成角色「老周」的图，「苏婉」也不能配成「苏婉的卧室」
      const SEP = /^[·・\-—－\s（(]/;
      const findSetting = (name: string) => {
        const exact = characters.find((x) => x.name.trim() === name);
        if (exact) return { c: exact, variant: '' };
        const byPrefix = characters
          .filter((x) => x.name.trim() && name.startsWith(x.name.trim()) && SEP.test(name.slice(x.name.trim().length)))
          .sort((a, b) => b.name.length - a.name.length)[0];
        if (byPrefix) return { c: byPrefix, variant: name.slice(byPrefix.name.trim().length).replace(/^[·・\-—－\s（(]+|[）)]+$/g, '').trim() };
        return undefined;
      };
      names.forEach((name, i) => {
        const hit = findSetting(name);
        const c = hit?.c;
        const imgs = c ? settingImages(c) : [];
        const img = (hit?.variant && imgs.find((x) => x.note && (x.note.includes(hit.variant) || hit.variant.includes(x.note)))) || imgs[0];
        const label = c ? `${c.name}${hit?.variant ? ` · ${hit.variant}` : ''}（${SETTING_WORD[settingKind(c)]}）` : `${name}（待补图）`;
        const data = makeNodeData('image', label, models, project, c ? { characterId: c.id } : { refName: name });
        if (img) {
          data.versions = [{ id: newId('v_'), kind: 'image', file: img.file, label: '设定库', variant: img.note || undefined, createdAt: new Date().toISOString() }];
          data.current = 0;
        } else if (c) noImage.push(name);
        else missing.push(name);
        const id = newId();
        assetOf.set(name, id);
        // 参考图排成一行放在片段上面（竖图很高，竖着排会叠在一起）
        newNodes.push({ id, type: 'media', position: { x: x0 + i * 400, y: y0 }, data });
      });

      // 每条片段一个视频节点：提示词、时长、比例都填好；画风已经写在提示词里，不再叠加项目画风
      const adjusted: string[] = [];
      const vx = x0;
      const vy = y0 + (names.length ? 680 : 0);
      const videoIds: string[] = [];
      sb.fragments.forEach((f, i) => {
        const id = newId();
        const title = `片段${f.no}${f.hook ? ` ${f.hook.replace(/^★+/, '').trim()}` : ''}`;
        const data = makeNodeData('video', title, models, project, { noStyle: true });
        const params = { ...data.gen.params };
        if (durDef) {
          const d = nearest(f.duration);
          params.duration = d;
          if (d !== f.duration) adjusted.push(`片段${f.no} ${f.duration}s→${d}s`);
        }
        if (sb.ratio && ratioDef?.options?.some((o) => String(o) === sb.ratio)) params.ratio = sb.ratio;
        const omni = model.modes.find((m) => m.id === 'omni');
        data.gen = { ...data.gen, prompt: f.prompt, params, mode: (f.refs?.length || f.chain) && omni ? omni.id : data.gen.mode };
        if (f.chain && i > 0) data.chainPrev = videoIds[i - 1];
        newNodes.push({ id, type: 'media', position: { x: vx + (i % COLS) * colW, y: vy + Math.floor(i / COLS) * rowH }, data });
        videoIds.push(id);
        for (const r of f.refs || []) {
          const a = assetOf.get(r);
          if (a) newEdges.push({ id: newId('e_'), source: a, target: id });
        }
      });

      // 成片节点：按片段顺序连好，全部生成完点「拼接」就行
      const cutId = newId();
      const rows = Math.ceil(sb.fragments.length / COLS);
      newNodes.push({
        id: cutId,
        type: 'media',
        position: { x: vx + Math.min(COLS, sb.fragments.length) * colW + 120, y: vy + Math.max(0, rows - 1) * rowH },
        data: makeNodeData('cut', `成片 · ${sb.title?.match(/《(.+?)》/)?.[1] || sb.title?.replace(/[（(].*$/, '').slice(0, 16) || '分镜'}`, [], project, { clips: videoIds }),
      });
      videoIds.forEach((v) => newEdges.push({ id: newId('e_'), source: v, target: cutId }));

      rf.setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...newNodes]);
      rf.setEdges((es) => [...es, ...newEdges]);
      setTimeout(() => {
        window.clearTimeout(snapTimer.current);
        commitSnapshot();
        rf.fitView({ nodes: newNodes.map((n) => ({ id: n.id })), padding: 0.12, duration: 450 });
      }, 60);

      const chained = sb.fragments.filter((f, i) => f.chain && i > 0).length;
      toast(
        `已导入 ${sb.fragments.length} 条片段${chained ? `（${chained} 条会自动接上一条的尾帧）` : ''}，参考图 ${names.length} 个，并连好了成片节点`,
        'info',
        { label: '撤销', onClick: () => undo() },
      );
      const warn = [
        missing.length ? `设定库里找不到：${missing.join('、')}——已建空的图片节点，上传图后会自动给所有片段用上` : '',
        noImage.length ? `这些设定还没有图：${noImage.join('、')}` : '',
        adjusted.length ? `「${model.name}」没有这些时长，已就近调整：${adjusted.slice(0, 4).join('，')}${adjusted.length > 4 ? ' 等' : ''}` : '',
      ].filter(Boolean);
      if (warn.length) setTimeout(() => toast(warn.join('；'), 'error'), 400);
    },
    [models, project, characters],
  );

  const importStoryboardFile = useCallback(
    async (f: File) => {
      try {
        importStoryboard(JSON.parse(await f.text()));
      } catch {
        toast(`「${f.name}」不是有效的 JSON`, 'error');
      }
    },
    [importStoryboard],
  );

  // —— 接上一条尾帧：上一条生成好（或换了版本）就截最后一帧，连到这一条当首帧 ——
  const chainBusy = useRef(new Set<string>());
  // 截失败过的（节点|版本）不再自动重试，免得每次画布变化都弹一次错；换了版本会重新试
  const chainFailed = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded) return;
    for (const n of nodes) {
      const prevId = n.data.chainPrev;
      if (!prevId) continue;
      const prev = nodes.find((x) => x.id === prevId);
      const v = prev && activeVersion(prev.data);
      if (!prev || !v?.file || fileKind(v.file) !== 'video' || n.data.chainFrom === v.id) continue;
      const key = `${n.id}|${v.id}`;
      if (chainBusy.current.has(key) || chainFailed.current.has(key)) continue;
      chainBusy.current.add(key);
      (async () => {
        try {
          // 先让后端用 ffmpeg 截（最准）；不行就在浏览器里截
          let file: string;
          try {
            file = (await api.frame(project.id, v.file!, 'last')).file;
          } catch {
            const { blob } = await grabAt(fileUrl(v.file!), 'last');
            file = (await api.upload(project.id, new File([blob], `frame-${Date.now()}.png`, { type: 'image/png' }))).file;
          }
          const cur = rf.getNode(n.id) as FlowNode | undefined;
          if (!cur) return;
          const ver: Version = { id: newId('v_'), kind: 'image', file, label: `${prev.data.title} 尾帧`, createdAt: new Date().toISOString() };
          const frameId = cur.data.firstFrame;
          const frameNode = frameId ? (rf.getNode(frameId) as FlowNode | undefined) : undefined;
          if (frameNode) {
            rf.updateNodeData(frameNode.id, { versions: [...frameNode.data.versions, ver], current: frameNode.data.versions.length });
            if (!rf.getEdges().some((e) => e.source === frameNode.id && e.target === n.id)) rf.addEdges({ id: newId('e_'), source: frameNode.id, target: n.id });
            rf.updateNodeData(n.id, { chainFrom: v.id });
          } else {
            const id = newId();
            const p = rf.getNode(prev.id) as FlowNode;
            const data = makeNodeData('image', `${prev.data.title} 尾帧`, models, project);
            data.versions = [ver];
            data.current = 0;
            rf.addNodes({ id, type: 'media', position: { x: p.position.x, y: p.position.y + (p.measured?.height || 260) + 60 }, data });
            rf.addEdges({ id: newId('e_'), source: id, target: n.id });
            rf.updateNodeData(n.id, { firstFrame: id, chainFrom: v.id });
          }
          if (cur.data.autoRun) {
            // 整集生成里等着的：尾帧连上了就自动开始。提交完再清 autoRun，中间不会被算成「没提交上」
            setTimeout(async () => {
              await submitRef.current(n.id, { skipBusyCheck: true, quiet: true, skipMissingCheck: true });
              rf.updateNodeData(n.id, { autoRun: undefined });
            }, 300);
            toast(`「${prev.data.title}」的最后一帧已连到「${cur.data.title}」，自动开始生成`);
          } else toast(`「${prev.data.title}」的最后一帧已连到「${cur.data.title}」当首帧，可以生成它了`);
        } catch (e: any) {
          chainFailed.current.add(key);
          // 整集生成在等它的：接不上了，别让整集一直等
          if ((rf.getNode(n.id) as FlowNode | undefined)?.data.autoRun) rf.updateNodeData(n.id, { autoRun: undefined });
          toast(`截「${prev.data.title}」的尾帧失败：${e.message || e}——可以在它的视频右上角点相机手动截尾帧，再连到下一条`, 'error');
        } finally {
          chainBusy.current.delete(key);
        }
      })();
    }
  }, [nodes, loaded]);

  // —— 整集生成：成片节点上点「生成全部片段」 ——
  const runClips: CanvasCtx['runClips'] = useCallback(
    async (cutId, ids) => {
      const vids = ids.filter((id) => (rf.getNode(id) as FlowNode | undefined)?.data.kind === 'video');
      if (!vids.length) return toast('成片节点上还没有连视频片段', 'error');
      // 已经有视频的默认不重做，只生成还没生成的
      const todo = vids.filter((id) => !activeVersion((rf.getNode(id) as FlowNode).data)?.file && !activeOf(id));
      if (!todo.length) return toast('这些片段都已经生成过了（要重做某条，点进去单独生成）');
      let total = 0;
      let unknown = 0;
      for (const id of todo) {
        const n = rf.getNode(id) as FlowNode;
        const m = models.find((x) => x.id === n.data.gen.modelId) || pickModel(models, 'video');
        const c = m ? estimateCostNumber(m, { ...n.data.gen.params }) : undefined;
        if (c === undefined) unknown += 1;
        else total += c;
      }
      const chained = todo.filter((id) => (rf.getNode(id) as FlowNode).data.chainPrev).length;
      const miss = missingImages(todo);
      const ok = await confirmDialog({
        title: `生成整集：${todo.length} 条片段`,
        message: [
          `预估花费 ¥${total.toFixed(2)}${unknown ? `（另有 ${unknown} 条的模型没填单价，没算进去）` : ''}`,
          vids.length > todo.length ? `已经有视频的 ${vids.length - todo.length} 条不重做。` : '',
          chained ? `其中 ${chained} 条要接上一条的尾帧：上一条生成好后会自动截尾帧、连上、再开始生成，不用你管。` : '',
          '全部完成后会提醒你（不在这个页面也会弹系统通知）。',
          miss.size ? `\n⚠️ 这些参考还没有图（只写了名字，模型不知道长什么样）：\n${missingText(miss)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        okText: `开始生成 ${todo.length} 条`,
      });
      if (!ok) return;
      askNotifyPermission();
      // 先全部标上 autoRun（= 归整集生成管），提交一条清一条；没提交上的清掉后算「没提交上」
      for (const id of todo) rf.updateNodeData(id, { autoRun: true });
      rf.updateNodeData(cutId, { batch: { startedAt: new Date().toISOString(), clips: todo } });
      let sent = 0;
      let waiting = 0;
      let failed = 0;
      for (const id of todo) {
        if (needsFrame(rf.getNode(id) as FlowNode)) {
          waiting += 1;
          continue;
        }
        if (await submit(id, { skipBusyCheck: true, quiet: true, skipMissingCheck: true })) sent += 1;
        else failed += 1;
        rf.updateNodeData(id, { autoRun: undefined });
      }
      toast(
        `整集生成开始：先提交了 ${sent} 条${waiting ? `，${waiting} 条等上一条的尾帧自动开始` : ''}${failed ? `，${failed} 条没提交上（见上面的提示）` : ''}`,
        failed ? 'error' : 'info',
      );
    },
    [models, submit],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // 整集生成跑完了：提醒一下（不在页面时弹系统通知）
  useEffect(() => {
    if (!loaded) return;
    for (const n of nodes) {
      const batch = n.data.batch as { startedAt: string; clips: string[] } | undefined;
      if (n.data.kind !== 'cut' || !batch) continue;
      const pr = batchProgress(batch, jobs, (id) => (nodes.find((x) => x.id === id)?.data as NodeData | undefined));
      if (!pr.finished) continue;
      rf.updateNodeData(n.id, { batch: undefined });
      for (const id of batch.clips) if ((rf.getNode(id) as FlowNode | undefined)?.data.autoRun) rf.updateNodeData(id, { autoRun: undefined });
      const bad = pr.failed + pr.blocked + pr.skipped;
      const msg = bad
        ? `「${n.data.title}」整集生成结束：成功 ${pr.done} 条${pr.failed ? `，失败 ${pr.failed} 条` : ''}${pr.skipped ? `，${pr.skipped} 条没提交上` : ''}${pr.blocked ? `，${pr.blocked} 条因为上一条没成功没法接尾帧` : ''}——点进去单独生成`
        : `「${n.data.title}」整集 ${pr.done} 条全部生成好了，可以点「拼接」出成片`;
      toast(msg, bad ? 'error' : 'info');
      notify(bad ? '整集生成结束（有失败）' : '整集生成好了', msg, !bad);
    }
  }, [jobs, nodes, loaded]);

  const openAddMenu: CanvasCtx['openAddMenu'] = useCallback((screen, opts) => setMenu({ ...screen, ...opts }), []);

  const ctx: CanvasCtx = useMemo(
    () => ({ addNode, uploadAsNode, submit, submitMany, runClips, toFlow: (p) => rf.screenToFlowPosition(p), openAddMenu, expandScript }),
    [addNode, uploadAsNode, submit, submitMany, runClips, openAddMenu, expandScript],
  );

  // —— 选中节点时，让节点和下面的生成面板整个露出来（不被屏幕边、左侧工具栏、小地图挡住） ——
  const revealNode = useCallback((id: string) => {
    // 等面板渲染出来再量
    setTimeout(() => {
      const nodeEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      if (!nodeEl) return;
      const r = nodeEl.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>('.panel-toolbar')?.getBoundingClientRect();
      const box = panel ? { left: Math.min(r.left, panel.left), right: Math.max(r.right, panel.right), top: Math.min(r.top, panel.top), bottom: Math.max(r.bottom, panel.bottom) } : r;
      // 资产管理面板开着时，左边还要让出面板的宽度
      const left = (document.querySelector('.canvas-wrap.panel-open') ? 312 : 0) + 84;
      const area = { left, right: window.innerWidth - 16, top: 64, bottom: window.innerHeight - 16 };
      let dx = 0;
      let dy = 0;
      if (box.right - box.left <= area.right - area.left) {
        if (box.left < area.left) dx = area.left - box.left;
        else if (box.right > area.right) dx = area.right - box.right;
      }
      // 太高放不下时，优先保证面板底部（模型、生成按钮）露出来
      if (box.bottom > area.bottom) dy = area.bottom - box.bottom;
      else if (box.top < area.top) dy = area.top - box.top;
      if (box.bottom - box.top > area.bottom - area.top) dy = area.bottom - box.bottom;
      if (!dx && !dy) return;
      const vp = rf.getViewport();
      rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 260 });
    }, 60);
  }, []);

  // —— 菜单选中 ——
  const onPick = (a: AddMenuAction) => {
    if (!menu) return;
    const pos = rf.screenToFlowPosition({ x: menu.x, y: menu.y });
    const link = { connectFrom: menu.connectFrom, connectTo: menu.connectTo };
    setMenu(null);
    if (a.upload) {
      pendingUploadPos.current = { pos, ...link };
      uploadRef.current?.click();
      return;
    }
    if (a.importStoryboard) {
      storyboardRef.current?.click();
      return;
    }
    if (a.history) {
      pickFromHistory((file, kind, createdAt) => addNode(kind, pos, { version: { kind, file, label: '历史', createdAt }, ...link }));
      return;
    }
    if (a.kind) {
      addNode(a.kind, pos, {
        title: a.title,
        text: a.text,
        characterId: a.characterId,
        version: a.characterImage ? { kind: 'image', file: a.characterImage, label: '设定库', variant: a.variant } : undefined,
        ...link,
      });
    }
  };

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: newId('e_') }, es)), []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode) return;
    const pt = 'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent);
    // 从输出口拖出 → 新节点接在后面；从输入口拖出 → 新节点接在前面
    const fromSource = state.fromHandle?.type === 'source';
    setMenu({ x: pt.clientX, y: pt.clientY, ...(fromSource ? { connectFrom: state.fromNode.id } : { connectTo: state.fromNode.id }) });
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const t = rf.getNode(c.target) as FlowNode | undefined;
    const s = rf.getNode(c.source) as FlowNode | undefined;
    if (!t || !s) return false;
    if (t.data.kind === 'script' && !s.data.characterId) return false; // 脚本只接设定库里的图（角色 / 场景 / 道具）
    if (t.data.kind === 'cut' && s.data.kind !== 'video' && s.data.kind !== 'cut') return false; // 成片只接视频
    return !rf.getEdges().some((e) => e.source === c.source && e.target === c.target);
  }, []);

  // —— 复制 / 粘贴 / 创建副本（⌘C / ⌘V / ⌘D），复制的节点能粘到别的画布 ——
  const mouse = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  // 添加菜单刚被哪一下鼠标关掉：同一次右键不再弹出新菜单、同一次双击也不再打开（菜单开着时点一下 = 收起）
  const menuClosedBy = useRef<{ at: number; button: number } | null>(null);
  const closedBySame = (button: number) => {
    const c = menuClosedBy.current;
    return Boolean(c && c.button === button && Date.now() - c.at < 500);
  };
  const overlayOpen = () => Boolean(document.querySelector('.modal-mask, .lightbox'));
  const copySelected = () => {
    const sel = rf.getNodes().filter((n) => n.selected);
    if (!sel.length) return false;
    const ids = new Set(sel.map((n) => n.id));
    // 系统剪贴板里留一个标记：之后剪贴板换成别的文字，就不再粘出这批旧节点
    const marker = `ai-drama-studio 节点 ×${sel.length} · ${Date.now()}`;
    navigator.clipboard?.writeText(marker).catch(() => undefined);
    const clip = {
      marker,
      nodes: sel.map((n) => ({ id: n.id, position: n.position, data: n.data, w: n.measured?.width })),
      // 只带选中节点之间的连线
      edges: rf.getEdges().filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target })),
    };
    localStorage.setItem('canvasClipboard', JSON.stringify(clip));
    return true;
  };
  /** systemText：系统剪贴板里现在的文字；和复制时留的标记对不上就不粘（说明后来复制过别的东西） */
  const pasteNodes = (at?: { x: number; y: number }, systemText?: string) => {
    let clip: { marker?: string; nodes: { id: string; position: { x: number; y: number }; data: NodeData }[]; edges: { source: string; target: string }[] };
    try {
      clip = JSON.parse(localStorage.getItem('canvasClipboard') || '');
    } catch {
      return false;
    }
    if (!clip?.nodes?.length) return false;
    if (systemText && systemText !== clip.marker) return false;
    const minX = Math.min(...clip.nodes.map((n) => n.position.x));
    const minY = Math.min(...clip.nodes.map((n) => n.position.y));
    const origin = at ? rf.screenToFlowPosition(at) : { x: minX + 60, y: minY + 60 };
    const map = new Map(clip.nodes.map((n) => [n.id, newId()]));
    const copies: FlowNode[] = clip.nodes.map((n) => {
      const data = structuredClone(n.data) as NodeData;
      delete data.run;
      return { id: map.get(n.id)!, type: 'media', position: { x: origin.x + n.position.x - minX, y: origin.y + n.position.y - minY }, data, selected: true };
    });
    rf.setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...copies]);
    rf.setEdges((es) => [...es, ...clip.edges.map((e) => ({ id: newId('e_'), source: map.get(e.source)!, target: map.get(e.target)! }))]);
    toast(`已粘贴 ${copies.length} 个节点`, 'info', { label: '撤销', onClick: undo });
    return true;
  };
  const pasteRef = useRef(pasteNodes);
  pasteRef.current = pasteNodes;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      // ⌘S：哪里都能用，立刻保存
      if (k === 's') {
        e.preventDefault();
        saveRef.current();
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return; // 输入框里用浏览器自己的
      if (overlayOpen()) return; // 弹窗、大图预览开着时不动画布
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      } else if (k === 'a') {
        e.preventDefault();
        rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (k === 'c') {
        if (window.getSelection()?.toString()) return; // 选中了文字就复制文字
        if (copySelected()) e.preventDefault();
      } else if (k === 'd') {
        e.preventDefault();
        if (copySelected()) pasteRef.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ⌘/Ctrl + 回车：生成选中的节点（按住不放不会连发）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (overlayOpen()) return;
      submitMany(rf.getNodes().filter((n) => n.selected && KIND_CAP[n.data.kind]).map((n) => n.id));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [submit]);

  useEffect(() => {
    try {
      localStorage.setItem('canvasTool', tool);
      if (panel) localStorage.setItem('assetPanel', panel);
      else localStorage.removeItem('assetPanel');
    } catch {}
  }, [tool, panel]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'h' || e.key === 'H') setTool('hand');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const centerScreen = () => ({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 200 });

  // —— 从桌面拖进来 / 粘贴进来的素材：图片变图片节点，视频变视频节点，音频变音频节点 ——
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    // 文件被节点 / 生成面板接走时，画布收不到 drop：在捕获阶段统一复位
    const reset = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);
  const placeFiles = useCallback(
    async (filesIn: File[], at: { x: number; y: number }) => {
      // 分镜 JSON：走导入分镜
      const jsons = filesIn.filter((f) => /\.json$/i.test(f.name));
      for (const j of jsons) await importStoryboardFile(j);
      const files = filesIn.filter((f) => !jsons.includes(f));
      if (!files.length) return;
      const ok = files.filter((f) => /^(image|video|audio)\//.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a)$/i.test(f.name));
      if (!ok.length) return toast('只支持图片、视频、音频文件', 'error');
      if (ok.length < files.length) toast(`有 ${files.length - ok.length} 个文件不是图片 / 视频 / 音频，已跳过`);
      const start = rf.screenToFlowPosition(at);
      // 多个文件按 4 列网格摆开
      await Promise.all(ok.map((f, i) => uploadAsNode(f, { x: start.x + (i % 4) * 380, y: start.y + Math.floor(i / 4) * 420 })));
    },
    [uploadAsNode, importStoryboardFile],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) {
        if (overlayOpen()) return;
        if (pasteRef.current(mouse.current, e.clipboardData?.getData('text/plain') || '')) e.preventDefault();
        return;
      }
      e.preventDefault();
      placeFiles(files, centerScreen());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [placeFiles]);

  return (
    <CanvasContext.Provider value={ctx}>
      <div
        className={`canvas-wrap ${panel ? 'panel-open' : ''}`}
        onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY })}
        onDoubleClick={(e) => {
          if (closedBySame(0)) return; // 菜单开着时双击 = 收起
          if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragEnter={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const files = [...e.dataTransfer.files];
          if (files.length) placeFiles(files, { x: e.clientX - 170, y: e.clientY - 120 });
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          // 点画布空白处：收起资产管理侧边栏（点节点不收，方便一边看列表一边点）
          onPaneClick={() => setPanel(null)}
          onNodeClick={(e, n) => {
            if (!e.shiftKey && !e.metaKey && n.data.kind !== 'script') revealNode(n.id);
          }}
          onEdgeMouseEnter={(_, e) => onEdgeHover(e.id)}
          onEdgeMouseLeave={() => onEdgeHover(null)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            // 菜单开着时右键 = 收起（按下鼠标那一下已经关掉了），不在新位置再弹一个
            if (closedBySame(2)) return;
            setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
          }}
          onMoveEnd={(_, vp) => {
            viewport.current = vp;
            scheduleSave();
          }}
          selectionOnDrag={tool === 'select'}
          panOnDrag={tool === 'hand' ? true : [1]}
          selectionMode={SelectionMode.Partial}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2.5}
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Meta', 'Shift']}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
          defaultEdgeOptions={{ type: 'default' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="#2a2a31" />
          {/* 选中一个节点时下面会弹出生成面板，小地图会盖住面板右下角：这时先藏起来 */}
          {nodes.filter((n) => n.selected).length !== 1 && <MiniMap position="bottom-right" pannable zoomable nodeColor="#3a3a3a" maskColor="rgba(0,0,0,.55)" />}
          <SelectionBar
            undo={undo}
            onDone={() =>
              setTimeout(() => {
                window.clearTimeout(snapTimer.current);
                commitSnapshot();
              }, 60)
            }
          />
        </ReactFlow>

        <div className="history-tools">
          <button title="撤销（⌘Z）" onClick={undo} disabled={!past.current.length}>
            <Undo2 size={16} />
          </button>
          <button title="重做（⌘⇧Z）" onClick={redo} disabled={!future.current.length}>
            <Redo2 size={16} />
          </button>
          <span className="tool-sep" />
          <button className={tool === 'select' ? 'on' : ''} title="选择（V）：左键拖动框选，按住空格拖动平移" onClick={() => setTool('select')}>
            <MousePointer2 size={16} />
          </button>
          <button className={tool === 'hand' ? 'on' : ''} title="抓手（H）：左键拖动平移画布" onClick={() => setTool('hand')}>
            <Hand size={16} />
          </button>
          <span className="tool-sep" />
          <button title="历史版本：找回之前的画布" onClick={() => setShowHistory(true)}>
            <History size={16} />
          </button>
          <span
            className={`save-state ${saveState}`}
            title={saveState === 'error' ? '保存失败，点一下重试（⌘S）' : '改动会自动保存；⌘S 立即保存'}
            onClick={() => saveState === 'error' && save()}
          >
            {saveState === 'saved' && (
              <>
                <Check size={13} /> 已保存
              </>
            )}
            {saveState === 'dirty' && '未保存'}
            {saveState === 'saving' && (
              <>
                <Loader2 size={13} className="spin" /> 保存中
              </>
            )}
            {saveState === 'error' && (
              <>
                <AlertTriangle size={13} /> 保存失败
              </>
            )}
          </span>
        </div>

        <div className="left-tools">
          <button title="添加节点（也可以双击画布空白处）" onClick={() => setMenu(centerScreen())}>
            <Plus size={20} />
          </button>
          <button title="设定库：角色、场景、道具" onClick={app.openCharacters}>
            <UsersRound size={18} />
          </button>
          <button
            title="从生成历史选择"
            onClick={() => pickFromHistory((file, kind, createdAt) => addNode(kind, rf.screenToFlowPosition(centerScreen()), { version: { kind, file, label: '历史', createdAt } }))}
          >
            <Clock size={18} />
          </button>
          <button title="资产库（所有画布共用）" onClick={() => setPanel(panel === 'assets' ? null : 'assets')}>
            <Archive size={18} />
          </button>
        </div>

        {panel && (
          <AssetPanel
            tab={panel}
            setTab={setPanel}
            nodes={nodes}
            undo={undo}
            onClose={() => setPanel(null)}
            onPlaceAsset={(a) => {
              const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2 + 80, y: window.innerHeight / 2 - 160 });
              if (a.file) addNode(a.kind, pos, { title: a.name, version: { kind: a.kind as any, file: a.file, label: '资产' } });
              else addNode(a.kind, pos, { title: a.name, text: a.text });
            }}
          />
        )}

        {showHistory && (
          <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setShowHistory(false)}>
            <div className="modal history-modal">
              <div className="modal-head">
                <b>历史版本</b>
                <span className="muted">每 2 分钟自动留一份；画布变空、恢复之前也会另存</span>
                <span className="spacer" />
                <button className="icon" onClick={() => setShowHistory(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className="pad">
                <BackupRestore
                  autoLoad
                  projectId={project.id}
                  episodeId={episode.id}
                  beforeRestore={flushThenPause}
                  onRestored={() => {
                    setShowHistory(false);
                    setReloadTick((t) => t + 1);
                    toast('已恢复。恢复前的画布留在了历史版本里');
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {loadError && (
          <div className="load-error">
            <AlertTriangle size={22} />
            <div className="le-title">这一集的画布读不出来</div>
            <div className="le-msg">{loadError}</div>
            <div className="le-actions">
              <button className="primary" onClick={() => setReloadTick((t) => t + 1)}>
                <RotateCcw size={14} /> 重试
              </button>
              <BackupRestore projectId={project.id} episodeId={episode.id} beforeRestore={pauseForRestore} onRestored={() => setReloadTick((t) => t + 1)} />
            </div>
          </div>
        )}

        <BottomBar panelOpen={!!panel} onTogglePanel={() => setPanel(panel ? null : 'canvas')} />

        {loaded && nodes.length === 0 && (
          <div className="empty-tip">
            双击画布空白处添加节点
            <br />
            <span>或者把图片、视频直接拖进来</span>
          </div>
        )}

        {dragging && (
          <div className="drop-mask">
            <div className="drop-box">
              <div className="drop-title">松开鼠标，放到画布上</div>
              <div className="drop-sub">图片 → 图片节点 · 视频 → 视频节点 · 音频 → 音频节点</div>
            </div>
          </div>
        )}

        {menu && (
          <AddNodeMenu
            x={menu.x}
            y={menu.y}
            onPick={onPick}
            onClose={(by) => {
              setMenu(null);
              menuClosedBy.current = by ? { at: Date.now(), button: by.button } : null;
            }}
          />
        )}

        <input
          ref={storyboardRef}
          type="file"
          hidden
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) importStoryboardFile(f);
          }}
        />
        <input
          ref={uploadRef}
          type="file"
          hidden
          accept="image/*,video/*,audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const p = pendingUploadPos.current;
            if (f && p) {
              api
                .upload(project.id, f)
                .then((up) =>
                  addNode(up.kind, p.pos, {
                    title: up.name?.replace(/\.[^.]+$/, ''),
                    version: { kind: up.kind, file: up.file, label: '上传' },
                    connectFrom: p.connectFrom,
                    connectTo: p.connectTo,
                  }),
                )
                .catch((err) => toast(err.message, 'error'));
            }
            e.target.value = '';
          }}
        />
      </div>
    </CanvasContext.Provider>
  );
}

/** 画布的历史版本：自动留的 bak1…bak20，加上「变空之前」另存的保险版本；挑一个恢复 */
function BackupRestore({
  projectId,
  episodeId,
  onRestored,
  beforeRestore,
  autoLoad,
}: {
  projectId: string;
  episodeId: string;
  onRestored: () => void;
  /** 恢复前调用：存掉页面上没存的改动，再停掉自动保存，免得旧内容又把恢复结果盖掉 */
  beforeRestore?: () => void | Promise<void>;
  autoLoad?: boolean;
}) {
  const [list, setList] = useState<{ name: string; savedAt?: string; nodeCount: number; kept?: 'empty' | 'restore' }[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api
      .canvasBackups(projectId, episodeId)
      .then(setList)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    if (autoLoad) load();
  }, []);
  if (!list)
    return (
      <>
        {!autoLoad && (
          <button className="ghost" onClick={load}>
            <Clock size={14} /> 从历史版本恢复
          </button>
        )}
        {autoLoad && !err && <div className="le-msg">读取中…</div>}
        {err && <div className="le-msg">{err}</div>}
      </>
    );
  if (!list.length) return <div className="le-msg">还没有历史版本（改动保存后每 2 分钟留一份）</div>;
  const when = (b: { savedAt?: string; name: string }) => (b.savedAt ? new Date(b.savedAt).toLocaleString() : b.name);
  return (
    <div className="le-backups">
      {list.map((b) => (
        <button
          key={b.name}
          className={`ghost ${b.kept ? 'kept' : ''}`}
          title={b.kept === 'empty' ? '画布变空 / 一下少了很多节点之前，自动另存的一份' : b.kept === 'restore' ? '恢复历史版本之前，自动另存的一份' : '自动保存时留的历史版本'}
          onClick={async () => {
            const ok = await confirmDialog({
              title: '用这个历史版本恢复？',
              message: `${when(b)} · ${b.nodeCount} 个节点\n现在的画布会先另存一份（列表里标「恢复之前另存」），不会丢。`,
              okText: '恢复',
            });
            if (!ok) return;
            await beforeRestore?.();
            try {
              await api.restoreBackup(projectId, episodeId, b.name);
              onRestored();
            } catch (e: any) {
              setErr(e.message);
            }
          }}
        >
          {when(b)} · {b.nodeCount} 个节点
          {b.kept && <span className="safe-tag">{b.kept === 'empty' ? '变空之前另存' : '恢复之前另存'}</span>}
        </button>
      ))}
      {err && <div className="le-msg">{err}</div>}
    </div>
  );
}

/** 左下角：资产管理开关 + 缩放 */
function BottomBar({ panelOpen, onTogglePanel }: { panelOpen: boolean; onTogglePanel: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="bottom-bar">
      <button className={`bb-assets ${panelOpen ? 'on' : ''}`} onClick={onTogglePanel} title="资产管理：画布上的所有节点、资产库">
        <PanelLeft size={16} /> 资产管理
      </button>
      <span className="tool-sep" />
      <button title="缩小" onClick={() => rf.zoomOut({ duration: 200 })}>
        <Minus size={15} />
      </button>
      <button className="bb-zoom" title="恢复 100%" onClick={() => rf.zoomTo(1, { duration: 250 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button title="放大" onClick={() => rf.zoomIn({ duration: 200 })}>
        <Plus size={15} />
      </button>
      <button className="bb-fit" title="显示全部节点" onClick={() => rf.fitView({ padding: 0.15, duration: 400 })}>
        <Maximize size={14} />
      </button>
    </div>
  );
}
