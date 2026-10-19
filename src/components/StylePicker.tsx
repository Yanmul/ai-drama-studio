// 风格库选择：项目设置、新建项目里用的卡片网格。选中 = 把这个风格的描述填进项目画风。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, BookmarkPlus, Check, Pencil, Plus, X } from 'lucide-react';
import type { Project, StylePreset } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../context';
import { confirmDialog, promptDialog } from './Dialog';

/** 当前画风的显示名：没有 → 无画风；跟风格库某项一致 → 那一项的名字；改过 → 自定义 */
export function styleName(p: Pick<Project, 'style' | 'styleId'> | undefined, styles: StylePreset[]): string {
  if (!p?.style?.trim()) return '无画风';
  return styles.find((s) => s.id === p.styleId && s.prompt === p.style)?.name || '自定义画风';
}

export function StylePicker({
  style,
  styleId,
  onChange,
}: {
  style: string;
  styleId?: string;
  onChange: (v: { style: string; styleId?: string }) => void;
}) {
  const { styles, refreshStyles, toast } = useApp();
  const none = !style.trim();
  // 新建 / 编辑自己的风格：null = 不显示，{} = 新建，带 preset = 编辑
  const [form, setForm] = useState<{ preset?: StylePreset } | null>(null);

  const remove = async (s: StylePreset) => {
    const ok = await confirmDialog({ title: `删除风格「${s.name}」？`, message: '已经用了这个风格的项目不受影响（描述已经存在项目里）。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteStyle(s.id);
      refreshStyles();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="style-grid">
      <button className={`style-card none ${none ? 'on' : ''}`} onClick={() => onChange({ style: '', styleId: undefined })}>
        <span className="style-name">
          <Ban size={13} /> 无画风
        </span>
        <span className="style-desc">提示词里写什么就是什么</span>
      </button>
      {styles.map((s) => {
        const on = !none && s.id === styleId && s.prompt === style;
        return (
          <div key={s.id} className={`style-card ${on ? 'on' : ''}`} role="button" tabIndex={0} title={s.prompt} onClick={() => onChange({ style: s.prompt, styleId: s.id })}>
            <span className="style-name">
              {s.name}
              {!s.builtin && <span className="style-mine">我的</span>}
              {on && <Check size={13} className="style-check" />}
            </span>
            <span className="style-desc">{s.prompt}</span>
            {!s.builtin && (
              <span className="style-ops">
                <button
                  title="编辑这个风格"
                  onClick={(e) => {
                    e.stopPropagation();
                    setForm({ preset: s });
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="del"
                  title="删除这个风格"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s);
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
        );
      })}
      <button className="style-card add" onClick={() => setForm({})} title="自己写一个风格：起个名字 + 一段风格提示词">
        <span className="style-name">
          <Plus size={14} /> 新建风格
        </span>
        <span className="style-desc">写一段风格提示词，所有项目都能用</span>
      </button>
      {form && (
        <StyleForm
          preset={form.preset}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            refreshStyles();
            // 新建的直接选上；编辑的是当前选中的那个，选中的描述跟着更新
            if (!form.preset || form.preset.id === styleId) onChange({ style: saved.prompt, styleId: saved.id });
          }}
        />
      )}
    </div>
  );
}

/** 新建 / 编辑自己的风格：名字 + 风格提示词 */
function StyleForm({ preset, onClose, onSaved }: { preset?: StylePreset; onClose: () => void; onSaved: (s: StylePreset) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(preset?.name || '');
  const [prompt, setPrompt] = useState(preset?.prompt || '');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);
  // Esc 关闭：挂在整个页面上（点保存时按钮会短暂禁用、焦点会丢，挂在弹窗上就收不到了）
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelectorAll('.dialog-mask').length > 1) return; // 上面还有确认框：归它
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const ok = name.trim() && prompt.trim();
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      onSaved(preset ? await api.updateStyle(preset.id, { name, prompt }) : await api.addStyle(name, prompt));
      toast(preset ? '风格已更新' : `已存进风格库：${name.trim()}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="modal-mask dialog-mask"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="dialog style-form" role="dialog" aria-modal="true">
        <div className="dialog-title">{preset ? '编辑风格' : '新建风格'}</div>
        <label className="style-form-label">名字</label>
        <input ref={nameRef} className="dialog-input" value={name} maxLength={20} placeholder="比如：校园青春暖色" onChange={(e) => setName(e.target.value)} />
        <label className="style-form-label">
          风格提示词 <span className="muted">会自动加到每条图片 / 视频提示词前面</span>
        </label>
        <textarea
          className="dialog-input"
          rows={5}
          value={prompt}
          placeholder="比如：日系校园动画风格，暖黄色夕阳光，柔和的赛璐璐上色，干净线条，画面中不出现文字"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && save()}
        />
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={save} disabled={!ok || busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 选风格 + 下面可以直接改描述 + 存成自己的风格 */
export function StyleEditor({
  style,
  styleId,
  onChange,
}: {
  style: string;
  styleId?: string;
  onChange: (v: { style: string; styleId?: string }) => void;
}) {
  const { styles, refreshStyles, toast } = useApp();
  const matched = styles.find((s) => s.prompt === style.trim());

  const saveAsMine = async () => {
    const name = await promptDialog({ title: '存成我的风格', message: '以后新建项目、换画风时都能直接选', placeholder: '起个名字，比如：校园青春暖色' });
    if (!name) return;
    try {
      const s = await api.addStyle(name, style);
      refreshStyles();
      onChange({ style: s.prompt, styleId: s.id });
      toast(`已存进风格库：${s.name}`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="style-editor">
      <StylePicker style={style} styleId={styleId} onChange={onChange} />
      <div className="style-text-head">
        <span>画风描述</span>
        <span className="muted">会自动加到每条图片 / 视频提示词前面，可以直接改</span>
        <span className="spacer" />
        {style.trim() && !matched && (
          <button className="link" onClick={saveAsMine}>
            <BookmarkPlus size={13} /> 存成我的风格
          </button>
        )}
      </div>
      <textarea
        rows={3}
        value={style}
        placeholder="选上面的风格，或自己写，比如：写实电影质感，胶片颗粒感，画面中不出现文字"
        onChange={(e) => {
          const v = e.target.value;
          const same = styles.find((s) => s.prompt === v.trim());
          onChange({ style: v, styleId: same?.id });
        }}
      />
    </div>
  );
}
