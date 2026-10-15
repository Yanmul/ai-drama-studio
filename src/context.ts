import { createContext, useContext, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Character, Episode, Job, ModelInfo, NodeKind, Project, Version } from '../shared/types';

export interface AppCtx {
  project?: Project;
  episode?: Episode;
  models: ModelInfo[];
  characters: Character[];
  setJobs: Dispatch<SetStateAction<Job[]>>;
  toast: (msg: string, kind?: 'info' | 'error', action?: { label: string; onClick: () => void }) => void;
  refreshModels: () => void;
  refreshCharacters: () => void;
  openCharacters: () => void;
  openModels: () => void;
  /** 最近一次定时清理删掉的文件；画布据此去掉对应版本 */
  cleanup?: { deleted: string[]; at: number };
  /** 生成 / 上传的文件保留几天（自动清理），节点上提示「几天后清理」用 */
  keepDays?: number;
  /** 切到另一集，可以顺便定位到某个节点 */
  openEpisode: (episodeId: string, focusNodeId?: string) => void;
  /** 打开「从生成历史选择」，选中后回调 */
  pickFromHistory: (cb: (file: string, kind: 'image' | 'video' | 'audio', createdAt?: string) => void) => void;
}

export const AppContext = createContext<AppCtx>(null as any);
export const useApp = () => useContext(AppContext);

/** 当前项目的全部任务。单独一个 context：任务一有进度就变，放在 AppContext 里会让所有节点跟着重画 */
export const JobsContext = createContext<Job[]>([]);
export const useJobs = () => useContext(JobsContext);

export interface CanvasCtx {
  /** 在画布上加一个节点；connectTo 给了就顺手连一条线（新节点 → connectTo） */
  addNode: (
    kind: NodeKind,
    pos: { x: number; y: number },
    opts?: { title?: string; version?: Omit<Version, 'id' | 'createdAt'> & { createdAt?: string }; characterId?: string; text?: string; connectTo?: string; connectFrom?: string },
  ) => string;
  /** 上传文件，变成一个新节点 */
  uploadAsNode: (file: File, pos: { x: number; y: number }, connectTo?: string) => Promise<void>;
  /** skipBusyCheck：已确认过「这个节点已有任务在跑」时不再问 */
  /** 返回是否真的提交了 */
  submit: (nodeId: string, opts?: { skipBusyCheck?: boolean; quiet?: boolean }) => Promise<boolean | void>;
  /** 一次生成多个节点（会先确认数量和预估花费） */
  submitMany: (nodeIds: string[]) => Promise<void>;
  /** 把屏幕坐标换成画布坐标 */
  toFlow: (p: { x: number; y: number }) => { x: number; y: number };
  openAddMenu: (screen: { x: number; y: number }, opts?: { connectFrom?: string; connectTo?: string }) => void;
  expandScript: (nodeId: string) => void;
}

export const CanvasContext = createContext<CanvasCtx>(null as any);
export const useCanvas = () => useContext(CanvasContext);

// —— 任务按节点分组的小仓库 ——
// 每来一个任务进度事件，只让对应的那个节点重新渲染（之前是整张画布所有节点都重画一遍）。
const EMPTY: Job[] = [];
const jobKey = (episodeId: string | undefined, nodeId: string) => `${episodeId}/${nodeId}`;

class JobStore {
  private byNode = new Map<string, Job[]>();
  private listeners = new Set<() => void>();
  set(jobs: Job[]) {
    const next = new Map<string, Job[]>();
    for (const j of jobs) {
      const k = jobKey(j.request.episodeId, j.request.nodeId);
      const arr = next.get(k);
      if (arr) arr.push(j);
      else next.set(k, [j]);
    }
    // 内容没变的节点沿用原来的数组，订阅它的节点就不会重画
    for (const [k, arr] of next) {
      const old = this.byNode.get(k);
      if (old && old.length === arr.length && old.every((j, i) => j === arr[i])) next.set(k, old);
    }
    this.byNode = next;
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get(episodeId: string | undefined, nodeId: string) {
    return this.byNode.get(jobKey(episodeId, nodeId)) || EMPTY;
  }
}

export const jobStore = new JobStore();

/** 某个节点的所有任务（只在这个节点的任务变化时触发重渲染） */
export function useNodeJobs(episodeId: string | undefined, nodeId: string): Job[] {
  return useSyncExternalStore(jobStore.subscribe, () => jobStore.get(episodeId, nodeId));
}
