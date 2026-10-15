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
