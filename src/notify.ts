// 生成完成 / 失败的系统通知：只在你没看着这个页面时弹（切到别的窗口、别的标签页），同时响一声。
// 第一次点生成时向浏览器要通知权限；你拒绝了就只响声音。

export function askNotifyPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
}

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g).connect(ctx.destination);
    o.frequency.value = ok ? 880 : 330;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.36);
    o.onended = () => ctx.close();
  } catch {
    /* 没声音就算了 */
  }
}

export function notify(title: string, body: string, ok = true) {
  if (!document.hidden) return; // 正看着页面：节点上直接能看到结果，不打扰
  beep(ok);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: `${title}-${body}`.slice(0, 60) });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
