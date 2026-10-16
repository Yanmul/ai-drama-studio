// 选中节点后出现在上方的一条工具栏：生成、排列（宫格 / 水平 / 垂直）、保存到资产、创建副本、删除
// 选中多个时用虚线框住；只选一个时不画框、不显示排列
import { useStore, useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { ChevronDown, Copy, LayoutGrid, LayoutPanelLeft, Columns3, Rows3, Trash2, Archive, ArrowUp, Film } from 'lucide-react';
import type { NodeData } from '../../shared/types';
import { api } from '../api';
import { useApp, useCanvas } from '../context';
import { KIND_CAP, activeVersion, makeNodeData, newId } from '../lib';

type FlowNode = Node<NodeData>;
const GAP = 48;
const PAD = 18; // 虚线框比节点大一圈（屏幕像素）

const size = (n: FlowNode) => ({ w: n.measured?.width ?? 340, h: n.measured?.height ?? 260 });

export function SelectionBar({ onDone, undo }: { onDone: () => void; undo: () => void }) {
  const { project, toast } = useApp();
  const { submitMany } = useCanvas();
  const rf = useReactFlow<FlowNode, Edge>();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  // 只订阅需要的东西：选中节点的位置大小 + 视口
  const key = useStore((s) =>
    s.nodes
      .filter((n) => n.selected)
      .map((n) => `${n.id}:${Math.round(n.position.x)}:${Math.round(n.position.y)}:${n.measured?.width}:${n.measured?.height}`)
      .join('|'),
  );
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const dragging = useStore((s) => s.nodes.some((n) => n.dragging) || s.userSelectionActive);

  useEffect(() => setMenu(false), [key]);

  const sel = key ? (rf.getNodes().filter((n) => n.selected) as FlowNode[]) : [];
  if (!sel.length) return null;
  const multi = sel.length > 1;
  const gens = sel.filter((n) => KIND_CAP[n.data.kind]);
  const videos = sel.filter((n) => n.data.kind === 'video');

  const minX = Math.min(...sel.map((n) => n.position.x));
  const minY = Math.min(...sel.map((n) => n.position.y));
  const maxX = Math.max(...sel.map((n) => n.position.x + size(n).w));
  const maxY = Math.max(...sel.map((n) => n.position.y + size(n).h));
  const box = {
    left: minX * zoom + tx - PAD,
    top: minY * zoom + ty - PAD,
    width: (maxX - minX) * zoom + PAD * 2,
    height: (maxY - minY) * zoom + PAD * 2,
  };

  // —— 排列 ——
  const arrange = (how: 'grid' | 'row' | 'col') => {
    setMenu(false);
    const pos = new Map<string, { x: number; y: number }>();
    if (how === 'row') {
      let x = minX;
      [...sel].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y).forEach((n) => {
        pos.set(n.id, { x, y: minY });
        x += size(n).w + GAP;
      });
    } else if (how === 'col') {
      let y = minY;
      [...sel].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).forEach((n) => {
        pos.set(n.id, { x: minX, y });
        y += size(n).h + GAP;
      });
    } else {
      // 宫格：按「先上后下、先左后右」的阅读顺序排进 √n 列
      const cols = Math.ceil(Math.sqrt(sel.length));
      const order = [...sel].sort((a, b) => {
        const dy = a.position.y - b.position.y;
        return Math.abs(dy) > 80 ? dy : a.position.x - b.position.x;
      });
      const colW: number[] = [];
      const rowH: number[] = [];
      order.forEach((n, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        colW[c] = Math.max(colW[c] || 0, size(n).w);
        rowH[r] = Math.max(rowH[r] || 0, size(n).h);
      });
      order.forEach((n, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = minX + colW.slice(0, c).reduce((s, w) => s + w + GAP, 0);
        const y = minY + rowH.slice(0, r).reduce((s, h) => s + h + GAP, 0);
        pos.set(n.id, { x, y });
      });
    }
    const wrap = document.querySelector('.canvas-wrap');
    wrap?.classList.add('arranging');
    setTimeout(() => wrap?.classList.remove('arranging'), 380);
    rf.setNodes((ns) => ns.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)));
    onDone();
  };

  // —— 保存到资产 ——
  const saveAssets = async () => {
    type Item = { kind: string; name: string; file?: string; text?: string; projectId?: string };
    const items = sel.flatMap((n): Item[] => {
      const d = n.data;
      const v = activeVersion(d);
      if (d.kind === 'text' || d.kind === 'script') {
        const text = (d.text || v?.text || '').trim();
        return text ? [{ kind: d.kind, name: d.title, text, projectId: project?.id }] : [];
      }
      return v?.file ? [{ kind: d.kind, name: d.title, file: v.file, projectId: project?.id }] : [];
    });
    const empty = sel.length - items.length;
    if (!items.length) return toast('选中的节点都还是空的，没有可保存的内容', 'error');
    setBusy(true);
    try {
      const r = await api.addAssets(items);
      const skip = r.skipped + empty;
      toast(
        r.added.length
          ? `已保存 ${r.added.length} 个到资产库${skip ? `（${skip} 个已存过或是空的，跳过）` : ''}`
          : '这些都已经在资产库里了',
      );
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // —— 创建副本：复制选中的节点、它们之间的连线、以及从外面连进来的线；放在右边 ——
  const duplicate = () => {
    const ids = new Set(sel.map((n) => n.id));
    const map = new Map(sel.map((n) => [n.id, newId()]));
    const dx = maxX - minX + 120;
    const copies: FlowNode[] = sel.map((n) => {
      const data = structuredClone(n.data) as NodeData;
      delete data.run;
      return { id: map.get(n.id)!, type: 'media', position: { x: n.position.x + dx, y: n.position.y }, data, selected: true };
    });
    const newEdges: Edge[] = rf
      .getEdges()
      .filter((e) => ids.has(e.target))
      .map((e) => ({
        id: newId('e_'),
        source: map.get(e.source) || e.source,
        target: map.get(e.target)!,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      }));
    rf.setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...copies]);
    rf.setEdges((es) => [...es, ...newEdges]);
    onDone();
    toast(`已创建 ${copies.length} 个节点的副本`, 'info', { label: '撤销', onClick: undo });
  };

  // —— 拼接成片：新建一个成片节点放在右边，选中的视频按阅读顺序（先上后下、先左后右）连进去 ——
  const makeCut = () => {
    const order = [...videos].sort((a, b) => {
      const dy = a.position.y - b.position.y;
      return Math.abs(dy) > 80 ? dy : a.position.x - b.position.x;
    });
    const id = newId();
    const data = makeNodeData('cut', '成片', [], project?.ratio, { clips: order.map((n) => n.id) });
    const node: FlowNode = { id, type: 'media', position: { x: maxX + 120, y: minY }, data, selected: true };
    rf.setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
    rf.setEdges((es) => [...es, ...order.map((n) => ({ id: newId('e_'), source: n.id, target: id }))]);
    onDone();
    toast(`已把 ${order.length} 段视频连到新的成片节点，在它下方点「拼接」`, 'info', { label: '撤销', onClick: undo });
  };

  // —— 删除 ——
  const remove = async () => {
    const n = sel.length;
    await rf.deleteElements({ nodes: sel.map((x) => ({ id: x.id })) });
    onDone();
    toast(`已删除 ${n} 个节点`, 'info', { label: '撤销', onClick: undo });
  };

  return (
    <>
      {multi && <div className="sel-box" style={box} />}
      {!dragging && (
        <div
          className="sel-bar nodrag nopan"
          style={{ left: Math.min(Math.max(box.left + box.width / 2, 330), window.innerWidth - 330), top: Math.max(box.top - 12, 58) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {multi && (
            <>
              <span className="sel-count">已选 {sel.length} 个</span>
              <span className="sel-sep" />
            </>
          )}
          {multi && gens.length > 0 && (
            <>
              <button onClick={() => submitMany(gens.map((n) => n.id))} title="把选中的节点各生成一次（会先确认数量和预估花费，⌘ + 回车也行）">
                <ArrowUp size={16} /> 全部生成
              </button>
              <span className="sel-sep" />
            </>
          )}
          {videos.length >= 2 && (
            <>
              <button onClick={makeCut} title="新建一个成片节点，把选中的视频按顺序连进去，再一键拼成一个视频">
                <Film size={16} /> 拼接成片
              </button>
              <span className="sel-sep" />
            </>
          )}
          {multi && (
          <div className="sel-menu-wrap">
            <button className={menu ? 'on' : ''} onClick={() => setMenu(!menu)} title="排列方式">
              <LayoutPanelLeft size={16} /> 排列 <ChevronDown size={13} />
            </button>
            {menu && (
              <div className="sel-menu">
                <button onClick={() => arrange('grid')}>
                  <LayoutGrid size={16} /> 宫格排列
                </button>
                <button onClick={() => arrange('row')}>
                  <Columns3 size={16} /> 水平排列
                </button>
                <button onClick={() => arrange('col')}>
                  <Rows3 size={16} /> 垂直排列
                </button>
              </div>
            )}
          </div>
          )}
          {multi && <span className="sel-sep" />}
          <button onClick={saveAssets} disabled={busy} title="存进资产库，所有画布都能用">
            <Archive size={16} /> 保存到资产
          </button>
          <button onClick={duplicate} title="复制一份放在右边（⌘D）">
            <Copy size={16} /> 创建副本
          </button>
          <span className="sel-sep" />
          <button className="danger" onClick={remove} title="删除选中的节点（Delete）">
            <Trash2 size={16} /> 删除
          </button>
        </div>
      )}
    </>
  );
}
