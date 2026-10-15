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
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover popover-${placement} ${className}`}>
      {children}
    </div>
  );
}
