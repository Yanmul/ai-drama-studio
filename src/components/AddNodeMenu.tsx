// 「添加节点」菜单（参考 LibTV 截图一）：双击 / 右键画布空白处，或从节点拖线到空白处时弹出。
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, FileText, Image as ImageIcon, Music, Search, ScrollText, Shapes, Upload, Video, Film } from 'lucide-react';
import type { NodeKind } from '../../shared/types';
import { fileUrl } from '../api';
import { useApp } from '../context';
import { SETTING_WORD, settingImages, settingKind } from '../lib';
import { SettingPicker } from './SettingPicker';

export interface AddMenuAction {
  kind?: NodeKind;
  title?: string;
  text?: string;
  characterId?: string;
  characterImage?: string;
  /** 设定的哪一张图（备注） */
  variant?: string;
  upload?: boolean;
  history?: boolean;
}

const SCRIPT_TEMPLATE = '镜头1：\n\n镜头2：\n\n镜头3：';

/** onClose 带上关菜单的那次鼠标按键（点外面关的）；按 Esc 关的没有 */
export function AddNodeMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (a: AddMenuAction) => void; onClose: (by?: MouseEvent) => void }) {
  const { characters, openCharacters } = useApp();
  const [q, setQ] = useState('');
  const [sub, setSub] = useState<'' | 'script' | 'library'>('');
  const ref = useRef<HTMLDivElement>(null);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && closeRef.current(e);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    // 用捕获阶段监听：画布（React Flow）按下鼠标时会拦住事件往外传，冒泡阶段收不到，点画布就关不掉菜单
    const timer = setTimeout(() => document.addEventListener('mousedown', h, true), 0);
    document.addEventListener('keydown', k);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', h, true);
      document.removeEventListener('keydown', k);
    };
  }, []);

  const items: { key: string; icon: any; label: string; tag?: string; act?: AddMenuAction; sub?: 'script' | 'library' }[] = [
    { key: 'text', icon: FileText, label: '文本', act: { kind: 'text' } },
    { key: 'image', icon: ImageIcon, label: '图片', act: { kind: 'image' } },
    { key: 'video', icon: Video, label: '视频', act: { kind: 'video' } },
    { key: 'audio', icon: Music, label: '音频', act: { kind: 'audio' } },
    { key: 'cut', icon: Film, label: '成片', act: { kind: 'cut', title: '成片' } },
    { key: 'script', icon: ScrollText, label: '脚本', sub: 'script' },
    { key: 'library', icon: Shapes, label: '设定库', sub: 'library' },
  ];
  const shown = items.filter((i) => !q || i.label.includes(q));

  // 菜单别跑出屏幕
  const left = Math.min(x, window.innerWidth - 280);
  const top = Math.min(y, window.innerHeight - 560);

  return (
    <div ref={ref} className="add-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="am-head">
        <span>添加节点</span>
        <Search size={15} />
      </div>
      <input className="am-search" autoFocus placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
      {shown.map((i) => (
        <div key={i.key} className="am-row-wrap" onMouseEnter={() => setSub(i.sub || '')}>
          <button
            className="am-row"
            onClick={() => {
              if (i.act) onPick(i.act);
              else if (i.sub) setSub(i.sub);
            }}
          >
            <i.icon size={18} />
            <span>{i.label}</span>
            {i.tag && <span className={`am-tag ${i.tag === 'NEW' ? 'new' : ''}`}>{i.tag}</span>}
            {i.sub && <ChevronRight size={15} className="am-arrow" />}
          </button>
          {sub === i.sub && i.sub === 'script' && (
            <div className="am-sub">
              <button className="am-row" onClick={() => onPick({ kind: 'script', title: '脚本', text: SCRIPT_TEMPLATE })}>
                空白脚本
              </button>
              <button
                className="am-row"
                onClick={async () => {
                  const text = await navigator.clipboard?.readText?.().catch(() => '');
                  onPick({ kind: 'script', title: '脚本', text: text || SCRIPT_TEMPLATE });
                }}
              >
                从剪贴板粘贴剧本
              </button>
            </div>
          )}
          {sub === i.sub && i.sub === 'library' && (
            <div className="am-sub">
              <SettingPicker
                settings={characters}
                rowClass="am-row"
                onManage={() => (onClose(), openCharacters())}
                onPick={(c, img) => {
                  const pickImg = img || settingImages(c)[0];
                  onPick({
                    kind: 'image',
                    title: `${c.name}${pickImg?.note ? ` · ${pickImg.note}` : ''}（${SETTING_WORD[settingKind(c)]}）`,
                    characterId: c.id,
                    characterImage: pickImg?.file,
                    variant: pickImg?.note || undefined,
                  });
                }}
              />
            </div>
          )}
        </div>
      ))}
      <div className="am-group">添加资源</div>
      <button className="am-row" onClick={() => onPick({ upload: true })}>
        <Upload size={18} />
        <span>上传</span>
      </button>
      <button className="am-row" onClick={() => onPick({ history: true })}>
        <Clock size={18} />
        <span>从生成历史选择</span>
      </button>
    </div>
  );
}
