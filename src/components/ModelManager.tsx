// 模型管理：添加服务商（火山引擎 / 中转站 / 演示）、填 key、测试、管理每个服务商下的模型
import { Fragment, useEffect, useState } from 'react';
import { CheckCircle2, Plus, Trash2, X, XCircle } from 'lucide-react';
import type { Capability, CustomTemplate, ProviderModelConfig, ProviderType, ProviderView, RelayProtocol } from '../../shared/types';
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
  { id: 'ark-image', label: '火山格式生图' },
  { id: 'ark-video', label: '火山格式视频' },
  { id: 'custom', label: '自定义模板' },
];
const DEFAULT_PRESET: Record<Capability, string> = { text: 'chat', image: 'seedream', video: 'seedance', audio: 'mock-audio' };

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

  const add = (type: ProviderType) => {
    setDraft({
      id: null,
      name: type === 'relay' ? '新中转站' : type === 'volcengine' ? '火山引擎' : '演示模型',
      type,
      baseUrl: type === 'volcengine' ? 'https://ark.cn-beijing.volces.com/api/v3' : '',
      apiKey: '',
      clearKey: false,
      keyHint: '',
      enabled: true,
      concurrency: 2,
      refMode: 'base64',
      publicBaseUrl: '',
      models: [],
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
          preset: draft.type === 'relay' ? 'generic-video' : DEFAULT_PRESET[cap],
          protocol: draft.type === 'relay' ? 'ark-video' : undefined,
          enabled: true,
        },
      ],
    });
  };

  const save = async (): Promise<string | null> => {
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
      toast('已保存');
      return saved.id;
    } catch (e: any) {
      toast(e.message, 'error');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const id = await save();
    if (!id) return;
    const r = await api.testProvider(id);
    toast(r.message, r.ok ? 'info' : 'error');
    load(id);
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
              <button key={p.id} className={`mm-item ${draft?.id === p.id ? 'on' : ''}`} onClick={() => setDraft(toDraft(p))}>
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
                <button className="ghost" onClick={addModel}>
                  <Plus size={13} /> 添加模型
                </button>
              </div>
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
                          <select value={m.capability} onChange={(e) => setModel(i, { capability: e.target.value as Capability, preset: DEFAULT_PRESET[e.target.value as Capability] })}>
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
                        <td>
                          <button className="icon" onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
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
                <button className="primary" onClick={save} disabled={saving}>
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
