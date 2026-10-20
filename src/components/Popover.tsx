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
      // 点在下拉框菜单（挂在 body 上）里不算点外面；
      // 点在包着它的那个小容器里（就是打开它的那个按钮）也不算——让按钮自己切换开关，
      // 不然会「按下先关、松开又被按钮重新打开」，再点一次关不掉
      const wrap = ref.current?.parentElement;
      if (ref.current && !ref.current.contains(t) && !wrap?.contains(t) && !t.closest?.('.select-menu')) closeRef.current();
    };
    // Esc 在捕获阶段听：生成面板会拦住按键往外传，冒泡阶段收不到
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 上面还盖着别的确认框（不是包着这个下拉框的那个）：这次 Esc 归确认框
      if ([...document.querySelectorAll('.dialog-mask')].some((m) => !m.contains(ref.current))) return;
      e.stopPropagation();
      closeRef.current();
    };
    // 捕获阶段：画布（React Flow）按下鼠标会拦住事件往外传，冒泡阶段收不到
    const timer = setTimeout(() => document.addEventListener('mousedown', h, true), 0);
    window.addEventListener('keydown', k, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', h, true);
      window.removeEventListener('keydown', k, true);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover popover-${placement} ${className}`}>
      {children}
    </div>
  );
}
