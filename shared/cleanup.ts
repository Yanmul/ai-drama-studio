// 定时清理删掉文件后，把节点里对应的版本一起去掉。后端改磁盘上的画布、前端改正开着的画布，共用这一份逻辑。
import type { NodeData } from './types.js';

/** 去掉文件已被删除的版本；没有变化返回 null */
export function pruneDeletedVersions(data: NodeData, deleted: Set<string>): NodeData | null {
  const versions = data.versions || [];
  const keep = versions.filter((v) => !v.file || !deleted.has(v.file));
  if (keep.length === versions.length) return null;
  const removed = versions.filter((v) => !keep.includes(v));
  // 当前显示的版本还在就继续显示它，被删了就显示剩下的最后一版
  const cur = versions[data.current];
  const current = cur && keep.includes(cur) ? keep.indexOf(cur) : keep.length - 1;
  // 记下这些版本来自哪些任务，免得刷新时又按任务记录把它们补回来
  const removedJobs = [...((data.removedJobs as string[] | undefined) || []), ...removed.map((v) => v.jobId).filter((id): id is string => Boolean(id))];
  return { ...data, versions: keep, current, removedJobs };
}
