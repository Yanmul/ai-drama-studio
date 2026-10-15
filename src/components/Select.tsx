// 主题风格的下拉框，替代浏览器自带的 <select>。
// 菜单挂到 body 上、按按钮位置定位，放在表格、弹窗这些会裁切内容的地方也不会被挡住。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** 选项右侧的小字说明 */
  hint?: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  className = '',
  title,
  disabled,
}: {
  value: T | undefined | '';
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean }>();
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = Math.min(320, options.length * 34 + 12);
    const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;
    setPos({ left: r.left, top: up ? r.top - h - 4 : r.bottom + 4, width: r.width, up });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    // 页面滚动、窗口缩放时菜单跟着按钮走
    const follow = () => place();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [open]);

  // 键盘：上下选、回车确定、Esc 关
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btn.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let i = active;
      for (let n = 0; n < options.length; n++) {
        i = (i + step + options.length) % options.length;
        if (!options[i].disabled) break;
      }
      setActive(i);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (options[active]) pick(options[active]);
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select ${open ? 'open' : ''} ${className}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value ${cur ? '' : 'muted'}`}>{cur ? cur.label : placeholder}</span>
        <ChevronDown size={14} className="select-arrow" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            className={`select-menu ${pos.up ? 'up' : ''}`}
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <button
                key={String(o.value)}
                type="button"
                data-i={i}
                className={`select-opt ${o.value === value ? 'on' : ''} ${i === active ? 'active' : ''}`}
                disabled={o.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="select-check">{o.value === value && <Check size={13} />}</span>
                <span className="select-label">{o.label}</span>
                {o.hint && <span className="select-hint">{o.hint}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 可以打字、也可以从下拉列表里选的输入框（比如模型 ID：从拉取到的模型列表里选，也能手填）。
 * 打字时按包含关系筛选；onFocus 时可以去加载选项（options 为 null 表示还在加载 / 不支持）。
 */
export function ComboInput({
  value,
  options,
  onChange,
  onPick,
  onFocus,
  placeholder,
  loading,
}: {
  value: string;
  options: string[] | null;
  onChange: (v: string) => void;
  /** 从列表里选中（不是打字） */
  onPick?: (v: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false); // 打过字才按输入筛选；刚点进来时列出全部
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>();
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const q = typed ? value.trim().toLowerCase() : '';
  const shown = (options || []).filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 200);

  const place = () => {
    const r = input.current?.getBoundingClientRect();
    if (!r) return;
    const h = 300;
    const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;
    setPos({ left: r.left, top: up ? r.top - Math.min(h, shown.length * 32 + 12) - 4 : r.bottom + 4, width: Math.max(r.width, 260) });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open, shown.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !input.current?.contains(t)) setOpen(false);
    };
    const follow = () => place();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [open]);
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (v: string) => {
    onChange(v);
    onPick?.(v);
    setOpen(false);
    setTyped(false);
  };

  return (
    <>
      <span className="combo">
        <input
          ref={input}
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            onFocus?.();
            setTyped(false);
            setActive(0);
            setOpen(true);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setTyped(true);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!open || !shown.length) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
          }}
        />
        {(loading || options?.length) ? (
          <ChevronDown
            size={13}
            className="combo-arrow"
            onMouseDown={(e) => {
              e.preventDefault();
              input.current?.focus();
              setOpen(!open);
            }}
          />
        ) : null}
      </span>
      {open &&
        pos &&
        (loading || shown.length > 0) &&
        createPortal(
          <div ref={menu} className="select-menu" style={{ left: pos.left, top: pos.top, minWidth: pos.width }} onMouseDown={(e) => e.preventDefault()}>
            {loading && !shown.length && <div className="select-opt muted">正在获取模型列表…</div>}
            {shown.map((o, i) => (
              <button
                key={o}
                type="button"
                data-i={i}
                className={`select-opt ${o === value ? 'on' : ''} ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="select-check">{o === value && <Check size={13} />}</span>
                <span className="select-label mono">{o}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
