import { useEffect, useRef, type ReactNode } from 'react';

/** 点按钮弹出、点外面收起的小浮层 */
export function Popover({
  open,
  onClose,
  children,
  placement = 'top',
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose 放 ref 里：父组件每次重渲染都传新函数，不能因此反复注册监听
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Element;
      // 点在下拉框菜单（挂在 body 上）里不算点外面
      if (ref.current && !ref.current.contains(t) && !t.closest?.('.select-menu')) closeRef.current();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    const timer = setTimeout(() => document.addEventListener('mousedown', h), 0);
    document.addEventListener('keydown', k);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover popover-${placement} ${className}`}>
      {children}
    </div>
  );
}
