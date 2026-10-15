// 模型管理：总览已配置的模型；添加服务商（火山引擎 / 中转站）、填 key、测试、管理每个服务商下的模型
import { Fragment, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, CloudDownload, FlaskConical, LayoutList, Loader2, Plus, Trash2, X, XCircle } from 'lucide-react';
import { confirmDialog } from './Dialog';
import { Popover } from './Popover';
import { ComboInput, Select } from './Select';
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

const TYPE_LABEL: Record<ProviderType, string> = { volcengine: '火山引擎', relay: '中转站' };
const CAP_LABEL: Record<Capability, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };
const PROTOCOLS: { id: RelayProtocol; label: string }[] = [
  { id: 'openai-chat', label: 'OpenAI 对话' },
  { id: 'openai-images', label: 'OpenAI 生图' },
  { id: 'openai-videos', label: 'OpenAI 视频（/v1/videos）' },
  { id: 'ark-image', label: '火山格式生图' },
  { id: 'ark-video', label: '火山格式视频' },
  { id: 'custom', label: '自定义模板' },
];
const DEFAULT_PRESET: Record<Capability, string> = { text: 'chat', image: 'seedream', video: 'seedance', audio: 'tts' };
/** 中转站模型选了类型后，默认用的接口格式和参数预设（OpenAI 兼容格式最常见） */
const RELAY_DEFAULTS: Record<'text' | 'image' | 'video', { protocol: RelayProtocol; preset: string }> = {
  text: { protocol: 'openai-chat', preset: 'chat' },
  image: { protocol: 'openai-images', preset: 'openai-images' },
  video: { protocol: 'openai-videos', preset: 'openai-videos' },
};
const ADD_CAPS = ['text', 'image', 'video'] as const;
type AddCap = (typeof ADD_CAPS)[number];

/** 新加一个某类型的模型：中转站用 OpenAI 兼容格式，火山引擎用方舟的预设 */
const newModel = (type: ProviderType, cap: AddCap, remoteModel = '', name = ''): ProviderModelConfig => ({
  id: '',
  name,
  capability: cap,
  remoteModel,
  preset: type === 'relay' ? RELAY_DEFAULTS[cap].preset : DEFAULT_PRESET[cap],
  protocol: type === 'relay' ? RELAY_DEFAULTS[cap].protocol : undefined,
  enabled: true,
});

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
  const { refreshModels, toast, models } = useApp();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [openTpl, setOpenTpl] = useState<string | null>(null);
  // 拉取到的模型列表（勾选后加进表格）
  // cap = 这一批要加成什么类型，先选类型再勾选，不按名字猜
  const [pull, setPull] = useState<PullState | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  // 每个中转站能用的模型 ID（给表格里的「模型 ID」下拉选）；null = 正在获取或获取失败
  const [remoteIds, setRemoteIds] = useState<Record<string, string[] | null>>({});
  const loadRemoteIds = (force = false) => {
    const id = draft?.id;
    if (!draft || draft.type !== 'relay' || !id || (!force && id in remoteIds)) return;
    setRemoteIds((r) => ({ ...r, [id]: null }));
    api
      .remoteModels(id)
      .then((list) => setRemoteIds((r) => ({ ...r, [id]: list.filter((g) => g.supported).map((g) => g.remoteModel) })))
      .catch(() => setRemoteIds((r) => ({ ...r, [id]: [] }))); // 拿不到（key 不对、中转站不开放列表）就只能手填
  };
  const [pulling, setPulling] = useState(false);
  // 每个模型「试一下」的结果，按模型 id
  const [modelTests, setModelTests] = useState<Record<string, { ok?: boolean; message: string; loading?: boolean }>>({});

  const load = async (selectId?: string) => {
    const ps = await api.providers();
    setProviders(ps);
    const sel = selectId ? ps.find((p) => p.id === selectId) : undefined;
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
      name: quick?.name || (type === 'relay' ? '新中转站' : '火山引擎'),
      type,
      baseUrl: quick?.baseUrl || (type === 'volcengine' ? 'https://ark.cn-beijing.volces.com/api/v3' : ''),
      apiKey: '',
      clearKey: false,
      keyHint: '',
      enabled: true,
      concurrency: 2,
      refMode: 'base64',
      publicBaseUrl: '',
      models: (quick?.models || []).map((m) => newModel('relay', 'text', m.remoteModel, m.name)),
    });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setModel = (i: number, patch: Partial<ProviderModelConfig>) =>
    setDraft((d) => (d ? { ...d, models: d.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) } : d));

  const addModel = (cap: AddCap) => {
    if (!draft) return;
    set({ models: [...draft.models, newModel(draft.type, cap)] });
    setAddMenu(false);
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
      // key 或地址可能改了：清掉这个服务商的模型列表缓存，下次点「模型 ID」时重新获取
      setRemoteIds((r) => {
        const { [saved.id]: _, ...rest } = r;
        return rest;
      });
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
      setRemoteIds((r) => ({ ...r, [saved.id]: items.filter((g) => g.supported).map((g) => g.remoteModel) }));
      if (!items.length) return toast('这个 key 没有返回任何模型，请手动添加', 'error');
      setPull({ items, picked: new Set(), q: '', cap: null });
    } catch (e: any) {
      toast(`拉取失败：${e.message}`, 'error');
    } finally {
      setPulling(false);
    }
  };

  // 选中的模型都按「添加为」的类型加进表格；列表不关，可以换个类型接着加下一批
  const addPicked = () => {
    if (!draft || !pull?.cap) return;
    const cap = pull.cap;
    const added = pull.items.filter((g) => pull.picked.has(g.remoteModel)).map((g) => newModel(draft.type, cap, g.remoteModel, g.remoteModel));
    set({ models: [...draft.models, ...added] });
    setPull({ ...pull, picked: new Set() });
    toast(`加了 ${added.length} 个${CAP_LABEL[cap]}模型，记得点「保存」`);
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
    const ok = await confirmDialog({
      title: `删除服务商「${draft.name}」？`,
      message: '它下面的模型会一起删掉，已经生成的文件不受影响。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
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
            <button
              className={`mm-item ${!draft ? 'on' : ''}`}
              onClick={() => {
                setPull(null);
                setDraft(null);
              }}
            >
              <LayoutList size={14} className="mm-overview-icon" />
              <span className="mm-name">全部模型</span>
              <span className="muted">{models.length}</span>
            </button>
            <div className="mm-sep" />
            {providers.map((p) => (
              <button
                key={p.id}
                className={`mm-item ${draft?.id === p.id ? 'on' : ''}`}
                onClick={() => {
                  setPull(null);
                  setDraft(toDraft(p));
                }}
              >
                <span className={`dot ${p.enabled && p.keyHint ? 'ok' : ''}`} />
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

          {!draft && <Overview models={models} />}

          {draft && (
            <div className="mm-form">
              <div className="form-grid">
                <label>名称</label>
                <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                <label>类型</label>
                <div className="muted">{TYPE_LABEL[draft.type]}</div>
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
                  <Select
                    value={draft.refMode}
                    options={[
                      { value: 'base64', label: '直接塞进请求（base64）' },
                      { value: 'public', label: '给公网链接' },
                    ]}
                    onChange={(v) => set({ refMode: v })}
                  />
                  {draft.refMode === 'public' && (
                    <input
                      value={draft.publicBaseUrl}
                      placeholder="能从外网访问到本机的地址，例如 https://xxx.example.com"
                      onChange={(e) => set({ publicBaseUrl: e.target.value })}
                    />
                  )}
                </div>
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
                <span className="chip-wrap">
                  <button className="ghost" onClick={() => setAddMenu(!addMenu)} title="先选这个模型是文本、图片还是视频，再填模型 ID">
                    <Plus size={13} /> 手动添加 <ChevronDown size={13} />
                  </button>
                  <Popover open={addMenu} onClose={() => setAddMenu(false)} placement="bottom" className="right list-pop add-model-pop">
                    {ADD_CAPS.map((c) => (
                      <button key={c} className="list-item" onClick={() => addModel(c)}>
                        {CAP_LABEL[c]}模型
                      </button>
                    ))}
                  </Popover>
                </span>
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
                          <Select
                            value={m.capability}
                            options={(Object.keys(CAP_LABEL) as Capability[]).map((k) => ({ value: k, label: CAP_LABEL[k] }))}
                            onChange={(c) => {
                              // 中转站：类型变了，接口格式和参数预设一起换成这个类型的默认值
                              const relay = draft.type === 'relay' && c !== 'audio' ? RELAY_DEFAULTS[c] : undefined;
                              setModel(i, { capability: c, preset: relay?.preset || DEFAULT_PRESET[c], ...(relay ? { protocol: relay.protocol } : {}) });
                            }}
                          />
                        </td>
                        <td>
                          {draft.type === 'relay' && draft.id ? (
                            // 中转站：可以从这个 key 能用的模型里下拉选，也能手填；选中后显示名空着就一起填上
                            <ComboInput
                              value={m.remoteModel}
                              options={remoteIds[draft.id] ?? null}
                              loading={draft.id in remoteIds && remoteIds[draft.id] === null}
                              placeholder="点一下从列表选，或手填"
                              onFocus={() => loadRemoteIds()}
                              onChange={(v) => setModel(i, { remoteModel: v })}
                              onPick={(v) => {
                                if (!m.name.trim() || m.name === m.remoteModel) setModel(i, { name: v });
                              }}
                            />
                          ) : (
                            <input value={m.remoteModel} placeholder="厂商那边的模型名" onChange={(e) => setModel(i, { remoteModel: e.target.value })} />
                          )}
                        </td>
                        {draft.type === 'relay' && (
                          <td>
                            <Select
                              value={m.protocol || ''}
                              options={PROTOCOLS.map((p) => ({ value: p.id, label: p.label }))}
                              onChange={(v) => setModel(i, { protocol: v })}
                            />
                            {m.protocol === 'custom' && (
                              <button className="link" onClick={() => setOpenTpl(openTpl === `${i}` ? null : `${i}`)}>
                                编辑模板
                              </button>
                            )}
                          </td>
                        )}
                        <td>
                          <Select value={m.preset} options={presets.map((p) => ({ value: p.id, label: p.label }))} onChange={(v) => setModel(i, { preset: v })} />
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
                          <Select
                            value={m.price?.unit || 'per_call'}
                            options={[
                              { value: 'per_call', label: '/次' },
                              { value: 'per_second', label: '/秒' },
                              { value: 'per_image', label: '/张' },
                            ]}
                            onChange={(u) => setModel(i, { price: { amount: m.price?.amount ?? 0, unit: u } })}
                          />
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

interface PullState {
  items: RemoteModelGuess[];
  picked: Set<string>;
  q: string;
  cap: AddCap | null;
}

/** 拉取到的模型列表：先选「添加为」什么类型，再搜索、勾选、加入表格 */
function PullPicker({ pull, existing, onChange, onAdd }: { pull: PullState; existing: string[]; onChange: (p: PullState | null) => void; onAdd: () => void }) {
  const q = pull.q.trim().toLowerCase();
  const shown = pull.items.filter((g) => !q || g.remoteModel.toLowerCase().includes(q));
  const toggle = (id: string) => {
    const picked = new Set(pull.picked);
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    onChange({ ...pull, picked });
  };
  return (
    <div className="pull">
      <div className="pull-head">
        <span className="pull-as">添加为</span>
        <div className="seg">
          {ADD_CAPS.map((c) => (
            <button key={c} className={pull.cap === c ? 'on' : ''} onClick={() => onChange({ ...pull, cap: c })}>
              {CAP_LABEL[c]}
            </button>
          ))}
        </div>
        <input placeholder={`搜索 ${pull.items.length} 个模型`} value={pull.q} onChange={(e) => onChange({ ...pull, q: e.target.value })} />
        <span className="spacer" />
        <button className="ghost" onClick={() => onChange(null)}>
          关闭
        </button>
        <button
          className="primary"
          disabled={!pull.picked.size || !pull.cap}
          title={!pull.cap ? '先在左边选这批模型是文本、图片还是视频' : undefined}
          onClick={onAdd}
        >
          {pull.cap ? `加入 ${pull.picked.size} 个${CAP_LABEL[pull.cap]}模型` : '先选类型'}
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
              {added ? <span className="muted">已添加</span> : !g.supported && <span className="muted">向量 / 语音类，用不上</span>}
            </label>
          );
        })}
        {shown.length === 0 && <div className="muted pad">没有匹配的模型</div>}
      </div>
    </div>
  );
}

/** 总览：已经能用的模型（服务商启用、填了 key、模型启用），按类型分组，只列名字 */
function Overview({ models }: { models: { id: string; name: string; capability: Capability }[] }) {
  const groups = (['text', 'image', 'video', 'audio'] as Capability[]).map((c) => ({ c, list: models.filter((m) => m.capability === c) })).filter((g) => g.list.length);
  return (
    <div className="mm-form mm-overview">
      <div className="muted">这里列出现在能用的模型（服务商已启用、填了 key、模型已启用）。要修改，点左边对应的服务商。</div>
      {groups.length === 0 && <div className="muted pad">还没有能用的模型：点左下角添加一个服务商</div>}
      {groups.map((g) => (
        <div key={g.c} className="ov-group">
          <div className="ov-title">
            {CAP_LABEL[g.c]}模型 <span className="muted">{g.list.length}</span>
          </div>
          <div className="ov-names">
            {g.list.map((m) => (
              <span key={m.id} className="ov-name">
                {m.name}
              </span>
            ))}
          </div>
        </div>
      ))}
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
        <Select
          value={v.resultKind}
          options={[
            { value: 'video', label: '视频' },
            { value: 'image', label: '图片' },
            { value: 'audio', label: '音频' },
          ]}
          onChange={(k) => onChange({ ...v, resultKind: k })}
        />
      </div>
    </div>
  );
}
