// 角色库、生成历史、项目设置三个弹窗
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { confirmDialog } from './Dialog';
import { Select } from './Select';
import type { Asset, Character, Project } from '../../shared/types';
import { api, fileUrl } from '../api';
import { useApp } from '../context';
import { fileKind, fmtTime } from '../lib';

function Modal({ title, sub, onClose, children, wide }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
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

// —— 角色库 ——
export function CharacterLibrary({ onClose }: { onClose: () => void }) {
  const { project, characters, refreshCharacters, toast } = useApp();
  const [sel, setSelRaw] = useState<Partial<Character> | null>(characters[0] || null);
  const savedSnap = useRef(JSON.stringify(characters[0] || null));
  const fileRef = useRef<HTMLInputElement>(null);
  // 切换 / 关闭前，有没保存的改动就先问一声
  const pick = (c: Partial<Character> | null) => {
    setSelRaw(c);
    savedSnap.current = JSON.stringify(c);
  };
  const setSel = setSelRaw;
  const leave = async (then: () => void) => {
    if (sel && JSON.stringify(sel) !== savedSnap.current) {
      const ok = await confirmDialog({
        title: '放弃没保存的修改？',
        message: `角色「${sel.name || '新角色'}」改了还没保存。`,
        okText: '放弃修改',
        cancelText: '继续编辑',
        danger: true,
      });
      if (!ok) return;
    }
    then();
  };
  if (!project) return null;

  const save = async () => {
    if (!sel?.name?.trim()) return toast('先给角色起个名字', 'error');
    try {
      const c = await api.saveCharacter(project.id, sel);
      pick(c);
      refreshCharacters();
      toast('已保存。改了外形描述，之后的生成都会用新的');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Modal title="角色库" sub="角色的外形描述会自动拼进连到的每个生成节点；定妆图当参考图" onClose={() => leave(onClose)} wide>
      <div className="mm">
        <div className="mm-list">
          {characters.map((c) => (
            <button key={c.id} className={`mm-item ${sel?.id === c.id ? 'on' : ''}`} onClick={() => sel?.id !== c.id && leave(() => pick(c))}>
              {c.image ? <img className="char-thumb" src={fileUrl(c.image)} /> : <span className="char-thumb" />}
              <span className="mm-name">{c.name}</span>
            </button>
          ))}
          <div className="mm-add">
            <button onClick={() => leave(() => pick({ name: '', description: '' }))}>
              <Plus size={13} /> 新角色
            </button>
          </div>
        </div>
        {sel && (
          <div className="mm-form">
            <div className="char-edit">
              <div className="char-img" onClick={() => fileRef.current?.click()}>
                {sel.image ? <img src={fileUrl(sel.image)} /> : <div className="muted">点击上传定妆图</div>}
              </div>
              <div className="form-grid one">
                <label>名字</label>
                <input value={sel.name || ''} placeholder="比如：胡柏冰（少年）" onChange={(e) => setSel({ ...sel, name: e.target.value })} />
                <label>外形描述</label>
                <textarea
                  rows={8}
                  value={sel.description || ''}
                  placeholder="偏胖，圆脸，中分……越具体，人物越稳定"
                  onChange={(e) => setSel({ ...sel, description: e.target.value })}
                />
              </div>
            </div>
            <div className="mm-actions">
              {sel.id && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: `删除角色「${sel.name}」？`, okText: '删除', danger: true }))) return;
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
              <span className="muted">放到画布：在节点面板点「角色库」，或在添加菜单的「素材库」里选</span>
              <button className="primary" onClick={save}>
                保存
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const up = await api.upload(project.id, f);
                  setSel((s) => ({ ...(s || {}), image: up.file }));
                } catch (err: any) {
                  toast(err.message, 'error');
                }
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// —— 从生成历史选择 ——
export function HistoryPicker({ onPick, onClose }: { onPick: (file: string, kind: 'image' | 'video' | 'audio') => void; onClose: () => void }) {
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
              onPick(h.file, (fileKind(h.file) === 'other' ? 'image' : fileKind(h.file)) as any);
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
    <Modal title="项目设置" onClose={onClose}>
      <div className="mm-form">
        <div className="form-grid">
          <label>项目名</label>
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <label>画风</label>
          <textarea
            rows={4}
            value={p.style}
            placeholder="自动拼到每条图片 / 视频提示词前面，比如：写实电影质感，胶片颗粒感"
            onChange={(e) => setP({ ...p, style: e.target.value })}
          />
          <label>默认比例</label>
          <Select value={p.ratio} options={['9:16', '16:9', '1:1', '4:3', '3:4'].map((r) => ({ value: r, label: r }))} onChange={(r) => setP({ ...p, ratio: r })} />
        </div>
        <div className="mm-actions">
          <span className="spacer" />
          <button
            className="primary"
            onClick={async () => {
              try {
                onSaved(await api.updateProject(p.id, p));
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
