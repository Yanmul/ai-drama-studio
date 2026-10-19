// 角色库、生成历史、项目设置三个弹窗
import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Star, Trash2, X } from 'lucide-react';
import { confirmDialog } from './Dialog';
import { Select } from './Select';
import type { Asset, Character, Project, SettingImage, SettingKind } from '../../shared/types';
import { api, fileUrl } from '../api';
import { StyleEditor } from './StylePicker';
import { useApp } from '../context';
import { SETTING_WORD, fileKind, fmtTime, settingImages, settingKind } from '../lib';

export function Modal({ title, sub, onClose, children, wide, className = '' }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`}>
        <div className="modal-head">
          <b>{title}</b>
          {sub && <span className="muted">{sub}</span>}
          <span className="spacer" />
          <button className="icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// —— 设定库：角色 / 场景 / 道具，每个可以放多张图 ——
const KIND_TABS: { kind: SettingKind; label: string; descHint: string; nameHint: string }[] = [
  { kind: 'character', label: '角色', nameHint: '比如：胡柏冰（少年）', descHint: '外形：年龄、体型、脸型、发型、常穿的衣服……越具体，人物越稳定' },
  { kind: 'scene', label: '场景', nameHint: '比如：教室（午后）', descHint: '地点、时间、天气、光线、陈设、色调……' },
  { kind: 'prop', label: '道具', nameHint: '比如：黑板擦', descHint: '颜色、材质、大小、形状、细节……' },
];

export function CharacterLibrary({ onClose }: { onClose: () => void }) {
  const { project, characters, refreshCharacters, toast } = useApp();
  const [kind, setKind] = useState<SettingKind>('character');
  const list = characters.filter((c) => settingKind(c) === kind);
  const first = characters.find((c) => settingKind(c) === 'character') || null;
  const [sel, setSelRaw] = useState<Partial<Character> | null>(first);
  const savedSnap = useRef(JSON.stringify(first));
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tab = KIND_TABS.find((t) => t.kind === kind)!;
  // 切换 / 关闭前，有没保存的改动就先问一声
  const pick = (c: Partial<Character> | null) => {
    // 编辑时统一用 images（旧数据只有 image）
    const v = c ? { ...c, images: settingImages(c as Character) } : null;
    setSelRaw(v);
    savedSnap.current = JSON.stringify(v);
  };
  const setSel = setSelRaw;
  const leave = async (then: () => void) => {
    if (sel && JSON.stringify(sel) !== savedSnap.current) {
      const ok = await confirmDialog({
        title: '放弃没保存的修改？',
        message: `「${sel.name || '新设定'}」改了还没保存。`,
        okText: '放弃修改',
        cancelText: '继续编辑',
        danger: true,
      });
      if (!ok) return;
    }
    then();
  };
  useEffect(() => {
    pick(first);
  }, []);
  if (!project) return null;

  const images = sel?.images || [];
  const setImages = (next: SettingImage[]) => setSel((s) => (s ? { ...s, images: next } : s));

  const save = async () => {
    if (!sel?.name?.trim()) return toast(`先给${SETTING_WORD[settingKind(sel as Character)]}起个名字`, 'error');
    try {
      const c = await api.saveCharacter(project.id, { ...sel, image: sel.images?.[0]?.file });
      pick(c);
      refreshCharacters();
      toast('已保存。改了描述，之后的生成都会用新的');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const upload = async (files: File[]) => {
    const forId = sel?.id; // 记下是给哪个设定传的：上传途中切走了就不落到别的设定上
    setUploading(true);
    try {
      const ups: Awaited<ReturnType<typeof api.upload>>[] = [];
      for (const f of files) ups.push(await api.upload(project.id, f));
      setSel((s) => (s && s.id === forId ? { ...s, images: [...(s.images || []), ...ups.filter((u) => u.kind === 'image').map((u) => ({ file: u.file }))] } : s));
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal title="设定库" sub="角色、场景、道具：描述会自动拼进连到的生成节点，图当参考图；一个设定可以放多张图（多角度、表情、服装）" onClose={() => leave(onClose)} wide>
      <div className="mm setting-lib">
        <div className="mm-list">
          <div className="seg setting-tabs">
            {KIND_TABS.map((t) => (
              <button
                key={t.kind}
                className={kind === t.kind ? 'on' : ''}
                onClick={() =>
                  t.kind !== kind &&
                  leave(() => {
                    setKind(t.kind);
                    pick(characters.find((c) => settingKind(c) === t.kind) || null);
                  })
                }
              >
                {t.label} <span className="muted">{characters.filter((c) => settingKind(c) === t.kind).length}</span>
              </button>
            ))}
          </div>
          {list.map((c) => {
            const imgs = settingImages(c);
            return (
              <button key={c.id} className={`mm-item ${sel?.id === c.id ? 'on' : ''}`} onClick={() => sel?.id !== c.id && leave(() => pick(c))}>
                {imgs[0] ? <img className="char-thumb" src={fileUrl(imgs[0].file)} /> : <span className="char-thumb" />}
                <span className="mm-main">
                  <span className="mm-name">{c.name}</span>
                  <span className="mm-sub">{imgs.length ? `${imgs.length} 张图` : '还没有图，只带描述'}</span>
                </span>
              </button>
            );
          })}
          {list.length === 0 && <div className="muted pad">还没有{tab.label}</div>}
          <div className="mm-add">
            <button onClick={() => leave(() => pick({ kind, name: '', description: '', images: [] }))}>
              <Plus size={13} /> 新{tab.label}
            </button>
          </div>
        </div>
        {sel && (
          <div className="mm-form">
            <div className="form-grid one">
              <label>名字</label>
              <input value={sel.name || ''} placeholder={KIND_TABS.find((t) => t.kind === settingKind(sel as Character))!.nameHint} onChange={(e) => setSel({ ...sel, name: e.target.value })} />
              <label>描述（自动拼进提示词）</label>
              <textarea
                rows={4}
                value={sel.description || ''}
                placeholder={KIND_TABS.find((t) => t.kind === settingKind(sel as Character))!.descHint}
                onChange={(e) => setSel({ ...sel, description: e.target.value })}
              />
              <label>
                参考图 <span className="muted">第一张是主图；放到画布时可以选用哪一张，备注会一起带进提示词</span>
              </label>
              <div className="set-images">
                {images.map((img, i) => (
                  <div key={img.file + i} className={`set-img ${i === 0 ? 'main' : ''}`}>
                    <img src={fileUrl(img.file)} />
                    {i === 0 && <span className="set-main-tag">主图</span>}
                    <div className="set-img-tools">
                      {i > 0 && (
                        <button title="设为主图" onClick={() => setImages([img, ...images.filter((_, j) => j !== i)])}>
                          <Star size={13} />
                        </button>
                      )}
                      <button title="删掉这张" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <input
                      value={img.note || ''}
                      placeholder="备注：正面 / 侧面 / 校服…"
                      onChange={(e) => setImages(images.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                    />
                  </div>
                ))}
                <button className="set-img add" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 size={20} className="spin" /> : <Plus size={22} />}
                  <span>{uploading ? '上传中…' : '上传图片（可多选）'}</span>
                </button>
              </div>
            </div>
            <div className="mm-actions">
              {sel.id && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: `删除「${sel.name}」？`, message: '画布上已经放好的节点不受影响。', okText: '删除', danger: true }))) return;
                    try {
                      await api.deleteCharacter(project.id, sel.id!);
                    } catch (e: any) {
                      return toast(e.message, 'error');
                    }
                    pick(null);
                    refreshCharacters();
                  }}
                >
                  <Trash2 size={13} /> 删除
                </button>
              )}
              <span className="spacer" />
              <span className="muted">放到画布：生成面板点「设定库」，或右键添加菜单里的「设定库」</span>
              <button className="primary" onClick={save}>
                保存
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept="image/*"
              onChange={(e) => {
                const fs = [...(e.target.files || [])];
                e.target.value = '';
                if (fs.length) upload(fs);
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// —— 从生成历史选择 ——
export function HistoryPicker({ onPick, onClose }: { onPick: (file: string, kind: 'image' | 'video' | 'audio', createdAt?: string) => void; onClose: () => void }) {
  const { project, toast } = useApp();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.history>>>([]);
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  useEffect(() => {
    if (project) api.history(project.id).then(setItems).catch((e) => toast(`读取生成历史失败：${e.message}`, 'error'));
  }, [project?.id]);
  const shown = items.filter((i) => filter === 'all' || i.kind === filter);
  return (
    <Modal title="从生成历史选择" sub="点一下，放到画布上" onClose={onClose} wide>
      <div className="seg pad">
        {(['all', 'image', 'video', 'audio'] as const).map((k) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {{ all: '全部', image: '图片', video: '视频', audio: '音频' }[k]}
          </button>
        ))}
      </div>
      <div className="history-grid">
        {shown.length === 0 && <div className="muted pad">还没有生成过{filter === 'all' ? '' : '这类'}内容</div>}
        {shown.map((h) => (
          <button
            key={h.file}
            className="history-item"
            title={`${h.model}\n${h.prompt}`}
            onClick={() => {
              onPick(h.file, (fileKind(h.file) === 'other' ? 'image' : fileKind(h.file)) as any, h.createdAt);
              onClose();
            }}
          >
            {fileKind(h.file) === 'image' && <img src={fileUrl(h.file)} />}
            {fileKind(h.file) === 'video' && <video src={fileUrl(h.file)} muted />}
            {fileKind(h.file) === 'audio' && <div className="ref-audio">♪</div>}
            <span className="hi-prompt">{h.prompt || '（没有提示词）'}</span>
            <span className="hi-meta">
              {fmtTime(h.createdAt)} · {h.model.split(' · ').pop()}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// —— 项目设置 ——
export function ProjectSettings({ project, onSaved, onClose }: { project: Project; onSaved: (p: Project) => void; onClose: () => void }) {
  const { toast } = useApp();
  const [p, setP] = useState(project);
  return (
    <Modal title="项目设置" onClose={onClose} className="style-modal">
      <div className="mm-form">
        <div className="form-grid">
          <label>项目名</label>
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <label>画风</label>
          <StyleEditor style={p.style} styleId={p.styleId} onChange={(v) => setP({ ...p, style: v.style, styleId: v.styleId })} />
          <label>默认比例</label>
          <Select value={p.ratio} options={['9:16', '16:9', '1:1', '4:3', '3:4'].map((r) => ({ value: r, label: r }))} onChange={(r) => setP({ ...p, ratio: r })} />
        </div>
        <div className="mm-actions">
          <span className="spacer" />
          <button
            className="primary"
            onClick={async () => {
              try {
                onSaved(await api.updateProject(p.id, { ...p, style: p.style.trim(), styleId: p.style.trim() ? p.styleId : undefined }));
                onClose();
              } catch (e: any) {
                toast(e.message, 'error');
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}


// —— 资产库（所有画布共用） ——
export function AssetLibrary({ onPick, onClose }: { onPick: (a: Asset) => void; onClose: () => void }) {
  const { toast } = useApp();
  const [items, setItems] = useState<Asset[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'audio' | 'text'>('all');
  const load = () => api.assets().then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);
  const isText = (a: Asset) => a.kind === 'text' || a.kind === 'script';
  const shown = (items || []).filter((a) => filter === 'all' || (filter === 'text' ? isText(a) : a.kind === filter));
  return (
    <Modal title="资产库" sub="所有画布共用 · 点一下放到画布上" onClose={onClose} wide>
      <div className="seg pad">
        {(['all', 'image', 'video', 'audio', 'text'] as const).map((k) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {{ all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本' }[k]}
          </button>
        ))}
      </div>
      <div className="history-grid">
        {items && shown.length === 0 && (
          <div className="muted pad">资产库是空的。在画布上框选节点，点「保存到资产」就会出现在这里</div>
        )}
        {shown.map((a) => (
          <div key={a.id} className="asset-item">
            <button
              className="history-item"
              title={a.name}
              onClick={() => {
                onPick(a);
                onClose();
              }}
            >
              {a.file && a.kind === 'image' && <img src={fileUrl(a.file)} />}
              {a.file && a.kind === 'video' && <video src={fileUrl(a.file)} muted preload="metadata" />}
              {a.file && a.kind === 'audio' && <div className="ref-audio">♪</div>}
              {!a.file && <div className="asset-text">{a.text}</div>}
              <span>{a.name}</span>
            </button>
            <button
              className="asset-del"
              title="从资产库删除"
              onClick={async () => {
                const ok = await confirmDialog({ title: `从资产库删除「${a.name}」？`, message: '画布上已经用到的不受影响。', okText: '删除', danger: true });
                if (!ok) return;
                try {
                  await api.deleteAsset(a.id);
                  load();
                } catch (e: any) {
                  toast(e.message, 'error');
                }
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// —— 新建项目：起名、选比例和画风 ——
export function NewProjectDialog({ defaultName, onCreate, onClose }: { defaultName: string; onCreate: (name: string, extra: { style?: string; styleId?: string; ratio: string }) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(defaultName);
  const [ratio, setRatio] = useState('16:9');
  const [style, setStyle] = useState<{ style: string; styleId?: string }>({ style: '' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim() || defaultName, { style: style.style.trim() || undefined, styleId: style.style.trim() ? style.styleId : undefined, ratio });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="新建项目" sub="画风以后也能在顶栏「设置」或生成面板里换" onClose={onClose} className="style-modal">
      <div className="mm-form">
        <div className="form-grid">
          <label>项目名</label>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
          <label>默认比例</label>
          <Select value={ratio} options={['9:16', '16:9', '1:1', '4:3', '3:4'].map((r) => ({ value: r, label: r }))} onChange={setRatio} />
          <label>画风</label>
          <StyleEditor style={style.style} styleId={style.styleId} onChange={setStyle} />
        </div>
        <div className="mm-actions">
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={go} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
