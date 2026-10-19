// 画布上的节点：文本 / 图片 / 视频 / 音频 / 脚本 共用一个组件（参考 LibTV 的样子）。
// 选中节点时，下方弹出生成面板（GeneratePanel）。
import { Handle, NodeToolbar, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, Maximize, Pause, Volume2, VolumeX, ChevronLeft, ChevronRight, Download, FileText, Image as ImageIcon, Loader2, Maximize2, Music, Play, ScrollText, Star, Upload, UserRound, Wand2, X, Film } from 'lucide-react';
import type { NodeData, Version } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp, useCanvas, useNodeJobs } from '../context';
import { KIND_LABEL, SETTING_WORD, fileKind, newId, settingImages, settingKind, shownVersion } from '../lib';
import { GeneratePanel } from '../components/GeneratePanel';
import { CutPanel } from '../components/CutPanel';
import { Lightbox } from '../components/Lightbox';
import { Popover } from '../components/Popover';
import { confirmDialog } from '../components/Dialog';

const ICON = {
  text: FileText,
  image: ImageIcon,
  video: Play,
  audio: Music,
  script: ScrollText,
  cut: Film,
};

/** 00:03.048 */
function fmtStamp(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 在浏览器里截一帧：把视频画面画到画布上，导出 PNG（原始分辨率） */
function drawFrame(v: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('截图失败'))), 'image/png'));
}

/** 另开一个看不见的播放器，跳到指定时间再截（不打扰正在看的视频） */
function grabAt(src: string, at: 'first' | 'last'): Promise<{ blob: Blob; t: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = src;
    v.onerror = () => reject(new Error('视频读不出来'));
    v.onloadedmetadata = () => {
      // 尾帧：跳到结尾前一点点；正好跳到结尾，有的视频会是黑屏
      v.currentTime = at === 'first' ? 0 : Math.max(0, v.duration - 0.04);
    };
    v.onseeked = () => drawFrame(v).then((blob) => resolve({ blob, t: v.currentTime }), reject);
  });
}

function MediaNodeImpl({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const { updateNodeData, getNode, getNodes } = useReactFlow();
  const { project, episode, toast, keepDays, characters } = useApp();
  const setting = data.characterId ? characters.find((c) => c.id === data.characterId) : undefined;
  const { expandScript, addNode } = useCanvas();
  const [editingTitle, setEditingTitle] = useState(false);
  const [dims, setDims] = useState('');
  const [verPop, setVerPop] = useState(false);
  const [zoom, setZoom] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frameMenu, setFrameMenu] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  useEffect(() => {
    if (!frameMenu) return;
    // 捕获阶段：点在画布上（React Flow 会拦住事件往外传）也能关；点截帧按钮 / 菜单本身不关
    const close = (e: MouseEvent) => {
      if ((e.target as Element).closest?.('.frame-tool')) return;
      setFrameMenu(false);
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [frameMenu]);
  const Icon = ICON[data.kind];
  const v = shownVersion(data);

  const nodeJobs = useNodeJobs(episode?.id, id);
  const active = nodeJobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const lastFailed = useMemo(() => {
    const latest = [...nodeJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest || latest.status !== 'failed' || data.dismissedError === latest.id) return undefined;
    return latest;
  }, [nodeJobs, data.dismissedError]);

  const setVersion = (i: number) => {
    if (i === data.current) return; // 点的就是当前这版：什么都不改（不然会把手改的正文换回原文）
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

  /** 截帧 → 右边新建一个图片节点，并连上线 */
  const capture = async (at: 'current' | 'first' | 'last') => {
    setFrameMenu(false);
    const vid = videoRef.current;
    if (!project || !v?.file || !vid) return;
    setGrabbing(true);
    try {
      let file: string | undefined;
      let t = at === 'first' ? 0 : at === 'last' ? vid.duration : vid.currentTime;
      // 首帧 / 尾帧先让后端用 ffmpeg 截（最准）；当前帧直接截看到的画面
      // （浏览器读不了这个视频的编码时，当前帧也交给 ffmpeg）
      const browserOk = vid.readyState >= 2 && vid.videoWidth > 0;
      if (at !== 'current' || !browserOk) {
        try {
          file = (await api.frame(project.id, v.file, at === 'current' ? vid.currentTime || 0 : at)).file;
        } catch {}
      }
      if (!file && !browserOk && at === 'current') throw new Error('浏览器读不了这个视频，电脑上也没有 ffmpeg，截不了当前帧');
      if (!file) {
        let blob: Blob;
        if (at === 'current') blob = await drawFrame(vid);
        else ({ blob, t } = await grabAt(fileUrl(v.file), at));
        const up = await api.upload(project.id, new File([blob], `frame-${Date.now()}.png`, { type: 'image/png' }));
        file = up.file;
      }
      // 放在视频右边；那里已经有节点（比如之前截的）就往下排
      const me = getNode(id);
      const pos = me ? { x: me.position.x + (me.measured?.width ?? 340) + 90, y: me.position.y } : { x: 0, y: 0 };
      const others = getNodes().filter((n) => n.id !== id);
      const H = (me?.measured?.height ?? 260) + 40;
      for (let i = 0; i < 50; i++) {
        const hit = others.some(
          (n) =>
            Math.abs(n.position.x - pos.x) < (n.measured?.width ?? 340) &&
            n.position.y < pos.y + H - 40 &&
            n.position.y + (n.measured?.height ?? 260) > pos.y,
        );
        if (!hit) break;
        pos.y += H;
      }
      const label = at === 'first' ? '首帧' : at === 'last' ? '尾帧' : '截图';
      addNode('image', pos, { title: Number.isFinite(t) ? `${label} ${fmtStamp(t)}` : label, version: { kind: 'image', file, label }, connectFrom: id });
      toast(`已截取${label === '截图' ? '当前帧' : label}`);
    } catch (e: any) {
      toast(e.message || '截图失败', 'error');
    } finally {
      setGrabbing(false);
    }
  };

  // 成片节点也显示视频结果（能预览、下载、定稿），但不能上传替换、没有生成面板
  const isMedia = data.kind === 'image' || data.kind === 'video' || data.kind === 'audio' || data.kind === 'cut';
  const starred = v && data.starred === v.id;
  // 当前看的不是定稿版：下游其实用的是定稿那一版，要标出来
  const starIdx = data.starred ? data.versions.findIndex((x) => x.id === data.starred) : -1;
  const downstreamOther = starIdx >= 0 && starIdx !== data.current;
  const fileName = (i: number) => {
    const f = data.versions[i]?.file || '';
    return `${(data.title || KIND_LABEL[data.kind]).replace(/[\\/:*?"<>|]/g, '_')}-v${i + 1}${f.match(/\.[^./]+$/)?.[0] || ''}`;
  };
  // 自动清理：没定稿的生成 / 上传文件几天后会被删（角色图、资产库里的不会）
  const cleanupLeft = (() => {
    // 设定库里的图不会被清理
    const inSettings = setting && settingImages(setting).some((img) => img.file === v?.file);
    if (!keepDays || !v?.file || starred || !v.file.startsWith('projects/') || inSettings) return undefined;
    const age = (Date.now() - Date.parse(v.createdAt)) / 86_400_000;
    return Number.isFinite(age) ? Math.max(0, keepDays - age) : undefined;
  })();

  // 从节点里去掉一个版本（文件留着，生成历史里还能找到）
  const removeVersion = async (i: number) => {
    const ver = data.versions[i];
    if (!ver) return;
    const ok = await confirmDialog({
      title: `从节点里去掉 v${i + 1}？`,
      message: ver.id === data.starred ? '这是定稿版，去掉后这个节点就没有定稿了。\n文件不会删除，生成历史里还能找回。' : '文件不会删除，生成历史里还能找回。',
      okText: '去掉',
      danger: true,
    });
    if (!ok) return;
    // 确认框开着的时候可能来了新结果：按版本 id 在最新数据上删
    const d = (getNode(id)?.data as NodeData | undefined) || data;
    const at = d.versions.findIndex((x) => x.id === ver.id);
    if (at < 0) return;
    const versions = d.versions.filter((_, j) => j !== at);
    const shown = d.versions[d.current];
    const removingShown = !shown || shown.id === ver.id;
    const current = removingShown ? Math.min(at, versions.length - 1) : versions.indexOf(shown);
    updateNodeData(id, {
      versions,
      current,
      starred: d.starred === ver.id ? undefined : d.starred,
      removedJobs: ver.jobId ? [...((d.removedJobs as string[] | undefined) || []), ver.jobId] : d.removedJobs,
      // 只有去掉的正好是正在显示的那版，正文才换成新的当前版（不然会冲掉手改的正文）
      ...(removingShown && (d.kind === 'text' || d.kind === 'script') && versions[current]?.text !== undefined ? { text: versions[current].text } : {}),
    });
  };
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
          <span className="badge" title="设定库里的图：连到哪里，就把它的描述带到哪里">
            <UserRound size={11} /> {SETTING_WORD[settingKind(setting)]}
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
              <img
                src={fileUrl(v.file)}
                draggable={false}
                title="双击放大"
                onDoubleClick={() => setZoom(true)}
                onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
              />
            )}
            {fileKind(v.file) === 'video' && (
              <HoverVideo
                videoRef={videoRef}
                src={fileUrl(v.file)}
                onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight} · ${Math.round(e.currentTarget.duration)}s`)}
              />
            )}
            {fileKind(v.file) === 'video' && (
              <div className={`frame-tool nodrag ${frameMenu || grabbing ? 'open' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
                <button className="frame-btn" title="截帧：当前帧 / 首帧 / 尾帧，截出来的图会放在右边并连好线" disabled={grabbing} onClick={() => setFrameMenu(!frameMenu)}>
                  {grabbing ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
                </button>
                {frameMenu && (
                  <div className="frame-menu">
                    <button onClick={() => capture('current')}>截取当前帧</button>
                    <button onClick={() => capture('first')}>截取首帧</button>
                    <button onClick={() => capture('last')}>截取尾帧</button>
                  </div>
                )}
              </div>
            )}
            {fileKind(v.file) === 'audio' && <audio className="nodrag" src={fileUrl(v.file)} controls />}
          </div>
        )}

        {isMedia && !v?.file && (
          <div
            className={`placeholder ${portrait && data.kind !== 'audio' ? 'portrait' : ''} ${data.kind === 'audio' ? 'short' : ''}`}
            onDoubleClick={() => data.kind !== 'cut' && fileInput.current?.click()}
          >
            <Icon size={34} strokeWidth={1.4} />
            <div className="ph-tip">{data.kind === 'cut' ? '把视频节点连进来，在下方点「拼接」' : '在下方描述后生成，或双击上传'}</div>
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
              <span className="chip-wrap">
                <button className="ver" onClick={() => setVerPop(!verPop)} title="看全部版本：点一下切换，悬停可以去掉不要的">
                  {data.current + 1} / {data.versions.length}
                  {v?.label ? ` · ${v.label}` : ''}
                </button>
                <Popover open={verPop} onClose={() => setVerPop(false)} placement="top" className="ver-pop">
                  {data.versions.map((x, i) => (
                    <div key={x.id} className={`ver-item ${i === data.current ? 'on' : ''}`} onClick={() => (setVersion(i), setVerPop(false))} title={`v${i + 1}${x.label ? ' · ' + x.label : ''}`}>
                      {fileKind(x.file) === 'image' && <img src={fileUrl(x.file)} />}
                      {fileKind(x.file) === 'video' && <video src={fileUrl(x.file)} muted preload="metadata" />}
                      {fileKind(x.file) === 'audio' && <span className="ver-txt">♪</span>}
                      {!x.file && <span className="ver-txt">{(x.text || '').slice(0, 14) || '文字'}</span>}
                      <span className="ver-no">v{i + 1}</span>
                      {data.starred === x.id && <Star size={11} fill="currentColor" className="ver-star" />}
                      <button className="ver-del" title="从节点里去掉这一版" onClick={(e) => (e.stopPropagation(), setVerPop(false), removeVersion(i))}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </Popover>
              </span>
              <button className="icon" disabled={data.current >= data.versions.length - 1} onClick={() => setVersion(data.current + 1)}>
                <ChevronRight size={14} />
              </button>
              {downstreamOther && (
                <button className="down-badge" onClick={() => setVersion(starIdx)} title="下游节点用的是定稿那一版，不是你现在看的这版；点一下切过去">
                  下游用 v{starIdx + 1} <Star size={10} fill="currentColor" />
                </button>
              )}
              {cleanupLeft !== undefined && (
                <span className={`cleanup-left ${cleanupLeft <= 1 ? 'soon' : ''}`} title={`没定稿的版本 ${keepDays} 天后会被自动清理；满意的点 ⭐ 定稿，或下载 / 存进资产库`}>
                  {cleanupLeft < 1 ? '今天清理' : `${Math.ceil(cleanupLeft)}天后清理`}
                </span>
              )}
              <span className="spacer" />
              {isMedia && v?.file && (
                <button className="icon" title="放大查看（← → 切换版本）" onClick={() => setZoom(true)}>
                  <Maximize2 size={13} />
                </button>
              )}
              {isMedia && v?.file && (
                // 下载当前显示的这一版，文件名：节点标题-v版本号.扩展名
                <a className="icon" title="下载这一版" href={fileUrl(v.file)} download={fileName(data.current)}>
                  <Download size={13} />
                </a>
              )}
              {isMedia && data.kind !== 'cut' && (
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

      {zoom && (
        <Lightbox
          title={data.title}
          versions={data.versions}
          index={data.current}
          starred={data.starred}
          onIndex={setVersion}
          onStar={(vid) => updateNodeData(id, { starred: vid })}
          onClose={() => setZoom(false)}
          downloadName={fileName}
        />
      )}

      {data.kind !== 'script' && (
        <NodeToolbar position={Position.Bottom} offset={16} className="panel-toolbar">
          {data.kind === 'cut' ? <CutPanel nodeId={id} data={data} /> : <GeneratePanel nodeId={id} data={data} />}
        </NodeToolbar>
      )}
    </div>
  );
}

export const MediaNode = memo(MediaNodeImpl);

function fmtClock(t: number) {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t - m * 60)).padStart(2, '0')}`;
}

/**
 * 视频：鼠标移上去就静音预览，移开就暂停。
 * 画面本身可以拖动节点（点一下不移动 = 播放 / 暂停）；底下自己做的控制条才是「点了不拖」的区域。
 * 预览时开了声音或者自己点了播放 / 暂停，就算「正式在看」，移开鼠标不再自动暂停。
 */
function HoverVideo({
  src,
  onLoadedMetadata,
  videoRef,
}: {
  src: string;
  onLoadedMetadata: React.ReactEventHandler<HTMLVideoElement>;
  /** 截帧要读当前播放到哪：把内部的 video 元素交给外面 */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const previewing = useRef(false);
  const [preview, setPreviewState] = useState(false); // 给按钮图标用：预览中显示「播放」
  const setPreview = (v: boolean) => {
    previewing.current = v;
    setPreviewState(v);
  };
  const starting = useRef(false); // 我们自己调 play() 引起的 play 事件，不算用户操作
  const down = useRef<{ x: number; y: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);

  // 悬停预览才循环；自己点了播放 / 开了声音 / 拖了进度 = 正式在看，只播一遍，播完停住
  const watch = () => {
    setPreview(false);
    if (ref.current) ref.current.loop = false;
  };

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (previewing.current) {
      // 预览中点「播放」= 从头正式看一遍
      watch();
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    watch();
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  return (
    <div
      className={`hv ${playing ? 'playing' : ''}`}
      onMouseEnter={() => {
        const el = ref.current;
        if (!el || !el.paused) return;
        el.muted = true;
        setMuted(true);
        el.loop = true;
        setPreview(true);
        starting.current = true;
        el.play()
          .catch(() => setPreview(false))
          .finally(() => (starting.current = false));
      }}
      onMouseLeave={() => {
        const el = ref.current;
        if (el && previewing.current) el.pause();
        setPreview(false);
      }}
    >
      <video
        ref={(el) => {
          ref.current = el;
          if (videoRef) videoRef.current = el;
        }}
        src={src}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration);
          onLoadedMetadata(e);
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        // 在画面上按下去又松开、几乎没移动 = 点击：播放 / 暂停；移动了就是在拖节点
        onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          if (d && Math.abs(e.clientX - d.x) < 4 && Math.abs(e.clientY - d.y) < 4) {
            const el = ref.current;
            if (!el) return;
            if (previewing.current) {
              // 正在静音预览：点一下 = 开声音好好看（只播这一遍）
              watch();
              el.muted = false;
              setMuted(false);
            } else {
              watch();
              if (el.paused) el.play().catch(() => {});
              else el.pause();
            }
          }
        }}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          if (!e.currentTarget.muted) watch();
        }}
        onPlay={() => {
          setPlaying(true);
          if (!starting.current) watch();
        }}
        onPause={() => {
          setPlaying(false);
          setPreview(false);
        }}
      />
      <div className="hv-bar nodrag nopan" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="hv-btn" onClick={toggle} title={playing && !preview ? '暂停' : '播放（只播一遍）'}>
          {playing && !preview ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
        <span className="hv-time">{fmtClock(t)}</span>
        <input
          className="hv-seek"
          type="range"
          min={0}
          max={dur || 0}
          step={0.01}
          value={t}
          style={{ ['--p' as any]: dur ? `${(t / dur) * 100}%` : '0%' }}
          onChange={(e) => {
            const el = ref.current;
            if (!el) return;
            watch();
            el.currentTime = Number(e.target.value);
            setT(el.currentTime);
          }}
        />
        <span className="hv-time">{fmtClock(dur)}</span>
        <button
          className="hv-btn"
          title={muted ? '打开声音' : '静音'}
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            el.muted = !el.muted;
          }}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <button className="hv-btn" title="全屏" onClick={() => ref.current?.requestFullscreen?.()}>
          <Maximize size={13} />
        </button>
      </div>
    </div>
  );
}
