import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { Character, Episode, Job, ModelInfo, NodeKind, Project, Version } from '../shared/types';

export interface AppCtx {
  project?: Project;
  episode?: Episode;
  models: ModelInfo[];
  characters: Character[];
  jobs: Job[];
  setJobs: Dispatch<SetStateAction<Job[]>>;
  toast: (msg: string, kind?: 'info' | 'error', action?: { label: string; onClick: () => void }) => void;
  refreshModels: () => void;
  refreshCharacters: () => void;
  openCharacters: () => void;
  openModels: () => void;
  /** 最近一次定时清理删掉的文件；画布据此去掉对应版本 */
  cleanup?: { deleted: string[]; at: number };
  /** 打开「从生成历史选择」，选中后回调 */
  pickFromHistory: (cb: (file: string, kind: 'image' | 'video' | 'audio') => void) => void;
}

export const AppContext = createContext<AppCtx>(null as any);
export const useApp = () => useContext(AppContext);

export interface CanvasCtx {
  /** 在画布上加一个节点；connectTo 给了就顺手连一条线（新节点 → connectTo） */
  addNode: (
    kind: NodeKind,
    pos: { x: number; y: number },
    opts?: { title?: string; version?: Omit<Version, 'id' | 'createdAt'>; characterId?: string; text?: string; connectTo?: string; connectFrom?: string },
  ) => string;
  /** 上传文件，变成一个新节点 */
  uploadAsNode: (file: File, pos: { x: number; y: number }, connectTo?: string) => Promise<void>;
  submit: (nodeId: string) => Promise<void>;
  /** 把屏幕坐标换成画布坐标 */
  toFlow: (p: { x: number; y: number }) => { x: number; y: number };
  openAddMenu: (screen: { x: number; y: number }, opts?: { connectFrom?: string; connectTo?: string }) => void;
  expandScript: (nodeId: string) => void;
}

export const CanvasContext = createContext<CanvasCtx>(null as any);
export const useCanvas = () => useContext(CanvasContext);
