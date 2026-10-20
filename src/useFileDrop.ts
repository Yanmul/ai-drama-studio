// 拖文件进来上传：给任意一块区域加上「拖进来就上传」，拖到上面时高亮。
// 会拦住事件往外传——比如拖到节点上就只给这个节点，不会再被画布当成「新建节点」。
import { useRef, useState, type DragEvent } from 'react';

export function useFileDrop(
  onFiles: (files: File[]) => void,
  opts: { accept?: (f: File) => boolean; onReject?: (files: File[]) => void; disabled?: boolean } = {},
) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => !opts.disabled && [...e.dataTransfer.types].includes('Files');
  return {
    over,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        const all = [...e.dataTransfer.files];
        const ok = opts.accept ? all.filter(opts.accept) : all;
        if (ok.length) onFiles(ok);
        if (ok.length < all.length) opts.onReject?.(all.filter((f) => !ok.includes(f)));
      },
    },
  };
}

/** 按扩展名 / 类型判断文件是图片、视频还是音频 */
export function dropKind(f: File): 'image' | 'video' | 'audio' | 'other' {
  if (f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) return 'image';
  if (f.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.name)) return 'video';
  if (f.type.startsWith('audio/') || /\.(mp3|wav|m4a)$/i.test(f.name)) return 'audio';
  return 'other';
}
