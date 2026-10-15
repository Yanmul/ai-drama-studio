// 节点画布（操作方式参考 ComfyUI，节点参考 LibTV）。
// 一集一张画布，存在 workspace/projects/<项目>/episodes/<集>/canvas.json，改动自动保存。
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
  type Viewport,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Clock, Hand, MousePointer2, Plus, Redo2, Undo2, UsersRound } from 'lucide-react';
import type { CanvasFile, Episode, Job, NodeData, NodeKind, Project, Version } from '../shared/types';
import { api } from './api';
import { AddNodeMenu, type AddMenuAction } from './components/AddNodeMenu';
import { CanvasContext, useApp, type CanvasCtx } from './context';
import { buildRequest } from './inputs';
import { KIND_CAP, KIND_LABEL, makeNodeData, newId, pickModel } from './lib';
import { MediaNode } from './nodes/MediaNode';
import { FlowEdge } from './edges/FlowEdge';
import { SelectionBar } from './components/SelectionBar';
import { AssetLibrary } from './components/Modals';

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
      versions.push({ id: newId('v_'), kind: 'text', text: d.text, createdAt: j.createdAt, label: '原文' });
    }
    for (const o of j.outputs || []) {
      versions.push({ id: newId('v_'), kind: o.kind, file: o.file, text: o.text, jobId: j.id, createdAt: j.finishedAt || j.createdAt });
      if (o.kind === 'text') text = o.text;
    }
    byId.set(n.id, { ...n, data: { ...d, versions, current: versions.length - 1, text } });
    changed = true;
  }
  return changed ? nodes.map((n) => byId.get(n.id)!) : nodes;
}

export function Canvas({ project, episode }: { project: Project; episode: Episode }) {
  const app = useApp();
  const { models, jobs, toast, pickFromHistory } = app;
  const rf = useReactFlow<FlowNode, Edge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loaded, setLoaded] = useState(false);
  // 鼠标工具：select = 左键拖动框选（空格 / 中键拖动平移）；hand = 左键拖动平移
  const [tool, setTool] = useState<'select' | 'hand'>(() => (localStorage.getItem('canvasTool') as any) || 'select');
  const [showAssets, setShowAssets] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; connectFrom?: string; connectTo?: string } | null>(null);
  const viewport = useRef<Viewport | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const uploadRef = useRef<HTMLInputElement>(null);
  const pendingUploadPos = useRef<{ pos: { x: number; y: number }; connectTo?: string; connectFrom?: string } | null>(null);
  // —— 撤销 / 重做：画布停手 0.4 秒记一个快照，⌘Z 退回上一个 ——
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastSnap = useRef('');
  const restoring = useRef(false);
  const snapTimer = useRef<number | undefined>(undefined);
  const [, bumpHistory] = useState(0);
  const snapshot = () =>
    JSON.stringify({
      nodes: rf.getNodes().map((n) => ({ id: n.id, position: n.position, data: n.data })),
      edges: rf.getEdges().map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
    });
  const commitSnapshot = () => {
    const s = snapshot();
    if (s === lastSnap.current) return;
    if (lastSnap.current) past.current.push(lastSnap.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    lastSnap.current = s;
    bumpHistory((x) => x + 1);
  };
  const applySnapshot = (s: string) => {
    const v = JSON.parse(s);
    restoring.current = true;
    window.clearTimeout(snapTimer.current);
    setNodes(v.nodes.map((n: any) => ({ ...n, type: 'media' })));
    setEdges(v.edges);
    lastSnap.current = s;
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
  const displayEdges = useMemo(() => {
    const selNodes = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
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
  }, [edges, nodes, hoverEdge]);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // —— 读画布 ——
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    api
      .canvas(project.id, episode.id)
      .then((c) => {
        if (!alive) return;
        const ns = applyJobs((c.nodes || []).map((n) => ({ ...n, type: 'media' })) as FlowNode[], jobsRef.current, episode.id);
        setNodes(ns);
        setEdges((c.edges || []) as Edge[]);
        viewport.current = c.viewport;
        if (c.viewport) rf.setViewport(c.viewport);
        else setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
        past.current = [];
        future.current = [];
        lastSnap.current = '';
        setLoaded(true);
      })
      .catch((e) => toast(`读取画布失败：${e.message}`, 'error'));
    return () => {
      alive = false;
    };
  }, [project.id, episode.id]);

  // —— 新结果进来，放进节点 ——
  useEffect(() => {
    if (loaded) setNodes((ns) => applyJobs(ns, jobs, episode.id));
  }, [jobs, loaded, episode.id]);

  // —— 自动保存（停手 0.8 秒后存） ——
  const save = useCallback(() => {
    const body: CanvasFile = {
      nodes: rf.getNodes().map((n) => ({ id: n.id, type: 'media', position: n.position, data: n.data })),
      edges: rf.getEdges().map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
      viewport: viewport.current,
    };
    api.saveCanvas(project.id, episode.id, body).catch((e) => toast(`保存失败：${e.message}`, 'error'));
  }, [project.id, episode.id]);

  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, 800);
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    window.clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(() => {
      if (!rf.getNodes().some((n) => n.dragging)) commitSnapshot();
    }, 400);
  }, [nodes, edges, loaded, save]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // —— 节点操作 ——
  const countOf = (kind: NodeKind) => rf.getNodes().filter((n) => n.data.kind === kind).length;

  const addNode: CanvasCtx['addNode'] = useCallback(
    (kind, pos, opts = {}) => {
      const id = newId();
      const data = makeNodeData(kind, opts.title || `${KIND_LABEL[kind]}节点 ${countOf(kind) + 1}`, models, project.ratio, {
        characterId: opts.characterId,
        text: opts.text ?? (kind === 'text' || kind === 'script' ? '' : undefined),
      });
      if (opts.version) {
        data.versions = [{ ...opts.version, id: newId('v_'), createdAt: new Date().toISOString() }];
        data.current = 0;
      }
      rf.addNodes({ id, type: 'media', position: pos, data, selected: false });
      const newEdges: Edge[] = [];
      if (opts.connectTo) newEdges.push({ id: newId('e_'), source: id, target: opts.connectTo });
      if (opts.connectFrom) newEdges.push({ id: newId('e_'), source: opts.connectFrom, target: id });
      if (newEdges.length) rf.addEdges(newEdges);
      return id;
    },
    [models, project.ratio],
  );

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

  const submit = useCallback(
    async (nodeId: string) => {
      const n = rf.getNode(nodeId) as FlowNode | undefined;
      if (!n) return;
      const cap = KIND_CAP[n.data.kind];
      if (!cap) return;
      const model = models.find((m) => m.id === n.data.gen.modelId) || pickModel(models, cap);
      if (!model) return toast(`还没有可用的${KIND_LABEL[n.data.kind]}模型`, 'error');
      const sources = rf
        .getEdges()
        .filter((e) => e.target === nodeId)
        .map((e) => rf.getNode(e.source) as FlowNode | undefined)
        .filter(Boolean)
        .map((s) => ({ id: s!.id, data: s!.data }));
      const req = buildRequest(project.id, episode.id, nodeId, n.data, model, sources);
      if (!req.prompt.trim() && !req.inputTexts.length && !req.refs.length) return toast('先写点提示词，或者连一个文本节点进来', 'error');
      try {
        const created = await api.generate(req);
        app.setJobs((prev) => [...created, ...prev.filter((p) => !created.some((c) => c.id === p.id))]);
        toast(created.length > 1 ? `已提交 ${created.length} 个任务` : '已提交，生成好了会自动出现在节点里');
      } catch (e: any) {
        toast(e.message, 'error');
      }
    },
    [models, project.id, episode.id],
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

  const openAddMenu: CanvasCtx['openAddMenu'] = useCallback((screen, opts) => setMenu({ ...screen, ...opts }), []);

  const ctx: CanvasCtx = useMemo(
    () => ({ addNode, uploadAsNode, submit, toFlow: (p) => rf.screenToFlowPosition(p), openAddMenu, expandScript }),
    [addNode, uploadAsNode, submit, openAddMenu, expandScript],
  );

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
    if (a.history) {
      pickFromHistory((file, kind) => addNode(kind, pos, { version: { kind, file, label: '历史' }, ...link }));
      return;
    }
    if (a.kind) {
      addNode(a.kind, pos, {
        title: a.title,
        text: a.text,
        characterId: a.characterId,
        version: a.characterImage ? { kind: 'image', file: a.characterImage, label: '角色库' } : undefined,
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
    if (t.data.kind === 'script' && !s.data.characterId) return false; // 脚本只接角色图
    return !rf.getEdges().some((e) => e.source === c.source && e.target === c.target);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return; // 输入框里用浏览器自己的撤销
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ⌘/Ctrl + 回车：生成选中的节点
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      rf.getNodes()
        .filter((n) => n.selected && KIND_CAP[n.data.kind])
        .forEach((n) => submit(n.id));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [submit]);

  useEffect(() => {
    try {
      localStorage.setItem('canvasTool', tool);
    } catch {}
  }, [tool]);
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
  const placeFiles = useCallback(
    async (files: File[], at: { x: number; y: number }) => {
      const ok = files.filter((f) => /^(image|video|audio)\//.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a)$/i.test(f.name));
      if (!ok.length) return toast('只支持图片、视频、音频文件', 'error');
      if (ok.length < files.length) toast(`有 ${files.length - ok.length} 个文件不是图片 / 视频 / 音频，已跳过`);
      const start = rf.screenToFlowPosition(at);
      // 多个文件按 4 列网格摆开
      await Promise.all(ok.map((f, i) => uploadAsNode(f, { x: start.x + (i % 4) * 380, y: start.y + Math.floor(i / 4) * 420 })));
    },
    [uploadAsNode],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      placeFiles(files, centerScreen());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [placeFiles]);

  return (
    <CanvasContext.Provider value={ctx}>
      <div
        className="canvas-wrap"
        onDoubleClick={(e) => {
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
          onEdgeMouseEnter={(_, e) => onEdgeHover(e.id)}
          onEdgeMouseLeave={() => onEdgeHover(null)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
          }}
          onMoveEnd={(_, vp) => {
            viewport.current = vp;
            window.clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(save, 800);
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
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable nodeColor="#3a3a3a" maskColor="rgba(0,0,0,.55)" />
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
        </div>

        <div className="left-tools">
          <button title="添加节点（也可以双击画布空白处）" onClick={() => setMenu(centerScreen())}>
            <Plus size={20} />
          </button>
          <button title="角色库" onClick={app.openCharacters}>
            <UsersRound size={18} />
          </button>
          <button
            title="从生成历史选择"
            onClick={() => pickFromHistory((file, kind) => addNode(kind, rf.screenToFlowPosition(centerScreen()), { version: { kind, file, label: '历史' } }))}
          >
            <Clock size={18} />
          </button>
          <button title="资产库（所有画布共用）" onClick={() => setShowAssets(true)}>
            <Archive size={18} />
          </button>
        </div>

        {showAssets && (
          <AssetLibrary
            onClose={() => setShowAssets(false)}
            onPick={(a) => {
              const pos = rf.screenToFlowPosition(centerScreen());
              if (a.file) addNode(a.kind, pos, { title: a.name, version: { kind: a.kind as any, file: a.file, label: '资产' } });
              else addNode(a.kind, pos, { title: a.name, text: a.text });
            }}
          />
        )}

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

        {menu && <AddNodeMenu x={menu.x} y={menu.y} onPick={onPick} onClose={() => setMenu(null)} />}

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
