// 模型管理：添加服务商（火山引擎 / 中转站 / 演示）、填 key、测试、管理每个服务商下的模型
import { Fragment, useEffect, useState } from 'react';
import { CheckCircle2, CloudDownload, FlaskConical, Loader2, Plus, Trash2, X, XCircle } from 'lucide-react';
import type { Capability, CustomTemplate, ProviderModelConfig, ProviderType, ProviderView, RelayProtocol, RemoteModelGuess } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../context';
import { fmtTime } from '../lib';

interface Draft {
  id: string | null;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string; // 留空 = 不改
  clearKey: boolean;
  keyHint: string;
  enabled: boolean;
  concurrency: number;
  refMode: 'base64' | 'public';
  publicBaseUrl: string;
  models: ProviderModelConfig[];
  lastTest?: ProviderView['lastTest'];
}

const TYPE_LABEL: Record<ProviderType, string> = { volcengine: '火山引擎', relay: '中转站', mock: '演示' };
const CAP_LABEL: Record<Capability, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };
const PROTOCOLS: { id: RelayProtocol; label: string }[] = [
  { id: 'openai-chat', label: 'OpenAI 对话' },
  { id: 'openai-images', label: 'OpenAI 生图' },
  { id: 'openai-videos', label: 'OpenAI 视频（/v1/videos）' },
  { id: 'ark-image', label: '火山格式生图' },
  { id: 'ark-video', label: '火山格式视频' },
  { id: 'custom', label: '自定义模板' },
];
const DEFAULT_PRESET: Record<Capability, string> = { text: 'chat', image: 'seedream', video: 'seedance', audio: 'mock-audio' };
/** 中转站模型选了类型后，默认用的接口格式和参数预设（OpenAI 兼容格式最常见） */
const RELAY_DEFAULTS: Record<'text' | 'image' | 'video', { protocol: RelayProtocol; preset: string }> = {
  text: { protocol: 'openai-chat', preset: 'chat' },
  image: { protocol: 'openai-images', preset: 'openai-images' },
  video: { protocol: 'openai-videos', preset: 'openai-videos' },
};
const RELAY_CAPS = ['text', 'image', 'video'] as const;

/** 快速添加：兼容 OpenAI 格式的常见服务商，地址填好，只差 key。模型 ID 以各家文档为准，也可以添加后点「拉取模型列表」 */
const QUICK_ADD: { label: string; name: string; baseUrl: string; models: { name: string; remoteModel: string }[] }[] = [
  {
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { name: 'DeepSeek 对话', remoteModel: 'deepseek-chat' },
      { name: 'DeepSeek 推理', remoteModel: 'deepseek-reasoner' },
    ],
  },
  { label: '通义千问', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
  { label: 'Kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: [] },
];

const fromGuess = (g: RemoteModelGuess): ProviderModelConfig => ({
  id: '',
  name: g.remoteModel,
  capability: g.capability,
  remoteModel: g.remoteModel,
  preset: g.preset,
  protocol: g.protocol,
  // 自定义模板还没填，先不启用，免得在面板里选到一个跑不通的模型
  enabled: g.supported && g.protocol !== 'custom',
});

const toDraft = (p: ProviderView): Draft => ({
  id: p.id,
  name: p.name,
  type: p.type,
  baseUrl: p.baseUrl,
  apiKey: '',
  clearKey: false,
  keyHint: p.keyHint,
  enabled: p.enabled,
  concurrency: p.concurrency,
  refMode: p.refMode,
  publicBaseUrl: p.publicBaseUrl || '',
  models: p.models.map((m) => ({ ...m })),
  lastTest: p.lastTest,
});

export function ModelManager({ onClose }: { onClose: () => void }) {
  const { refreshModels, toast } = useApp();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [openTpl, setOpenTpl] = useState<string | null>(null);
  // 拉取到的模型列表（勾选后加进表格）
  const [pull, setPull] = useState<{ items: RemoteModelGuess[]; picked: Set<string>; q: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  // 每个模型「试一下」的结果，按模型 id
  const [modelTests, setModelTests] = useState<Record<string, { ok?: boolean; message: string; loading?: boolean }>>({});

  const load = async (selectId?: string) => {
    const ps = await api.providers();
    setProviders(ps);
    const sel = ps.find((p) => p.id === (selectId ?? draft?.id)) || ps[0];
    if (sel) setDraft(toDraft(sel));
  };

  useEffect(() => {
    load();
    api.presets().then(setPresets);
  }, []);

  const add = (type: ProviderType, quick?: (typeof QUICK_ADD)[number]) => {
    setPull(null);
    setDraft({
      id: null,
      name: quick?.name || (type === 'relay' ? '新中转站' : type === 'volcengine' ? '火山引擎' : '演示模型'),
      type,
      baseUrl: quick?.baseUrl || (type === 'volcengine' ? 'https://ark.cn-beijing.volces.com/api/v3' : ''),
      apiKey: '',
      clearKey: false,
      keyHint: '',
      enabled: true,
      concurrency: 2,
      refMode: 'base64',
      publicBaseUrl: '',
      models: (quick?.models || []).map((m) => ({ ...fromGuess({ remoteModel: m.remoteModel, capability: 'text', protocol: 'openai-chat', preset: 'chat', supported: true }), name: m.name })),
    });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setModel = (i: number, patch: Partial<ProviderModelConfig>) =>
    setDraft((d) => (d ? { ...d, models: d.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) } : d));

  const addModel = () => {
    if (!draft) return;
    const cap: Capability = 'video';
    set({
      models: [
        ...draft.models,
        {
          id: '',
          name: '',
          capability: cap,
          remoteModel: '',
          preset: draft.type === 'relay' ? RELAY_DEFAULTS.video.preset : DEFAULT_PRESET[cap],
          protocol: draft.type === 'relay' ? RELAY_DEFAULTS.video.protocol : undefined,
          enabled: true,
        },
      ],
    });
  };

  /** quiet：拉取、试一下之前顺手保存，不弹「已保存」 */
  const save = async (quiet = false): Promise<ProviderView | null> => {
    if (!draft) return null;
    setSaving(true);
    try {
      const body: any = { ...draft };
      delete body.id;
      delete body.keyHint;
      delete body.lastTest;
      if (draft.clearKey) body.apiKey = '';
      else if (!draft.apiKey) delete body.apiKey;
      delete body.clearKey;
      const saved = await api.saveProvider(draft.id, body);
      await load(saved.id);
      refreshModels();
      if (!quiet) toast('已保存');
      return saved;
    } catch (e: any) {
      toast(e.message, 'error');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const saved = await save();
    if (!saved) return;
    const r = await api.testProvider(saved.id);
    toast(r.message, r.ok ? 'info' : 'error');
    load(saved.id);
  };

  // 先保存（key 要存到后端才能用），再拉这个 key 能用的模型
  const pullModels = async () => {
    const saved = await save(true);
    if (!saved) return;
    setPulling(true);
    try {
      const items = await api.remoteModels(saved.id);
      if (!items.length) return toast('这个 key 没有返回任何模型，请手动添加', 'error');
      setPull({ items, picked: new Set(), q: '' });
    } catch (e: any) {
      toast(`拉取失败：${e.message}`, 'error');
    } finally {
      setPulling(false);
    }
  };

  const addPicked = () => {
    if (!draft || !pull) return;
    const added = pull.items.filter((g) => pull.picked.has(g.remoteModel)).map(fromGuess);
    set({ models: [...draft.models, ...added] });
    setPull(null);
    toast(`加了 ${added.length} 个模型，类型和接口格式是按名字猜的，核对一下再点「保存」`);
  };

  // 试一下单个模型：先保存，拿到保存后的模型 id 再测
  const testOne = async (i: number) => {
    const saved = await save(true);
    const mid = saved?.models[i]?.id;
    if (!saved || !mid) return;
    setModelTests((t) => ({ ...t, [mid]: { loading: true, message: '测试中…' } }));
    try {
      const r = await api.testModel(saved.id, mid);
      setModelTests((t) => ({ ...t, [mid]: r }));
    } catch (e: any) {
      setModelTests((t) => ({ ...t, [mid]: { ok: false, message: e.message } }));
    }
  };

  const remove = async () => {
    if (!draft?.id) return setDraft(null);
    if (!confirm(`删除服务商「${draft.name}」？它下面的模型会一起删掉（已生成的文件不受影响）`)) return;
    await api.deleteProvider(draft.id);
    setDraft(null);
    await load('');
    refreshModels();
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <b>模型管理</b>
          <span className="muted">接一个新厂商 = 添加一个服务商；同一家中转站的不同分组 key 可以各加一个</span>
          <span className="spacer" />
          <button className="icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="mm">
          <div className="mm-list">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`mm-item ${draft?.id === p.id ? 'on' : ''}`}
                onClick={() => {
                  setPull(null);
                  setDraft(toDraft(p));
                }}
              >
                <span className={`dot ${p.enabled && (p.type === 'mock' || p.keyHint) ? 'ok' : ''}`} />
                <span className="mm-name">{p.name}</span>
                <span className="muted">{TYPE_LABEL[p.type]}</span>
              </button>
            ))}
            <div className="mm-add">
              <button onClick={() => add('volcengine')}>
                <Plus size={13} /> 火山引擎
              </button>
              <button onClick={() => add('relay')}>
                <Plus size={13} /> 中转站
              </button>
              <button onClick={() => add('mock')}>
                <Plus size={13} /> 演示
              </button>
            </div>
            <div className="mm-add-label muted">快速添加（地址已填好）</div>
            <div className="mm-add">
              {QUICK_ADD.map((q) => (
                <button key={q.label} onClick={() => add('relay', q)}>
                  <Plus size={13} /> {q.label}
                </button>
              ))}
            </div>
          </div>

          {draft && (
            <div className="mm-form">
              <div className="form-grid">
                <label>名称</label>
                <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                <label>类型</label>
                <div className="muted">{TYPE_LABEL[draft.type]}</div>
                {draft.type !== 'mock' && (
                  <>
                    <label>接口地址</label>
                    <input
                      value={draft.baseUrl}
                      placeholder={draft.type === 'relay' ? '例如 https://4sapi.com/v1' : 'https://ark.cn-beijing.volces.com/api/v3'}
                      onChange={(e) => set({ baseUrl: e.target.value })}
                    />
                    <label>API key</label>
                    <div className="row">
                      <input
                        type="password"
                        value={draft.apiKey}
                        placeholder={draft.keyHint ? `已保存 ${draft.keyHint}，留空不改` : '粘贴 key，加密保存在本机'}
                        onChange={(e) => set({ apiKey: e.target.value, clearKey: false })}
                      />
                      {draft.keyHint && (
                        <button className="ghost" onClick={() => set({ clearKey: !draft.clearKey, apiKey: '' })}>
                          {draft.clearKey ? '撤销清除' : '清除 key'}
                        </button>
                      )}
                    </div>
                    <label>参考图传法</label>
                    <div className="row">
                      <select value={draft.refMode} onChange={(e) => set({ refMode: e.target.value as any })}>
                        <option value="base64">直接塞进请求（base64）</option>
                        <option value="public">给公网链接</option>
                      </select>
                      {draft.refMode === 'public' && (
                        <input
                          value={draft.publicBaseUrl}
                          placeholder="能从外网访问到本机的地址，例如 https://xxx.example.com"
                          onChange={(e) => set({ publicBaseUrl: e.target.value })}
                        />
                      )}
                    </div>
                  </>
                )}
                <label>同时最多</label>
                <div className="row">
                  <input className="short" type="number" min={1} max={10} value={draft.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })} />
                  <span className="muted">个任务</span>
                  <span className="spacer" />
                  <label className="switch">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                    <span>{draft.enabled ? '启用' : '停用'}</span>
                  </label>
                </div>
              </div>

              {draft.lastTest && (
                <div className={`test-result ${draft.lastTest.ok ? 'ok' : 'bad'}`}>
                  {draft.lastTest.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {draft.lastTest.message}
                  <span className="muted">（{fmtTime(draft.lastTest.at)}）</span>
                </div>
              )}

              <div className="mm-models-head">
                <b>模型</b>
                <span className="muted">模型 ID 以厂商控制台为准；单价只用来估算花费</span>
                <span className="spacer" />
                {draft.type === 'relay' && (
                  <button className="ghost" onClick={pullModels} disabled={saving || pulling} title="保存后，列出这个 key 能用的全部模型，勾选加入">
                    {pulling ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />} 拉取模型列表
                  </button>
                )}
                <button className="ghost" onClick={addModel}>
                  <Plus size={13} /> 手动添加
                </button>
              </div>
              {pull && <PullPicker pull={pull} existing={draft.models.map((m) => m.remoteModel)} onChange={setPull} onAdd={addPicked} />}
              <table className="mm-table">
                <thead>
                  <tr>
                    <th>启用</th>
                    <th>显示名</th>
                    <th>类型</th>
                    <th>模型 ID</th>
                    {draft.type === 'relay' && <th>接口格式</th>}
                    <th>参数预设</th>
                    <th>单价（元）</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.models.map((m, i) => (
                    <Fragment key={i}>
                      <tr>
                        <td>
                          <input type="checkbox" checked={m.enabled} onChange={(e) => setModel(i, { enabled: e.target.checked })} />
                        </td>
                        <td>
                          <input value={m.name} placeholder="界面上显示的名字" onChange={(e) => setModel(i, { name: e.target.value })} />
                        </td>
                        <td>
                          <select
                            value={m.capability}
                            onChange={(e) => {
                              const c = e.target.value as Capability;
                              // 中转站：类型变了，接口格式和参数预设一起换成这个类型的默认值
                              const relay = draft.type === 'relay' && c !== 'audio' ? RELAY_DEFAULTS[c] : undefined;
                              setModel(i, { capability: c, preset: relay?.preset || DEFAULT_PRESET[c], ...(relay ? { protocol: relay.protocol } : {}) });
                            }}
                          >
                            {Object.entries(CAP_LABEL).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input value={m.remoteModel} placeholder="厂商那边的模型名" onChange={(e) => setModel(i, { remoteModel: e.target.value })} />
                        </td>
                        {draft.type === 'relay' && (
                          <td>
                            <select value={m.protocol || ''} onChange={(e) => setModel(i, { protocol: e.target.value as RelayProtocol })}>
                              <option value="">请选择</option>
                              {PROTOCOLS.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                            {m.protocol === 'custom' && (
                              <button className="link" onClick={() => setOpenTpl(openTpl === `${i}` ? null : `${i}`)}>
                                编辑模板
                              </button>
                            )}
                          </td>
                        )}
                        <td>
                          <select value={m.preset} onChange={(e) => setModel(i, { preset: e.target.value })}>
                            {presets.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="price">
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={m.price?.amount ?? ''}
                            placeholder="—"
                            onChange={(e) =>
                              setModel(i, { price: e.target.value === '' ? undefined : { unit: m.price?.unit || 'per_call', amount: Number(e.target.value) } })
                            }
                          />
                          <select
                            value={m.price?.unit || 'per_call'}
                            onChange={(e) => setModel(i, { price: { amount: m.price?.amount ?? 0, unit: e.target.value as any } })}
                          >
                            <option value="per_call">/次</option>
                            <option value="per_second">/秒</option>
                            <option value="per_image">/张</option>
                          </select>
                        </td>
                        <td className="nowrap">
                          <button className="icon" title="试一下：文本模型发一句话；图片 / 视频模型只核对 ID，不扣费" onClick={() => testOne(i)} disabled={saving}>
                            <FlaskConical size={14} />
                          </button>
                          <button className="icon" title="删除" onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                      {m.id && modelTests[m.id] && (
                        <tr>
                          <td colSpan={8}>
                            <div className={`test-result ${modelTests[m.id].loading ? '' : modelTests[m.id].ok ? 'ok' : 'bad'}`}>
                              {modelTests[m.id].loading ? <Loader2 size={14} className="spin" /> : modelTests[m.id].ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                              {m.name || m.remoteModel}：{modelTests[m.id].message}
                            </div>
                          </td>
                        </tr>
                      )}
                      {openTpl === `${i}` && m.protocol === 'custom' && (
                        <tr>
                          <td colSpan={8}>
                            <TemplateEditor value={m.custom} onChange={(c) => setModel(i, { custom: c })} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              <div className="mm-actions">
                <button className="danger" onClick={remove}>
                  删除服务商
                </button>
                <span className="spacer" />
                <button className="ghost" onClick={test} disabled={saving}>
                  保存并测试连接
                </button>
                <button className="primary" onClick={() => save()} disabled={saving}>
                  保存
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CAP_OF_GUESS = (g: RemoteModelGuess) => (g.supported ? CAP_LABEL[g.capability] : '用不上');
const PROTOCOL_LABEL = (id?: RelayProtocol) => PROTOCOLS.find((p) => p.id === id)?.label || '';

/** 拉取到的模型列表：搜索、勾选、加入表格 */
function PullPicker({
  pull,
  existing,
  onChange,
  onAdd,
}: {
  pull: { items: RemoteModelGuess[]; picked: Set<string>; q: string };
  existing: string[];
  onChange: (p: { items: RemoteModelGuess[]; picked: Set<string>; q: string } | null) => void;
  onAdd: () => void;
}) {
  const q = pull.q.trim().toLowerCase();
  const shown = pull.items.filter((g) => !q || g.remoteModel.toLowerCase().includes(q));
  // 改类型：接口格式和参数预设换成这个类型的默认值
  const setCap = (id: string, cap: (typeof RELAY_CAPS)[number]) =>
    onChange({ ...pull, items: pull.items.map((g) => (g.remoteModel === id ? { ...g, capability: cap, ...RELAY_DEFAULTS[cap], note: undefined } : g)) });
  const toggle = (id: string) => {
    const picked = new Set(pull.picked);
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    onChange({ ...pull, picked });
  };
  return (
    <div className="pull">
      <div className="pull-head">
        <input autoFocus placeholder={`搜索 ${pull.items.length} 个模型，比如 deepseek、seedance、image`} value={pull.q} onChange={(e) => onChange({ ...pull, q: e.target.value })} />
        <span className="muted">已选 {pull.picked.size} 个</span>
        <span className="spacer" />
        <button className="ghost" onClick={() => onChange(null)}>
          取消
        </button>
        <button className="primary" disabled={!pull.picked.size} onClick={onAdd}>
          加入选中的
        </button>
      </div>
      <div className="pull-list">
        {shown.map((g) => {
          const added = existing.includes(g.remoteModel);
          return (
            <label key={g.remoteModel} className={`pull-item ${!g.supported || added ? 'dim' : ''}`} title={g.note}>
              <input type="checkbox" disabled={!g.supported || added} checked={pull.picked.has(g.remoteModel)} onChange={() => toggle(g.remoteModel)} />
              <span className="pull-id">{g.remoteModel}</span>
              <span className="spacer" />
              {added ? (
                <span className="muted">已添加</span>
              ) : (
                <>
                  {g.note && g.supported && <span className="pull-note">{g.note}</span>}
                  {g.supported ? (
                    // 类型按名字猜的，猜错了直接在这里改
                    <select
                      className="pull-cap"
                      value={g.capability}
                      onChange={(e) => setCap(g.remoteModel, e.target.value as (typeof RELAY_CAPS)[number])}
                    >
                      {RELAY_CAPS.map((c) => (
                        <option key={c} value={c}>
                          {CAP_LABEL[c]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="tag">{CAP_OF_GUESS(g)}</span>
                  )}
                  {g.supported && <span className="muted">{PROTOCOL_LABEL(g.protocol)}</span>}
                </>
              )}
            </label>
          );
        })}
        {shown.length === 0 && <div className="muted pad">没有匹配的模型</div>}
      </div>
    </div>
  );
}

const EMPTY_TPL: CustomTemplate = {
  submitPath: '/video/generations',
  submitBody: '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "images": "{{images}}"\n}',
  taskIdPath: 'id',
  pollPath: '/video/generations/{{taskId}}',
  statusPath: 'status',
  successValues: ['succeeded'],
  failValues: ['failed'],
  resultUrlPath: 'video_url',
  errorPath: 'error.message',
  resultKind: 'video',
};

function TemplateEditor({ value, onChange }: { value?: CustomTemplate; onChange: (v: CustomTemplate) => void }) {
  const v = value || EMPTY_TPL;
  const f = (k: keyof CustomTemplate, label: string, hint?: string) => (
    <>
      <label>{label}</label>
      <input
        value={Array.isArray(v[k]) ? (v[k] as string[]).join(',') : String(v[k] ?? '')}
        placeholder={hint}
        onChange={(e) => onChange({ ...v, [k]: k === 'successValues' || k === 'failValues' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value })}
      />
    </>
  );
  return (
    <div className="tpl">
      <div className="muted">
        占位符：{'{{model}} {{prompt}} {{images}}（全部参考图）{{image_1}} {{first_frame}} {{last_frame}} {{params.ratio}} {{params.duration}}'}。字段路径用点号，如 data.0.url
      </div>
      <div className="form-grid">
        {f('submitPath', '提交地址', '/video/generations')}
        <label>请求体（JSON）</label>
        <textarea rows={6} value={v.submitBody} onChange={(e) => onChange({ ...v, submitBody: e.target.value })} />
        {f('taskIdPath', '任务号字段', 'id')}
        {f('pollPath', '查询地址', '/video/generations/{{taskId}}')}
        {f('statusPath', '状态字段', 'status')}
        {f('successValues', '成功的状态值', 'succeeded,success')}
        {f('failValues', '失败的状态值', 'failed,error')}
        {f('resultUrlPath', '结果链接字段', 'video_url')}
        {f('errorPath', '错误信息字段', 'error.message')}
        <label>结果类型</label>
        <select value={v.resultKind} onChange={(e) => onChange({ ...v, resultKind: e.target.value as any })}>
          <option value="video">视频</option>
          <option value="image">图片</option>
          <option value="audio">音频</option>
        </select>
      </div>
    </div>
  );
}
