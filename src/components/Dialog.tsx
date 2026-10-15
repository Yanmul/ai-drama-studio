// 主题风格的确认框 / 输入框，替代浏览器自带的 confirm() / prompt()。
// 用法：if (!(await confirmDialog({ title: '删除？' }))) return;
//       const name = await promptDialog({ title: '改名', defaultValue: old });
// 需要在 App 里放一个 <DialogHost />。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  okText?: string;
  cancelText?: string;
  /** 删除这类不可撤销的操作：确定按钮标红 */
  danger?: boolean;
}

interface PromptOpts {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
}

type Req =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOpts)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOpts);

let show: ((r: Req) => void) | null = null;

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => (show ? show({ kind: 'confirm', resolve, ...opts }) : resolve(false)));
}

/** 取消返回 null；确定返回去掉首尾空格后的文字 */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => (show ? show({ kind: 'prompt', resolve, ...opts }) : resolve(null)));
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (r) => {
      setText(r.kind === 'prompt' ? r.defaultValue || '' : '');
      setReq(r);
    };
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    requestAnimationFrame(() => {
      if (req.kind === 'prompt') input.current?.select();
      else okBtn.current?.focus();
    });
  }, [req]);

  if (!req) return null;

  const close = (ok: boolean) => {
    if (req.kind === 'confirm') req.resolve(ok);
    else req.resolve(ok ? text.trim() : null);
    setReq(null);
  };
  const danger = req.kind === 'confirm' && req.danger;

  return (
    <div
      className="modal-mask dialog-mask"
      onMouseDown={(e) => e.target === e.currentTarget && close(false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close(false);
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog-title">
          {danger && <AlertTriangle size={17} className="dialog-warn" />}
          {req.title}
        </div>
        {req.message && <div className="dialog-msg">{req.message}</div>}
        {req.kind === 'prompt' && (
          <input
            ref={input}
            className="dialog-input"
            value={text}
            placeholder={req.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && close(true)}
          />
        )}
        <div className="dialog-actions">
          <button className="ghost" onClick={() => close(false)}>
            {(req.kind === 'confirm' && req.cancelText) || '取消'}
          </button>
          <button
            ref={okBtn}
            className={danger ? 'danger solid' : 'primary'}
            disabled={req.kind === 'prompt' && !text.trim()}
            onClick={() => close(true)}
          >
            {req.okText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
