// 选中节点时弹出的生成面板（参考 LibTV 截图二）。
// 对应 ComfyUI 里一个模型节点的全部参数：参考素材自动编号、@ 引用、模型 / 模式 / 参数、高级设置、预估花费。
import { useNodeConnections, useNodesData, useReactFlow, type Node } from '@xyflow/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  FileText,
  Languages,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Palette,
  Plus,
  Settings2,
  ShieldCheck,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import type { Character, NodeData, ParamDef, SettingImage } from '../../shared/types';
import { SettingPicker } from './SettingPicker';
import { styleName } from './StylePicker';
import { api, fileUrl } from '../api';
import { useApp, useCanvas, useNodeJobs } from '../context';
import { buildRequest, collectInputs, estimateCost } from '../inputs';
import { CAMERA_MOVES, KIND_CAP, KIND_LABEL, SETTING_WORD, defaultParams, fileKind, rememberGen, settingImages, settingKind } from '../lib';
import { Popover } from './Popover';

const PLACEHOLDER: Record<string, string> = {
  text: '让文本模型做什么？比如：把这段改写成更详细的视频提示词',
  image: '描述你想要生成的画面内容，@引用素材',
  video: '描述你想要生成的画面内容，@引用素材',
  audio: '要配的台词或声音描述',
};

const ROLE_LABEL = { first_frame: '首帧', last_frame: '尾帧', reference: '参考' } as const;

/** 文本框里第 pos 个字的位置（相对文本框左上角，已减去滚动）：用一个排版完全相同的隐藏 div 量出来 */
function caretXY(ta: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  const keys = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
    'wordSpacing', 'textIndent', 'overflowWrap', 'wordBreak', 'tabSize'] as const;
  for (const k of keys) (div.style as any)[k] = cs[k];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', top: '0', left: '-9999px', overflow: 'hidden' });
  div.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos) || '.';
  div.appendChild(mark);
  document.body.appendChild(div);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
  const r = { x: mark.offsetLeft - ta.scrollLeft, y: mark.offsetTop - ta.scrollTop, lh };
  div.remove();
  return r;
}

export function GeneratePanel({ nodeId, data }: { nodeId: string; data: NodeData }) {
  const { models, characters, toast, openModels, openCharacters, project, episode, styles, saveProject, openProjectSettings } = useApp();
  const nodeJobs = useNodeJobs(episode?.id, nodeId);
  const running = nodeJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const { submit, addNode, uploadAsNode } = useCanvas();
  const { updateNodeData, getNode } = useReactFlow();
  const conns = useNodeConnections({ id: nodeId, handleType: 'target' });
  const srcIds = useMemo(() => conns.map((c) => c.source), [conns]);
  const srcNodes = useNodesData<Node<NodeData>>(srcIds);
  const [expanded, setExpanded] = useState(false);
  const [pop, setPop] = useState<'' | 'params' | 'advanced' | 'camera' | 'chars' | 'model' | 'mode' | 'final' | 'style'>('');
  const [finalPrompt, setFinalPrompt] = useState<{ loading?: boolean; text?: string; error?: string }>({});
  // @ 菜单：start = @ 的位置，end = 输入 @ 时的光标位置（插入引用时替换这一段）
  const [at, setAt] = useState<{ start: number; end: number; q: string } | null>(null);
  // @ 菜单放在 @ 那个字的正下方（下面放不下就放上面），不再固定在整个输入框底下
  const [atPos, setAtPos] = useState<{ left: number; top: number } | null>(null);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const refInput = useRef<HTMLInputElement>(null);

  const cap = KIND_CAP[data.kind]!;
  const list = models.filter((m) => m.capability === cap);
  const model = list.find((m) => m.id === data.gen.modelId) || list[0];
  const mode = model?.modes.find((m) => m.id === data.gen.mode) || model?.modes[0];
  const params = { ...defaultParams(model), ...data.gen.params };
  const sources = srcIds.map((sid) => ({ id: sid, data: srcNodes.find((n) => n.id === sid)?.data as NodeData })).filter((s) => s.data);
  const { media, texts, chars } = collectInputs(sources, data.gen, mode);
  const textModel = models.find((m) => m.capability === 'text');

  const setGen = (patch: Partial<NodeData['gen']>) => updateNodeData(nodeId, { gen: { ...data.gen, ...patch } });
  /** 用户自己改了模型 / 参数 / 模式：改完顺便记住，之后新建的节点默认就用这一套 */
  const setGenAndRemember = (patch: Partial<NodeData['gen']>) => {
    setGen(patch);
    const g = { ...data.gen, ...patch };
    rememberGen(data.kind, project?.id, { modelId: g.modelId || model?.id, mode: g.mode || mode?.id, params: { ...params, ...g.params } });
  };

  // 提示词框自己留一份文字：节点数据要绕画布一圈才回到这里，直接拿它当 value，
  // 在中间打字时浏览器会把光标重置到末尾（之后 @ 插入就会把光标后的字全吞掉）
  const [prompt, setPromptLocal] = useState(data.gen.prompt);
  const setPrompt = (v: string) => {
    setPromptLocal(v);
    setGen({ prompt: v });
  };
  useEffect(() => {
    // 外部改了提示词（撤销、换节点等）才同步；正在输入时以输入框为准
    if (document.activeElement !== taRef.current) setPromptLocal(data.gen.prompt);
  }, [data.gen.prompt]);

  const chooseModel = (id: string) => {
    const m = list.find((x) => x.id === id);
    if (!m) return;
    const next = defaultParams(m);
    for (const p of m.params) {
      const old = data.gen.params[p.key];
      if (old !== undefined && (p.type !== 'select' || p.options?.includes(old as any))) next[p.key] = old;
    }
    setGenAndRemember({ modelId: m.id, mode: m.modes.find((x) => x.id === data.gen.mode)?.id || m.modes[0]?.id, params: next });
    setPop('');
  };

  const setParam = (k: string, v: string | number | boolean) => setGenAndRemember({ params: { ...params, [k]: v } });

  // —— @ 引用 ——
  const onPromptChange = (val: string, caret: number) => {
    setPrompt(val);
    const before = val.slice(0, caret);
    const m = before.match(/@([^\s@]*)$/);
    setAt(m && media.length ? { start: caret - m[0].length, end: caret, q: m[1] } : null);
  };
  const atOptions = at ? media.filter((m) => m.token.slice(1).startsWith(at.q) || m.title.includes(at.q)) : [];
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!at || !ta || !atOptions.length) return setAtPos(null);
    const { x, y, lh } = caretXY(ta, at.start);
    const wrapW = ta.parentElement?.clientWidth || ta.clientWidth;
    const left = Math.max(0, Math.min(x, wrapW - 280));
    const below = ta.offsetTop + y + lh + 4;
    setAtPos({ left, top: below });
    // 下一帧量一下菜单：超出屏幕底部就翻到这一行上面
    requestAnimationFrame(() => {
      const el = atMenuRef.current;
      if (!el) return;
      if (el.getBoundingClientRect().bottom > window.innerHeight - 8) setAtPos({ left, top: ta.offsetTop + y - el.offsetHeight - 4 });
    });
  }, [at?.start, at?.q, atOptions.length, expanded]);
  const insertToken = (token: string) => {
    if (!at) return;
    const next = prompt.slice(0, at.start) + token + ' ' + prompt.slice(at.end);
    setPrompt(next);
    setAt(null);
    requestAnimationFrame(() => {
      const pos = at.start + token.length + 1;
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  };

  /** 点素材缩略图：把 @图1 插到光标处 */
  const insertAtCaret = (token: string) => {
    const p = prompt;
    const ta = taRef.current;
    const s = ta?.selectionStart ?? p.length;
    const e = ta?.selectionEnd ?? p.length;
    const pre = s > 0 && !/\s$/.test(p.slice(0, s)) ? ' ' : '';
    const ins = `${pre}${token} `;
    setPrompt(p.slice(0, s) + ins + p.slice(e));
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(s + ins.length, s + ins.length);
    });
  };

  // 提示词里的 @图1 / @视频1 高亮成标签（textarea 后面垫一层同样排版的高亮层）
  const tokenSet = new Set(media.map((m) => m.token));
  const hlRef = useRef<HTMLDivElement>(null);
  const highlighted = prompt.split(/(@(?:图|视频|音频)\d+)/g).map((part, i) =>
    /^@(图|视频|音频)\d+$/.test(part) ? (
      <mark key={i} className={tokenSet.has(part) ? '' : 'bad'}>
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );

  const node = getNode(nodeId);
  const leftOf = (dy = 0) => ({ x: (node?.position.x || 0) - 380, y: (node?.position.y || 0) + dy });

  // 从设定库放一个设定进来（可以指定用哪一张图），连到这个节点
  const addSetting = (c: Character, img?: SettingImage) => {
    const pickImg = img || settingImages(c)[0];
    addNode('image', leftOf(media.length * 60), {
      title: `${c.name}${pickImg?.note ? ` · ${pickImg.note}` : ''}（${SETTING_WORD[settingKind(c)]}）`,
      characterId: c.id,
      version: pickImg ? { kind: 'image', file: pickImg.file, label: '设定库', variant: pickImg.note || undefined } : undefined,
      connectTo: nodeId,
    });
    setPop('');
  };

  const translate = async () => {
    if (!textModel) return toast('还没有可用的文本模型，去「模型管理」接一个', 'error');
    if (!prompt.trim()) return;
    setTranslating(true);
    try {
      const r = await api.quickText(
        textModel.id,
        `请把下面的内容翻译成英文，只输出译文，保留 @图1 这类标记不翻译：\n${prompt}`,
      );
      if (r.text) setPrompt(r.text.trim());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setTranslating(false);
    }
  };

  // 看看最终发给模型的提示词（画风、连进来的文本、角色描述都拼好、@图1 换成厂商叫法之后）
  const previewFinal = async () => {
    if (pop === 'final') return setPop('');
    setPop('final');
    if (!project || !episode || !model) return;
    setFinalPrompt({ loading: true });
    try {
      const req = buildRequest(project.id, episode.id, nodeId, { ...data, gen: { ...data.gen, prompt } }, model, sources);
      const r = await api.previewPrompt(req);
      setFinalPrompt({ text: r.prompt });
    } catch (e: any) {
      setFinalPrompt({ error: e.message });
    }
  };

  const go = async () => {
    if (busy) return;
    if (model) rememberGen(data.kind, project?.id, { modelId: model.id, mode: mode?.id, params });
    setBusy(true);
    try {
      await submit(nodeId);
    } finally {
      setBusy(false);
    }
  };

  const summary = (model?.params || [])
    .filter((p) => !p.advanced && p.key !== 'generate_audio')
    .map((p) => `${params[p.key]}${p.unit || ''}`)
    .join(' · ');
  const hasAudio = model?.params.some((p) => p.key === 'generate_audio');
  const advanced = (model?.params || []).filter((p) => p.advanced);
  const limits = mode?.maxRefs || {};
  const unusedRefs = media.filter((m) => !(limits[m.kind] || 0)).length;

  if (!list.length) {
    return (
      <div className="gen-panel nodrag nowheel nopan empty">
        还没有可用的{KIND_LABEL[data.kind]}模型。
        <button className="link" onClick={openModels}>
          去模型管理接一个
        </button>
      </div>
    );
  }

  return (
    <div className={`gen-panel nodrag nowheel nopan ${expanded ? 'expanded' : ''}`} onKeyDown={(e) => e.stopPropagation()}>
      <div className="chips">
        <button className="chip" onClick={() => refInput.current?.click()} title="上传一张图 / 一段视频 / 音频作为参考，自动连到这个节点">
          <Plus size={14} /> 参考
        </button>
        {data.kind !== 'text' && data.kind !== 'audio' && (
          <>
            <span className="chip-wrap">
              <button className="chip" onClick={() => setPop(pop === 'chars' ? '' : 'chars')} title="从设定库挑角色、场景、道具，把参考图连进来，描述自动带进提示词">
                <ShieldCheck size={14} /> 设定库
              </button>
              <Popover open={pop === 'chars'} onClose={() => setPop('')} placement="bottom" className="list-pop setting-pop">
                <SettingPicker settings={characters} onPick={addSetting} onManage={() => (setPop(''), openCharacters())} />
              </Popover>
            </span>
            {data.kind === 'video' && (
              <span className="chip-wrap">
                <button className="chip" onClick={() => setPop(pop === 'camera' ? '' : 'camera')}>
                  <Camera size={14} /> 运镜
                </button>
                <Popover open={pop === 'camera'} onClose={() => setPop('')} placement="bottom" className="list-pop">
                  {CAMERA_MOVES.map((c) => (
                    <button
                      key={c}
                      className="list-item"
                      onClick={() => {
                        const p = prompt.trim();
                        setPrompt(p ? `${p}，${c}` : c);
                        setPop('');
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </Popover>
              </span>
            )}
          </>
        )}
        {(data.kind === 'image' || data.kind === 'video') && project && (
          <span className="chip-wrap">
            <button
              className={`chip style-chip ${data.noStyle || !project.style?.trim() ? 'off' : ''}`}
              onClick={() => setPop(pop === 'style' ? '' : 'style')}
              title={data.noStyle ? '这个节点生成时不带画风' : project.style?.trim() ? `画风：${project.style}` : '这个项目还没有设置画风'}
            >
              <Palette size={14} /> {data.noStyle ? '不带画风' : styleName(project, styles)}
            </button>
            <Popover open={pop === 'style'} onClose={() => setPop('')} placement="top" className="list-pop style-pop">
              <div className="style-pop-head">项目画风 · 所有图片 / 视频都会带上</div>
              <div className="style-pop-list">
              <button
                className={`list-item ${!project.style?.trim() ? 'on' : ''}`}
                onClick={() => (saveProject({ style: '', styleId: undefined }), setPop(''))}
              >
                <span className="style-pop-name">无画风</span>
                {!project.style?.trim() && <Check size={14} className="style-check" />}
              </button>
              {styles.map((s) => {
                const on = project.styleId === s.id && project.style === s.prompt;
                return (
                  <button
                    key={s.id}
                    className={`list-item ${on ? 'on' : ''}`}
                    title={s.prompt}
                    onClick={() => (saveProject({ style: s.prompt, styleId: s.id }), setPop(''))}
                  >
                    <span className="style-pop-name">{s.name}</span>
                    {!s.builtin && <span className="muted">我的</span>}
                    {on && <Check size={14} className="style-check" />}
                  </button>
                );
              })}
              </div>
              <div className="style-pop-foot">
                <label className="switch mini" title="比如做白底参考图、角色三视图时，不想带项目画风">
                  <input type="checkbox" checked={Boolean(data.noStyle)} onChange={(e) => updateNodeData(nodeId, { noStyle: e.target.checked || undefined })} />
                  <span>这个节点不带画风</span>
                </label>
                <button className="link" onClick={() => (setPop(''), openProjectSettings())}>
                  改描述 / 自定义…
                </button>
              </div>
            </Popover>
          </span>
        )}
        <span className="spacer" />
        <button className="icon" onClick={() => setExpanded(!expanded)} title={expanded ? '收起' : '展开输入框'}>
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      {(media.length > 0 || texts.length > 0 || chars.length > 0) && (
        <div className="refs">
          {media.map((m) => (
            <div
              key={m.nodeId}
              className={`ref ${!(limits[m.kind] || 0) ? 'unused' : ''}`}
              title={`${m.title}\n点一下把 ${m.token} 插进提示词`}
              onClick={() => insertAtCaret(m.token)}
            >
              {fileKind(m.file) === 'image' && <img src={fileUrl(m.file)} />}
              {fileKind(m.file) === 'video' && <video src={fileUrl(m.file)} muted />}
              {fileKind(m.file) === 'audio' && <div className="ref-audio">♪</div>}
              <span className="ref-no">{m.token.replace('@', '')}</span>
              {m.kind === 'image' && mode?.imageRoles?.includes('first_frame') && (
                <button
                  className="ref-role"
                  onClick={(e) => (e.stopPropagation(), setGen({ refRoles: { ...data.gen.refRoles, [m.nodeId]: m.role === 'first_frame' ? 'last_frame' : 'first_frame' } }))}
                  title="点击切换首帧 / 尾帧"
                >
                  {ROLE_LABEL[m.role]}
                </button>
              )}
              {m.characterId && <span className="ref-char">{SETTING_WORD[settingKind(characters.find((c) => c.id === m.characterId))]}</span>}
            </div>
          ))}
          {chars.map((c) => (
            <div key={c.nodeId} className="ref-text char" title="这个角色还没有定妆图，只会把外形描述带进提示词">
              <ShieldCheck size={12} /> {c.title} · 只带描述
            </div>
          ))}
          {texts.map((t) => (
            <div key={t.nodeId} className="ref-text" title={t.text}>
              <FileText size={12} /> {t.text.slice(0, 18)}
              {t.text.length > 18 ? '…' : ''}
            </div>
          ))}
        </div>
      )}
      {data.chainPrev && (
        <div className="hint chain-hint">
          <Link2 size={13} />
          {srcIds.includes(data.firstFrame || '')
            ? `首帧接「${(getNode(data.chainPrev)?.data as NodeData | undefined)?.title || '上一条'}」的最后一帧（已连上）`
            : `要接「${(getNode(data.chainPrev)?.data as NodeData | undefined)?.title || '上一条'}」的最后一帧：它生成好后会自动连上，再生成这条`}
          <button className="link" onClick={() => updateNodeData(nodeId, { chainPrev: undefined, chainFrom: undefined })} title="不接上一条的尾帧了，这条按自己的提示词开场">
            不接了
          </button>
        </div>
      )}
      {unusedRefs > 0 && mode && (
        <div className="hint">
          「{mode.label}」模式用不到 {unusedRefs} 个参考素材，
          {model.modes
            .filter((x) => (x.maxRefs.image || 0) > 0)
            .slice(-1)
            .map((x) => (
              <button key={x.id} className="link" onClick={() => setGenAndRemember({ mode: x.id })}>
                切到「{x.label}」
              </button>
            ))}
        </div>
      )}

      <div className="prompt-wrap">
        <div ref={hlRef} className="prompt prompt-hl" aria-hidden>
          {highlighted}
          {'\n'}
        </div>
        <textarea
          ref={taRef}
          onScroll={(e) => hlRef.current && (hlRef.current.scrollTop = e.currentTarget.scrollTop)}
          className="prompt"
          value={prompt}
          placeholder={PLACEHOLDER[data.kind]}
          onChange={(e) => onPromptChange(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (at && atOptions.length && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              insertToken(atOptions[0].token);
            } else if (e.key === 'Escape') setAt(null);
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!e.repeat) go();
            }
          }}
        />
        {at && atOptions.length > 0 && (
          <div className="at-menu" ref={atMenuRef} style={atPos ? { left: atPos.left, top: atPos.top } : undefined}>
            {atOptions.map((m) => (
              <button key={m.nodeId} className="list-item" onMouseDown={(e) => (e.preventDefault(), insertToken(m.token))}>
                {fileKind(m.file) === 'image' ? <img src={fileUrl(m.file)} /> : <span className="thumb-empty" />}
                <b>{m.token}</b>
                <span className="muted">{m.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bar">
        <span className="chip-wrap shrink">
          <button className="sel" title={model?.name} onClick={() => setPop(pop === 'model' ? '' : 'model')}>
            <Zap size={14} /> <span className="sel-text">{model?.name}</span> <ChevronDown size={13} />
          </button>
          <Popover open={pop === 'model'} onClose={() => setPop('')} className="list-pop">
            {list.map((m) => (
              <button key={m.id} className={`list-item ${m.id === model?.id ? 'on' : ''}`} onClick={() => chooseModel(m.id)}>
                <span>{m.name}</span>
                <span className="muted">{m.providerName}</span>
              </button>
            ))}
            <button className="list-item muted" onClick={() => (setPop(''), openModels())}>
              管理模型…
            </button>
          </Popover>
        </span>

        {model && model.modes.length > 1 && (
          <span className="chip-wrap">
            <button className="sel" onClick={() => setPop(pop === 'mode' ? '' : 'mode')}>
              {mode?.label} <ChevronDown size={13} />
            </button>
            <Popover open={pop === 'mode'} onClose={() => setPop('')} className="list-pop">
              {model.modes.map((m) => (
                <button key={m.id} className={`list-item ${m.id === mode?.id ? 'on' : ''}`} onClick={() => (setGenAndRemember({ mode: m.id }), setPop(''))}>
                  <span>{m.label}</span>
                  <span className="muted">
                    {[m.maxRefs.image && `图 ≤${m.maxRefs.image}`, m.maxRefs.video && `视频 ≤${m.maxRefs.video}`, m.maxRefs.audio && `音频 ≤${m.maxRefs.audio}`]
                      .filter(Boolean)
                      .join(' · ') || '只用文字'}
                  </span>
                </button>
              ))}
            </Popover>
          </span>
        )}

        {summary && (
          <>
            <span className="divider" />
            <span className="chip-wrap shrink">
              <button className="sel" title={summary} onClick={() => setPop(pop === 'params' ? '' : 'params')}>
                <span className="sel-text">{summary}</span>
                {hasAudio && (params.generate_audio ? <Volume2 size={14} /> : <VolumeX size={14} />)}
                <ChevronDown size={13} />
              </button>
              <Popover open={pop === 'params'} onClose={() => setPop('')} className="param-pop">
                {model.params
                  .filter((p) => !p.advanced)
                  .map((p) => (
                    <ParamControl key={p.key} def={p} value={params[p.key]} onChange={(v) => setParam(p.key, v)} />
                  ))}
              </Popover>
            </span>
          </>
        )}

        <span className="spacer" />
        <span className="chip-wrap">
          <button className={`icon ${pop === 'final' ? 'on' : ''}`} onClick={previewFinal} title="看看最终发给模型的提示词（自动拼上画风、角色描述之后）">
            <Eye size={16} />
          </button>
          <Popover open={pop === 'final'} onClose={() => setPop('')} className="final-pop right">
            <div className="final-head">
              最终发给「{model?.name}」的提示词
              {finalPrompt.text && (
                <button className="link" onClick={() => navigator.clipboard?.writeText(finalPrompt.text!).then(() => toast('已复制'))}>
                  复制
                </button>
              )}
            </div>
            {finalPrompt.loading && (
              <div className="muted pad">
                <Loader2 size={14} className="spin" /> 正在拼…
              </div>
            )}
            {finalPrompt.error && <div className="q-err">{finalPrompt.error}</div>}
            {finalPrompt.text !== undefined && <pre className="final-text">{finalPrompt.text || '（空）'}</pre>}
            <div className="muted final-foot">画风在右上角「设置」里改；角色描述在角色库里改</div>
          </Popover>
        </span>
        <button className="icon" onClick={translate} disabled={translating} title={textModel ? '把提示词翻译成英文' : '需要先接一个文本模型'}>
          {translating ? <Loader2 size={16} className="spin" /> : <Languages size={16} />}
        </button>
        {advanced.length > 0 && (
          <span className="chip-wrap">
            <button className="icon" onClick={() => setPop(pop === 'advanced' ? '' : 'advanced')} title="高级设置">
              <Settings2 size={16} />
            </button>
            <Popover open={pop === 'advanced'} onClose={() => setPop('')} className="param-pop right">
              {advanced.map((p) => (
                <ParamControl key={p.key} def={p} value={params[p.key]} onChange={(v) => setParam(p.key, v)} />
              ))}
            </Popover>
          </span>
        )}
        <span className="cost" title="按「模型管理」里填的单价估算">
          <Zap size={13} /> {estimateCost(model, params)}
        </span>
        <button
          className="send"
          onClick={go}
          disabled={busy}
          title={running ? `已有 ${running} 个在生成；再点会再提交一个（会再扣费）` : '生成（⌘ + 回车）'}
        >
          {busy ? <Loader2 size={18} className="spin" /> : <ArrowUp size={18} />}
          {running > 0 && <span className="send-badge">{running}</span>}
        </button>
      </div>

      <input
        ref={refInput}
        type="file"
        hidden
        accept="image/*,video/*,audio/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadAsNode(f, leftOf(media.length * 60), nodeId);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function ParamControl({ def, value, onChange }: { def: ParamDef; value: any; onChange: (v: string | number | boolean) => void }) {
  return (
    <div className="param">
      <div className="param-label">{def.label}</div>
      {def.type === 'select' && (
        <div className="seg">
          {def.options!.map((o) => (
            <button key={String(o)} className={String(o) === String(value) ? 'on' : ''} onClick={() => onChange(o)}>
              {o}
              {def.unit || ''}
            </button>
          ))}
        </div>
      )}
      {def.type === 'boolean' && (
        <label className="switch">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span>{value ? '开' : '关'}</span>
        </label>
      )}
      {def.type === 'number' && (
        <input
          className="num"
          type="number"
          value={value ?? ''}
          min={def.min}
          max={def.max}
          step={def.step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      {def.type === 'text' && <input className="num" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}
