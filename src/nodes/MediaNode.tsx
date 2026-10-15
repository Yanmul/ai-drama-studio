// 画布上的节点：文本 / 图片 / 视频 / 音频 / 脚本 共用一个组件（参考 LibTV 的样子）。
// 选中节点时，下方弹出生成面板（GeneratePanel）。
import { Handle, NodeToolbar, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { memo, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Loader2, Music, Play, ScrollText, Star, Upload, UserRound, Wand2 } from 'lucide-react';
import type { NodeData, Version } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp, useCanvas } from '../context';
import { KIND_LABEL, fileKind, newId, shownVersion } from '../lib';
import { GeneratePanel } from '../components/GeneratePanel';

const ICON = {
  text: FileText,
  image: ImageIcon,
  video: Play,
  audio: Music,
  script: ScrollText,
};

function MediaNodeImpl({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const { updateNodeData } = useReactFlow();
  const { project, episode, jobs, toast } = useApp();
  const { expandScript } = useCanvas();
  const [editingTitle, setEditingTitle] = useState(false);
  const [dims, setDims] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const Icon = ICON[data.kind];
  const v = shownVersion(data);

  const nodeJobs = useMemo(
    () => jobs.filter((j) => j.request.nodeId === id && j.request.episodeId === episode?.id),
    [jobs, id, episode?.id],
  );
  const active = nodeJobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const lastFailed = useMemo(() => {
    const latest = [...nodeJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest || latest.status !== 'failed' || data.dismissedError === latest.id) return undefined;
    return latest;
  }, [nodeJobs, data.dismissedError]);

  const setVersion = (i: number) => {
    const ver = data.versions[i];
    updateNodeData(id, { current: i, ...(ver?.text !== undefined && (data.kind === 'text' || data.kind === 'script') ? { text: ver.text } : {}) });
  };

  const uploadInto = async (f: File) => {
    if (!project) return;
    try {
      const up = await api.upload(project.id, f);
      if (up.kind !== data.kind) {
        toast(`这是${KIND_LABEL[data.kind]}节点，请上传${KIND_LABEL[data.kind]}文件`, 'error');
        return;
      }
      const ver: Version = { id: newId('v_'), kind: up.kind, file: up.file, createdAt: new Date().toISOString(), label: '上传' };
      updateNodeData(id, { versions: [...data.versions, ver], current: data.versions.length });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const isMedia = data.kind === 'image' || data.kind === 'video' || data.kind === 'audio';
  const starred = v && data.starred === v.id;
  const portrait = project?.ratio === '9:16' || project?.ratio === '3:4';

  return (
    <div className={`node node-${data.kind} ${selected ? 'selected' : ''} ${active.length ? 'busy' : ''}`}>
      <div className="node-head">
        <Icon size={13} />
        {editingTitle ? (
          <input
            className="title-input nodrag"
            autoFocus
            defaultValue={data.title}
            onBlur={(e) => {
              updateNodeData(id, { title: e.target.value || data.title });
              setEditingTitle(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="title" onDoubleClick={() => setEditingTitle(true)} title="双击改名">
            {data.title}
          </span>
        )}
        {data.characterId && (
          <span className="badge" title="角色定妆图：连到哪里，就把角色外形描述带到哪里">
            <UserRound size={11} /> 角色
          </span>
        )}
        <span className="spacer" />
        {dims && <span className="dims">{dims}</span>}
      </div>

      <div className="node-body">
        <Handle type="target" position={Position.Left} id="in" className="handle" />
        <Handle type="source" position={Position.Right} id="out" className="handle" />

        {(data.kind === 'text' || data.kind === 'script') && (
          <textarea
            className="node-text nodrag nowheel"
            value={data.text || ''}
            placeholder={data.kind === 'script' ? '粘贴一集剧本或分镜，镜头之间空一行' : '写提示词、台词，或连到图片 / 视频节点当提示词'}
            onChange={(e) => updateNodeData(id, { text: e.target.value })}
          />
        )}

        {isMedia && v?.file && (
          <div className="media">
            {fileKind(v.file) === 'image' && (
              <img src={fileUrl(v.file)} draggable={false} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
            )}
            {fileKind(v.file) === 'video' && (
              <HoverVideo
                src={fileUrl(v.file)}
                onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight} · ${Math.round(e.currentTarget.duration)}s`)}
              />
            )}
            {fileKind(v.file) === 'audio' && <audio className="nodrag" src={fileUrl(v.file)} controls />}
          </div>
        )}

        {isMedia && !v?.file && (
          <div
            className={`placeholder ${portrait && data.kind !== 'audio' ? 'portrait' : ''} ${data.kind === 'audio' ? 'short' : ''}`}
            onDoubleClick={() => fileInput.current?.click()}
          >
            <Icon size={34} strokeWidth={1.4} />
            <div className="ph-tip">在下方描述后生成，或双击上传</div>
          </div>
        )}

        {active.length > 0 && (
          <div className="busy-mask">
            <Loader2 size={18} className="spin" />
            <span>
              {active.some((j) => j.status === 'running') ? '生成中' : '排队中'}
              {active.length > 1 ? ` · ${active.length} 个` : ''}
            </span>
            <span className="busy-note">{active.find((j) => j.note)?.note}</span>
          </div>
        )}

        {lastFailed && !active.length && (
          <div className="fail-bar nodrag" title={lastFailed.error}>
            <AlertTriangle size={13} />
            <span className="fail-text">{lastFailed.error}</span>
            <button onClick={() => updateNodeData(id, { dismissedError: lastFailed.id })}>知道了</button>
          </div>
        )}
      </div>

      {(data.versions.length > 0 || data.kind === 'script') && (
        <div className="node-foot nodrag">
          {data.kind === 'script' ? (
            <button className="ghost" onClick={() => expandScript(id)}>
              <Wand2 size={13} /> 展开成镜头
            </button>
          ) : (
            <>
              <button className="icon" disabled={data.current <= 0} onClick={() => setVersion(data.current - 1)}>
                <ChevronLeft size={14} />
              </button>
              <span className="ver">
                {data.current + 1} / {data.versions.length}
                {v?.label ? ` · ${v.label}` : ''}
              </span>
              <button className="icon" disabled={data.current >= data.versions.length - 1} onClick={() => setVersion(data.current + 1)}>
                <ChevronRight size={14} />
              </button>
              <span className="spacer" />
              {isMedia && (
                <button className="icon" title="上传替换（新增一个版本）" onClick={() => fileInput.current?.click()}>
                  <Upload size={13} />
                </button>
              )}
              <button
                className={`icon ${starred ? 'starred' : ''}`}
                title={starred ? '已定稿：下游节点用这一版' : '设为定稿：下游节点用这一版'}
                onClick={() => v && updateNodeData(id, { starred: starred ? undefined : v.id })}
              >
                <Star size={13} fill={starred ? 'currentColor' : 'none'} />
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        hidden
        accept={data.kind === 'video' ? 'video/*' : data.kind === 'audio' ? 'audio/*' : 'image/*'}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadInto(f);
          e.target.value = '';
        }}
      />

      {data.kind !== 'script' && (
        <NodeToolbar position={Position.Bottom} offset={16} className="panel-toolbar">
          <GeneratePanel nodeId={id} data={data} />
        </NodeToolbar>
      )}
    </div>
  );
}

export const MediaNode = memo(MediaNodeImpl);

/**
 * 视频：鼠标移上去就静音预览，移开就暂停；点三角照常播放。
 * 预览时点了小喇叭（开声音）或者自己点了播放 / 暂停，就算「正式在看」，移开鼠标不再自动暂停。
 */
function HoverVideo({ src, onLoadedMetadata }: { src: string; onLoadedMetadata: React.ReactEventHandler<HTMLVideoElement> }) {
  const ref = useRef<HTMLVideoElement>(null);
  const previewing = useRef(false);
  const starting = useRef(false); // 我们自己调 play() 引起的 play 事件，不算用户操作
  return (
    <video
      ref={ref}
      className="nodrag"
      src={src}
      controls
      loop
      playsInline
      preload="metadata"
      onLoadedMetadata={onLoadedMetadata}
      onMouseEnter={() => {
        const el = ref.current;
        if (!el || !el.paused) return;
        el.muted = true;
        previewing.current = true;
        starting.current = true;
        el.play()
          .catch(() => (previewing.current = false))
          .finally(() => (starting.current = false));
      }}
      onMouseLeave={() => {
        const el = ref.current;
        if (el && previewing.current) el.pause();
        previewing.current = false;
      }}
      onVolumeChange={(e) => {
        if (!e.currentTarget.muted) previewing.current = false;
      }}
      onPlay={() => {
        if (!starting.current) previewing.current = false;
      }}
      onPause={() => {
        previewing.current = false;
      }}
    />
  );
}
