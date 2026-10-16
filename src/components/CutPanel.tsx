// 成片节点下方的面板：连进来的视频按顺序列出来，可以调顺序、勾掉不用的，点「拼接」拼成一个 mp4。
// 每段用定稿（⭐）版，没定稿用当前显示的那一版。
import { useNodeConnections, useNodesData, useReactFlow, type Node } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Film, Loader2, Scissors, Star } from 'lucide-react';
import type { NodeData, Version } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp } from '../context';
import { activeVersion, fileKind, newId } from '../lib';

const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${s.toFixed(1)}秒`);

export function CutPanel({ nodeId, data }: { nodeId: string; data: NodeData }) {
  const { project, episode, toast } = useApp();
  const { updateNodeData, getNode } = useReactFlow();
  const conns = useNodeConnections({ id: nodeId, handleType: 'target' });
  const srcIds = useMemo(() => conns.map((c) => c.source), [conns]);
  const srcNodes = useNodesData<Node<NodeData>>(srcIds);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  // 顺序：保存过的顺序在前；新连进来的按画布位置排（从上到下，同一行从左到右）
  const saved = ((data.clips as string[] | undefined) || []).filter((id) => srcIds.includes(id));
  const extra = srcIds
    .filter((id) => !saved.includes(id))
    .sort((a, b) => {
      const pa = getNode(a)?.position || { x: 0, y: 0 };
      const pb = getNode(b)?.position || { x: 0, y: 0 };
      return Math.abs(pa.y - pb.y) > 80 ? pa.y - pb.y : pa.x - pb.x;
    });
  const ids = [...saved, ...extra];
  const skip = new Set((data.skip as string[] | undefined) || []);
  const items = ids.map((id) => {
    const d = srcNodes.find((n) => n.id === id)?.data;
    const v = d && activeVersion(d);
    const file = v?.file && fileKind(v.file) === 'video' ? v.file : undefined;
    return { id, title: d?.title || '（节点已删除）', file, starred: Boolean(d?.starred && d.starred === v?.id), on: !skip.has(id) };
  });
  const use = items.filter((x) => x.on && x.file);
  const total = use.reduce((s, x) => s + (durations[x.file!] || 0), 0);

  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    updateNodeData(nodeId, { clips: next });
  };
  const toggle = (id: string) => {
    const s = new Set(skip);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    updateNodeData(nodeId, { skip: [...s], clips: ids });
  };

  const go = async () => {
    if (!project || !episode || busy) return;
    if (!use.length) return toast('还没有可以拼的视频：连进来的视频节点要先生成出视频', 'error');
    setBusy(true);
    try {
      const r = await api.stitch(project.id, episode.id, nodeId, use.map((x) => x.file!));
      // 用最新的节点数据加版本（拼接要一会儿，这期间节点可能变过）
      const d = (getNode(nodeId)?.data as NodeData | undefined) || data;
      const ver: Version = { id: newId('v_'), kind: 'video', file: r.file, createdAt: new Date().toISOString(), label: `成片 · ${use.length} 段` };
      updateNodeData(nodeId, { versions: [...d.versions, ver], current: d.versions.length, clips: ids });
      toast(`拼好了：${use.length} 段，${fmtSec(r.duration)}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gen-panel cut-panel nodrag nowheel nopan" onKeyDown={(e) => e.stopPropagation()}>
      <div className="cut-head">
        <Film size={15} /> 成片
        <span className="muted">
          {use.length} 段{total > 0 ? ` · 约 ${fmtSec(total)}` : ''}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="cut-empty">
          把视频节点连到这个成片节点（从视频右边的圆点拖线过来）；
          <br />
          或者在画布上框选几个视频节点，点上方的「拼接成片」。
        </div>
      ) : (
        <div className="cut-list">
          {items.map((x, i) => (
            <div key={x.id} className={`cut-item ${x.on && x.file ? '' : 'off'}`}>
              <input type="checkbox" checked={x.on} title={x.on ? '勾掉：这次先不拼这一段' : '拼进去'} onChange={() => toggle(x.id)} />
              <span className="cut-no">{i + 1}</span>
              {x.file ? (
                <video
                  src={fileUrl(x.file)}
                  muted
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const sec = e.currentTarget.duration;
                    if (Number.isFinite(sec)) setDurations((m) => ({ ...m, [x.file!]: sec }));
                  }}
                />
              ) : (
                <span className="cut-thumb-empty">
                  <Film size={14} />
                </span>
              )}
              <span className="cut-title" title={x.title}>
                {x.title}
              </span>
              <span className="cut-meta">
                {!x.file ? (
                  <span className="cut-warn">还没有视频</span>
                ) : (
                  <>
                    {x.starred ? (
                      <span className="cut-star" title="用的是定稿版">
                        <Star size={11} fill="currentColor" /> 定稿
                      </span>
                    ) : (
                      <span title="没定稿：用的是当前显示的那一版">当前版</span>
                    )}
                    {durations[x.file] ? ` · ${fmtSec(durations[x.file])}` : ''}
                  </>
                )}
              </span>
              <span className="cut-move">
                <button className="icon" title="往前挪" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button className="icon" title="往后挪" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="bar">
        <span className="muted cut-tip">每段用定稿版（没定稿用当前版）；尺寸统一成第一段的，比例不同加黑边；用本机 ffmpeg，不花钱</span>
        <span className="spacer" />
        <button className="primary cut-go" onClick={go} disabled={busy || !use.length}>
          {busy ? <Loader2 size={15} className="spin" /> : <Scissors size={15} />} {busy ? '拼接中…' : '拼接'}
        </button>
      </div>
    </div>
  );
}
