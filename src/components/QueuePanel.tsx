// 右侧队列面板：所有生成任务的进度、花费、失败原因
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { CheckCircle2, CircleSlash, Crosshair, DownloadCloud, Loader2, RotateCcw, X, XCircle } from 'lucide-react';
import type { Job } from '../../shared/types';
import { api } from '../api';
import { useApp, useJobs } from '../context';
import { fileKind, fmtTime } from '../lib';
import { fileUrl } from '../api';

const STATUS: Record<Job['status'], { label: string; icon: any; cls: string }> = {
  queued: { label: '排队中', icon: Loader2, cls: 'q' },
  running: { label: '生成中', icon: Loader2, cls: 'r' },
  succeeded: { label: '完成', icon: CheckCircle2, cls: 's' },
  failed: { label: '失败', icon: XCircle, cls: 'f' },
  cancelled: { label: '已取消', icon: CircleSlash, cls: 'c' },
};

export function QueuePanel({ onClose }: { onClose: () => void }) {
  const { episode, toast, setJobs, openEpisode } = useApp();
  const jobs = useJobs();
  const rf = useReactFlow();
  // 筛选：本集 / 全部 / 进行中 / 失败
  const [filter, setFilter] = useState<'ep' | 'all' | 'active' | 'failed'>('ep');
  const [busyId, setBusyId] = useState(''); // 正在提交「重新生成 / 重新查询 / 取消」的任务，防止连点
  const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';
  const shown = jobs.filter((j) =>
    filter === 'ep' ? j.request.episodeId === episode?.id : filter === 'active' ? isActive(j) : filter === 'failed' ? j.status === 'failed' : true,
  );
  const list = shown.slice(0, 200);
  const spent = jobs.filter((j) => j.status === 'succeeded' && j.cost).reduce((s, j) => s + (j.cost || 0), 0);

  const locate = (j: Job) => {
    // 在首页：直接打开那张画布，加载完自动定位
    if (!episode) {
      sessionStorage.setItem('focusNode', `${j.request.episodeId}/${j.request.nodeId}`);
      return void (location.hash = `#/c/${encodeURIComponent(j.request.projectId)}/${encodeURIComponent(j.request.episodeId)}`);
    }
    // 在别的剧集：直接切过去，加载完自动定位
    if (j.request.episodeId !== episode.id) return openEpisode(j.request.episodeId, j.request.nodeId);
    const n = rf.getNode(j.request.nodeId);
    if (!n) return toast('对应的节点已经删掉了');
    rf.setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
    rf.setCenter(n.position.x + 170, n.position.y + 150, { zoom: 0.9, duration: 400 });
  };

  const act = async (j: Job, fn: () => Promise<Job[] | Job>) => {
    if (busyId) return;
    setBusyId(j.id);
    try {
      merge(await fn());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusyId('');
    }
  };

  const merge = (created: Job[] | Job) => {
    const arr = Array.isArray(created) ? created : [created];
    setJobs((prev) => [...arr.filter((c) => !prev.some((p) => p.id === c.id)), ...prev.map((p) => arr.find((c) => c.id === p.id) || p)]);
  };

  return (
    <aside className="queue">
      <div className="q-head">
        <b>队列</b>
        <span className="muted">
          {jobs.filter((j) => j.status === 'running' || j.status === 'queued').length} 个进行中 · 已花 ¥{spent.toFixed(2)}
        </span>
        <span className="spacer" />
        <button className="icon" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="seg q-filter">
        {(
          [
            ['ep', '本集'],
            ['all', '全部'],
            ['active', '进行中'],
            ['failed', '失败'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="q-list">
        {list.length === 0 && <div className="muted pad">{jobs.length ? '这个筛选下没有任务' : '还没有生成任务'}</div>}
        {list.map((j) => {
          const s = STATUS[j.status];
          return (
            <div key={j.id} className={`q-item ${s.cls}`}>
              <div className="q-row">
                <s.icon size={14} className={j.status === 'running' || j.status === 'queued' ? 'spin' : ''} />
                <span className="q-status">{s.label}</span>
                <span className="q-model">{j.modelName}</span>
                <span className="spacer" />
                <span className="muted">{fmtTime(j.createdAt)}</span>
              </div>
              <div className="q-body">
                {/* 成功的任务直接显示结果缩略图 */}
                {j.status === 'succeeded' && j.outputs?.some((o) => o.file) && (
                  <div className="q-thumbs">
                    {j.outputs
                      .filter((o) => o.file)
                      .slice(0, 4)
                      .map((o) =>
                        fileKind(o.file) === 'image' ? (
                          <img key={o.file} src={fileUrl(o.file)} />
                        ) : fileKind(o.file) === 'video' ? (
                          <video key={o.file} src={fileUrl(o.file)} muted preload="metadata" />
                        ) : (
                          <span key={o.file} className="q-audio">♪</span>
                        ),
                      )}
                  </div>
                )}
                <div className="q-prompt" title={j.finalPrompt || j.request.prompt}>
                  {j.request.prompt || j.request.inputTexts[0] || '（没有提示词）'}
                </div>
              </div>
              {j.note && (j.status === 'running' || j.status === 'queued') && <div className="q-note">{j.note}</div>}
              {j.error && <div className="q-err">{j.error}</div>}
              <div className="q-actions">
                {j.cost !== undefined && (
                  <span className="muted">
                    ¥{j.cost.toFixed(2)}
                    {j.costEstimated ? '（估）' : ''}
                  </span>
                )}
                <span className="spacer" />
                <button className="icon" title={j.request.episodeId === episode?.id ? '在画布上找到这个节点' : '切到那一集并找到这个节点'} onClick={() => locate(j)}>
                  <Crosshair size={14} />
                </button>
                {(j.status === 'queued' || j.status === 'running') && (
                  <button className="icon" title="取消" disabled={busyId === j.id} onClick={() => act(j, () => api.cancelJob(j.id))}>
                    <CircleSlash size={14} />
                  </button>
                )}
                {j.status === 'failed' && j.resumable && (
                  <button className="icon" title="重新查询：厂商那边可能已经出了结果，只重新查询 / 下载，不会再扣费" disabled={busyId === j.id} onClick={() => act(j, () => api.resumeJob(j.id))}>
                    <DownloadCloud size={14} />
                  </button>
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && (
                  <button className="icon" title="用同样的设置重新生成" disabled={busyId === j.id} onClick={() => act(j, () => api.retryJob(j.id))}>
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
