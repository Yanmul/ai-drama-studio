// 左侧「资产管理」面板（参考 LibTV）：
//  画布 —— 这张画布上的所有节点；点一条或点小飞机 → 镜头移过去并选中（弹出详情）；「…」里有重命名 / 复制 / 下载 / 保存到资产 / 删除
//  资产 —— 资产库（所有画布共用）；点一条放到画布中间；「…」里有重命名 / 删除
import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronsLeft, FileText, Image as ImageIcon, MoreHorizontal, Music, Play, ScrollText, Search, Send } from 'lucide-react';
import type { Asset, NodeData, NodeKind } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp } from '../context';
import { confirmDialog } from './Dialog';
import { KIND_LABEL, activeVersion, newId } from '../lib';

type FlowNode = Node<NodeData>;
type Kind = 'all' | NodeKind;
const KINDS: Kind[] = ['all', 'image', 'video', 'cut', 'audio', 'text', 'script'];

function Thumb({ kind, file }: { kind: NodeKind; file?: string }) {
  if (file && kind === 'image') return <img className="ap-thumb" src={fileUrl(file)} loading="lazy" />;
  if (file && (kind === 'video' || kind === 'cut'))
    return (
      <span className="ap-thumb vid">
        <video src={fileUrl(file)} muted preload="metadata" />
        <Play size={12} fill="currentColor" />
      </span>
    );
  const Icon = { image: ImageIcon, video: Play, audio: Music, text: FileText, script: ScrollText, cut: Play }[kind] || FileText;
  return (
    <span className="ap-thumb empty">
      <Icon size={16} />
    </span>
  );
}

function download(name: string, file?: string, text?: string) {
  const a = document.createElement('a');
  if (file) {
    a.href = fileUrl(file);
    a.download = name + (file.match(/\.[a-z0-9]+$/i)?.[0] || '');
  } else {
    a.href = URL.createObjectURL(new Blob([text || ''], { type: 'text/plain;charset=utf-8' }));
    a.download = `${name}.txt`;
  }
  a.click();
}

export function AssetPanel({
  tab,
  setTab,
  nodes,
  onClose,
  undo,
  onPlaceAsset,
}: {
  tab: 'canvas' | 'assets';
  setTab: (t: 'canvas' | 'assets') => void;
  nodes: FlowNode[];
  onClose: () => void;
  undo: () => void;
  onPlaceAsset: (a: Asset) => void;
}) {
  const { project, toast } = useApp();
  const rf = useReactFlow<FlowNode, Edge>();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [kindOpen, setKindOpen] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadAssets = () => api.assets().then(setAssets).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    if (tab === 'assets') loadAssets();
  }, [tab]);
  useEffect(() => {
    // 捕获阶段：点在画布上（React Flow 会拦住事件往外传）也能关掉「…」菜单；点在菜单本身、「更多」按钮上不关
    const close = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest?.('.ap-menu') || t.closest?.('button[title="更多"]')) return;
      setMenu(null);
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, []);

  const match = (title: string, k: NodeKind) => (kind === 'all' || k === kind) && (!q || title.toLowerCase().includes(q.toLowerCase()));
  // 新建的在上面
  const nodeRows = useMemo(() => [...nodes].reverse().filter((n) => match(n.data.title, n.data.kind)), [nodes, q, kind]);
  const assetRows = useMemo(() => (assets || []).filter((a) => match(a.name, a.kind)), [assets, q, kind]);

  // —— 画布节点 ——
  const locate = (id: string) => {
    const n = rf.getNode(id);
    if (!n) return;
    const w = n.measured?.width ?? 340;
    const h = n.measured?.height ?? 260;
    rf.setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === id })));
    rf.setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
    // 节点下面会弹出详情面板，所以镜头稍微往下偏一点
    const zoom = Math.max(rf.getZoom(), 0.85);
    // 左边被面板挡住 312px，镜头中心往左挪半个面板，节点才会在看得见的区域正中间
    rf.setCenter(n.position.x + w / 2 - 156 / zoom, n.position.y + h / 2 + 120 / zoom, { zoom, duration: 450 });
  };

  const duplicate = (id: string) => {
    const n = rf.getNode(id) as FlowNode | undefined;
    if (!n) return;
    const data = structuredClone(n.data) as NodeData;
    delete data.run;
    data.title = `${n.data.title} 副本`;
    const nid = newId();
    const w = n.measured?.width ?? 340;
    rf.addNodes({ id: nid, type: 'media', position: { x: n.position.x + w + 60, y: n.position.y }, data });
    rf.addEdges(rf.getEdges().filter((e) => e.target === id).map((e) => ({ id: newId('e_'), source: e.source, target: nid })));
    toast('已复制', 'info', { label: '撤销', onClick: undo });
  };

  const saveAsset = async (n: FlowNode) => {
    const v = activeVersion(n.data);
    const isText = n.data.kind === 'text' || n.data.kind === 'script';
    const text = isText ? (n.data.text || v?.text || '').trim() : undefined;
    if (isText ? !text : !v?.file) return toast('这个节点还是空的', 'error');
    const r = await api.addAssets([{ kind: n.data.kind, name: n.data.title, file: isText ? undefined : v!.file, text, projectId: project?.id }]);
    toast(r.added.length ? '已保存到资产库' : '资产库里已经有了');
  };

  // —— 资产 ——
  const placeAsset = (a: Asset) => {
    onPlaceAsset(a);
    toast(`已把「${a.name}」放到画布上`);
  };

  const menuNode = menu && tab === 'canvas' ? (nodes.find((n) => n.id === menu.id) as FlowNode | undefined) : undefined;
  const menuAsset = menu && tab === 'assets' ? assets?.find((a) => a.id === menu.id) : undefined;

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu(menu?.id === id ? null : { id, x: r.right + 6, y: Math.min(r.top, window.innerHeight - 250) });
  };

  const NameInput = ({ value, onDone }: { value: string; onDone: (v: string) => void }) => (
    <input
      className="ap-rename"
      autoFocus
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(null);
      }}
    />
  );

  const count = tab === 'canvas' ? nodes.length : assets?.length ?? 0;

  return (
    <aside className="asset-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="ap-tabs">
        <button className={tab === 'canvas' ? 'on' : ''} onClick={() => setTab('canvas')}>
          画布
        </button>
        <button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
          资产
        </button>
      </div>

      <div className="ap-tools">
        <label className="ap-search">
          <Search size={14} />
          <input placeholder={tab === 'canvas' ? '搜索节点' : '搜索资产'} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="ap-kind-wrap">
          <button className="ap-kind" onClick={() => setKindOpen(!kindOpen)}>
            {kind === 'all' ? '全部类型' : KIND_LABEL[kind]}
          </button>
          {kindOpen && (
            <div className="ap-pop" onMouseDown={(e) => e.stopPropagation()}>
              {KINDS.map((k) => (
                <button
                  key={k}
                  className={k === kind ? 'on' : ''}
                  onClick={() => {
                    setKind(k);
                    setKindOpen(false);
                  }}
                >
                  {k === 'all' ? '全部类型' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ap-list" ref={listRef} onScroll={() => setMenu(null)}>
        {tab === 'canvas' &&
          nodeRows.map((n) => {
            const v = activeVersion(n.data);
            return (
              <div key={n.id} className={`ap-row ${n.selected ? 'on' : ''} ${menu?.id === n.id ? 'menu' : ''}`} onClick={() => locate(n.id)}>
                <Thumb kind={n.data.kind} file={v?.file} />
                {editing === n.id ? (
                  <NameInput
                    value={n.data.title}
                    onDone={(t) => {
                      if (t) rf.updateNodeData(n.id, { title: t });
                      setEditing(null);
                    }}
                  />
                ) : (
                  <span className="ap-name" title={n.data.title}>
                    {n.data.title}
                  </span>
                )}
                <span className="ap-acts">
                  <button title="更多" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => openMenu(e, n.id)}>
                    <MoreHorizontal size={16} />
                  </button>
                  <button
                    title="定位到节点"
                    onClick={(e) => {
                      e.stopPropagation();
                      locate(n.id);
                    }}
                  >
                    <Send size={14} />
                  </button>
                </span>
              </div>
            );
          })}

        {tab === 'assets' &&
          assetRows.map((a) => (
            <div key={a.id} className={`ap-row ${menu?.id === a.id ? 'menu' : ''}`} onClick={() => placeAsset(a)} title="点一下放到画布上">
              <Thumb kind={a.kind} file={a.file} />
              {editing === a.id ? (
                <NameInput
                  value={a.name}
                  onDone={async (t) => {
                    setEditing(null);
                    if (t && t !== a.name) {
                      await api.renameAsset(a.id, t);
                      loadAssets();
                    }
                  }}
                />
              ) : (
                <span className="ap-name" title={a.text || a.name}>
                  {a.name}
                </span>
              )}
              <span className="ap-acts">
                <button title="更多" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => openMenu(e, a.id)}>
                  <MoreHorizontal size={16} />
                </button>
              </span>
            </div>
          ))}

        {tab === 'canvas' && nodeRows.length === 0 && <div className="ap-empty">{nodes.length ? '没有找到' : '画布上还没有节点'}</div>}
        {tab === 'assets' && assets && assetRows.length === 0 && (
          <div className="ap-empty">
            {assets.length ? (
              '没有找到'
            ) : (
              <>
                <Archive size={22} strokeWidth={1.4} />
                <br />
                资产库是空的
                <br />
                框选节点 → 保存到资产
              </>
            )}
          </div>
        )}
      </div>

      <div className="ap-foot">
        <button className="ap-collapse" title="收起" onClick={onClose}>
          <ChevronsLeft size={16} />
        </button>
        <span className="spacer" />
        <span>
          共 {count} {tab === 'canvas' ? '个节点' : '个资产'}
        </span>
      </div>

      {menuNode && (
        <div className="ap-pop ap-menu" style={{ left: menu!.x, top: menu!.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => (setEditing(menuNode.id), setMenu(null))}>重命名</button>
          <button onClick={() => (duplicate(menuNode.id), setMenu(null))}>复制</button>
          <button
            disabled={!activeVersion(menuNode.data)?.file && !(menuNode.data.text || '').trim()}
            onClick={() => {
              const v = activeVersion(menuNode.data);
              download(menuNode.data.title, v?.file, menuNode.data.text || v?.text);
              setMenu(null);
            }}
          >
            下载
          </button>
          <button onClick={() => (saveAsset(menuNode), setMenu(null))}>保存到资产</button>
          <div className="ap-pop-sep" />
          <button
            className="danger"
            onClick={() => {
              rf.deleteElements({ nodes: [{ id: menuNode.id }] });
              setMenu(null);
              toast(`已删除「${menuNode.data.title}」`, 'info', { label: '撤销', onClick: undo });
            }}
          >
            删除
          </button>
        </div>
      )}

      {menuAsset && (
        <div className="ap-pop ap-menu" style={{ left: menu!.x, top: menu!.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => (placeAsset(menuAsset), setMenu(null))}>放到画布</button>
          <button onClick={() => (setEditing(menuAsset.id), setMenu(null))}>重命名</button>
          <button onClick={() => (download(menuAsset.name, menuAsset.file, menuAsset.text), setMenu(null))}>下载</button>
          <div className="ap-pop-sep" />
          <button
            className="danger"
            onClick={async () => {
              setMenu(null);
              const ok = await confirmDialog({ title: `从资产库删除「${menuAsset.name}」？`, message: '画布上已经用到的不受影响。', okText: '删除', danger: true });
              if (!ok) return;
              try {
                await api.deleteAsset(menuAsset.id);
                loadAssets();
              } catch (e: any) {
                toast(e.message, 'error');
              }
            }}
          >
            删除
          </button>
        </div>
      )}
    </aside>
  );
}
