// 从设定库挑一个设定（以及用它的哪一张图）：生成面板的「设定库」、添加菜单的「设定库」共用
import type { Character, SettingImage, SettingKind } from '../../shared/types';
import { fileUrl } from '../api';
import { SETTING_WORD, settingImages, settingKind } from '../lib';

const ORDER: SettingKind[] = ['character', 'scene', 'prop'];

export function SettingPicker({
  settings,
  onPick,
  onManage,
  rowClass = 'list-item',
}: {
  settings: Character[];
  /** img 不给 = 用主图 */
  onPick: (c: Character, img?: SettingImage) => void;
  onManage: () => void;
  rowClass?: string;
}) {
  return (
    <div className="setting-picker">
      {settings.length === 0 && <div className="muted pad">设定库还是空的：先去加角色、场景、道具</div>}
      {ORDER.map((k) => {
        const list = settings.filter((c) => settingKind(c) === k);
        if (!list.length) return null;
        return (
          <div key={k} className="sp-group">
            <div className="sp-title">{SETTING_WORD[k]}</div>
            {list.map((c) => {
              const imgs = settingImages(c);
              return (
                <div key={c.id} className="sp-item">
                  <button className={rowClass} onClick={() => onPick(c)} title={imgs.length > 1 ? '点名字用主图，点下面的小图用那一张' : undefined}>
                    {imgs[0] ? <img src={fileUrl(imgs[0].file)} /> : <span className="thumb-empty" />}
                    <span>{c.name}</span>
                    {!imgs.length && <span className="muted">只带描述</span>}
                  </button>
                  {imgs.length > 1 && (
                    <div className="sp-variants">
                      {imgs.map((img, i) => (
                        <button key={img.file + i} className="sp-variant" title={img.note || `第 ${i + 1} 张`} onClick={() => onPick(c, img)}>
                          <img src={fileUrl(img.file)} />
                          {img.note && <span>{img.note}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <button className={`${rowClass} muted`} onClick={onManage}>
        管理设定库…
      </button>
    </div>
  );
}
