// 前后端共用的类型定义。网站只认识这里的格式，不认识任何一家厂商。

/** 模型能干什么 */
export type Capability = 'text' | 'image' | 'video' | 'audio';

/** 画布上的节点种类（参考 LibTV） */
export type NodeKind = 'text' | 'image' | 'video' | 'audio' | 'script';

/** 参考素材在生成里的角色 */
export type RefRole = 'reference' | 'first_frame' | 'last_frame';

/** 一个参数怎么在界面上显示 */
export interface ParamDef {
  key: string;
  label: string;
  type: 'select' | 'number' | 'boolean' | 'text';
  options?: (string | number)[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** 收进「高级设置」 */
  advanced?: boolean;
}

/** 生成模式，比如视频的「文生视频 / 首尾帧 / 全能参考」 */
export interface ModeDef {
  id: string;
  label: string;
  /** 每类素材最多接几个，0 或不写 = 不接 */
  maxRefs: { image?: number; video?: number; audio?: number };
  /** 接入的图片默认当什么用 */
  imageRoles?: RefRole[];
}

/** 价格规则，用来估算花费 */
export interface PriceRule {
  unit: 'per_call' | 'per_second' | 'per_image';
  amount: number; // 元
}

/** 给界面用的模型描述（由服务商配置 + 预设拼出来） */
export interface ModelInfo {
  id: string; // `${providerId}/${modelConfigId}`
  providerId: string;
  providerName: string;
  name: string;
  capability: Capability;
  modes: ModeDef[];
  params: ParamDef[];
  price?: PriceRule;
  note?: string;
}

/** 服务商类型 = 适配器类型 */
export type ProviderType = 'mock' | 'volcengine' | 'relay';

/** 中转站模型的接口格式 */
export type RelayProtocol = 'openai-chat' | 'openai-images' | 'ark-image' | 'ark-video' | 'custom';

/** 自定义接口模板：不写代码接一个新的异步模型 */
export interface CustomTemplate {
  submitPath: string; // 例如 /video/generations
  submitBody: string; // JSON 文本，可用 {{model}} {{prompt}} {{images}} {{image_1}} {{params.ratio}}
  taskIdPath: string; // 例如 id 或 data.task_id
  pollPath: string; // 例如 /video/generations/{{taskId}}
  statusPath: string; // 例如 status
  successValues: string[];
  failValues: string[];
  resultUrlPath: string; // 例如 content.video_url 或 data.0.url
  errorPath?: string;
  resultKind: 'image' | 'video' | 'audio';
}

/** 服务商下的一个模型（存在 providers.json 里） */
export interface ProviderModelConfig {
  id: string;
  name: string;
  capability: Capability;
  remoteModel: string; // 厂商那边的模型 ID
  preset: string; // 参数预设，见 server/presets.ts
  protocol?: RelayProtocol; // 只有中转站需要
  custom?: CustomTemplate;
  price?: PriceRule;
  enabled: boolean;
}

/** 从服务商拉到的一个模型，以及按名字猜出来的默认设置 */
export interface RemoteModelGuess {
  remoteModel: string;
  capability: Capability;
  protocol?: RelayProtocol;
  preset: string;
  /** false = 向量、语音识别这类这里用不上的模型 */
  supported: boolean;
  note?: string;
}

/** 给界面看的服务商（key 只露末 4 位） */
export interface ProviderView {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  keyHint: string; // '' = 没填
  enabled: boolean;
  concurrency: number;
  refMode: 'base64' | 'public';
  publicBaseUrl?: string;
  models: ProviderModelConfig[];
  lastTest?: { ok: boolean; message: string; at: string };
}

/** 提交生成时带的参考素材 */
export interface RefInput {
  nodeId: string;
  kind: 'image' | 'video' | 'audio';
  file: string; // 工作文件夹里的相对路径
  role: RefRole;
  characterId?: string;
}

export interface GenerateRequest {
  projectId: string;
  episodeId: string;
  nodeId: string;
  modelId: string;
  mode: string;
  prompt: string;
  /** 连进来的文本节点内容，按顺序拼到提示词前面 */
  inputTexts: string[];
  refs: RefInput[];
  /** 连进来但还没有定妆图的角色：只把外形描述拼进提示词 */
  characterIds?: string[];
  params: Record<string, string | number | boolean>;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface OutputItem {
  kind: Capability;
  file?: string; // 相对工作文件夹
  text?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  capability: Capability;
  providerId: string;
  modelName: string;
  request: GenerateRequest;
  /** 实际发给厂商的提示词（拼好画风、角色描述之后） */
  finalPrompt?: string;
  remoteId?: string;
  attempts: number;
  error?: string;
  /** 厂商那边可能已经出了结果（下载失败、查询超时），可以只重新查询 / 下载，不用重新提交 */
  resumable?: boolean;
  /** 同步接口已经给了结果链接但下载失败时，留着链接方便重新下载 */
  pendingOutputs?: { kind: Capability; url: string; mime?: string }[];
  note?: string;
  cost?: number;
  costEstimated?: boolean;
  outputs?: OutputItem[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 节点里的一个版本 */
export interface Version {
  id: string;
  kind: Capability;
  file?: string;
  text?: string;
  jobId?: string;
  createdAt: string;
  label?: string;
}

/** 节点下方生成面板的状态 */
export interface GenState {
  modelId?: string;
  mode?: string;
  prompt: string;
  params: Record<string, string | number | boolean>;
  /** 每条输入连线（按来源节点 id）对应的用途 */
  refRoles: Record<string, RefRole>;
}

export interface NodeData {
  kind: NodeKind;
  title: string;
  versions: Version[];
  current: number; // 当前显示 / 定稿的版本下标，-1 = 还没有
  starred?: string; // 定稿版本 id
  gen: GenState;
  /** 文本节点、脚本节点的正文 */
  text?: string;
  /** 从角色库拖进来的图片节点 */
  characterId?: string;
  /** 运行状态（不存盘也行，存了方便刷新后看到） */
  run?: { status: JobStatus; jobIds: string[]; error?: string };
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  style: string; // 画风描述，自动拼到每条提示词前面
  ratio: string;
  createdAt: string;
}

/** 资产库里的一项（所有画布共用） */
export interface Asset {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  text?: string;
  /** 从哪个文件存进来的（去重用） */
  from?: string;
  projectId?: string;
  createdAt: string;
}

/** 主页「历史画布」卡片 */
export interface ProjectSummary extends Project {
  episodeCount: number;
  nodeCount: number;
  updatedAt: string;
  lastEpisodeId?: string;
  /** 最近生成 / 上传的素材，最多 4 个，做封面 */
  covers: string[];
}

export interface Episode {
  id: string;
  index: number;
  title: string;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  image?: string; // 相对工作文件夹
  createdAt: string;
}

/** 画布文件 canvas.json */
export interface CanvasFile {
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: NodeData; width?: number; height?: number }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  viewport?: { x: number; y: number; zoom: number };
  savedAt?: string;
}

/** 服务器推送的事件 */
export type ServerEvent = { type: 'job'; job: Job } | { type: 'hello' };
