// 大图预览：一个节点的所有图片 / 视频版本，全屏看，← → 切换，Esc 关闭；能直接定稿、下载。
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, Star, X } from 'lucide-react';
import type { Version } from '../../shared/types';
import { fileUrl } from '../api';
import { fileKind } from '../lib';

export function Lightbox({
  title,
  versions,
  index,
  starred,
  onIndex,
  onStar,
  onClose,
  downloadName,
}: {
  title: string;
  /** 节点的全部版本（没有文件的会跳过） */
  versions: Version[];
  index: number;
  starred?: string;
  onIndex: (i: number) => void;
  onStar: (versionId: string | undefined) => void;
  onClose: () => void;
  downloadName: (i: number) => string;
}) {
  const withFile = versions.map((v, i) => ({ v, i })).filter(({ v }) => v.file);
  const pos = Math.max(0, withFile.findIndex((x) => x.i === index));
  const cur = withFile[pos];
  const step = (d: number) => {
    const next = withFile[(pos + d + withFile.length) % withFile.length];
    if (next) onIndex(next.i);
  };

  const stepRef = useRef(step);
  stepRef.current = step;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('.dialog-mask')) return; // 确认框开着：按键归它
      // Delete / 退格也拦下：不然会删掉后面画布上选中的节点
      if (!['Escape', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(e.key)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === 'Escape') closeRef.current();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepRef.current(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  if (!cur) return null;
  const { v } = cur;
  const isStar = starred === v.id;
  const kind = fileKind(v.file);

  return createPortal(
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lb-top">
        <span className="lb-title">
          {title} · v{cur.i + 1}
          {v.label ? ` · ${v.label}` : ''}
          <span className="muted">
            （{pos + 1} / {withFile.length}）
          </span>
        </span>
        <span className="spacer" />
        <button className={`lb-btn ${isStar ? 'starred' : ''}`} onClick={() => onStar(isStar ? undefined : v.id)} title={isStar ? '取消定稿' : '设为定稿：下游节点用这一版，自动清理也会保留'}>
          <Star size={16} fill={isStar ? 'currentColor' : 'none'} /> {isStar ? '已定稿' : '定稿'}
        </button>
        <a className="lb-btn" href={fileUrl(v.file)} download={downloadName(cur.i)} title="下载这一版">
          <Download size={16} /> 下载
        </a>
        <button className="lb-btn" onClick={onClose} title="关闭（Esc）">
          <X size={18} />
        </button>
      </div>
      <div className="lb-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {withFile.length > 1 && (
          <button className="lb-nav left" onClick={() => step(-1)} title="上一版（←）">
            <ChevronLeft size={26} />
          </button>
        )}
        {kind === 'image' && <img key={v.id} src={fileUrl(v.file)} />}
        {kind === 'video' && <video key={v.id} src={fileUrl(v.file)} controls autoPlay loop playsInline />}
        {kind === 'audio' && <audio key={v.id} src={fileUrl(v.file)} controls autoPlay />}
        {withFile.length > 1 && (
          <button className="lb-nav right" onClick={() => step(1)} title="下一版（→）">
            <ChevronRight size={26} />
          </button>
        )}
      </div>
      {withFile.length > 1 && (
        <div className="lb-strip">
          {withFile.map(({ v: x, i }) => (
            <button key={x.id} className={`lb-thumb ${i === cur.i ? 'on' : ''}`} onClick={() => onIndex(i)} title={`v${i + 1}`}>
              {fileKind(x.file) === 'image' && <img src={fileUrl(x.file)} />}
              {fileKind(x.file) === 'video' && <video src={fileUrl(x.file)} muted preload="metadata" />}
              {fileKind(x.file) === 'audio' && <span>♪</span>}
              {starred === x.id && <Star size={11} fill="currentColor" className="lb-star" />}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
