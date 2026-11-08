/** Mouse + PC keyboard adapter. Returns one cleanup function; no model or scenario imports. */
export function bindHardwareKeys({ ok, up, down, press, release, abort, move, home }) {
  const subscriptions = [];
  const on = (target, event, handler) => {
    target.addEventListener(event, handler);
    subscriptions.push(() => target.removeEventListener(event, handler));
  };
  let active = null;
  const end = () => { if (active === null) return; active = null; release(); };
  const cancel = reason => { if (active === null) return; active = null; abort(reason); };
  on(ok, 'pointerdown', e => {
    if (e.button !== 0 || active !== null) return;
    e.preventDefault(); ok.setPointerCapture(e.pointerId); active = 'pointer'; press();
  });
  on(ok, 'pointerup', e => { e.preventDefault(); if (active === 'pointer') end(); });
  on(ok, 'pointercancel', () => cancel('指针操作中断，本次未提交录音已丢弃'));
  on(ok, 'contextmenu', e => e.preventDefault());
  on(ok, 'click', e => { if (e.detail === 0 && active === null) { press(); release(); } });
  let arrow = null, arrowTimer = null;
  const beginArrow = (direction, source) => {
    if (arrow) return;
    arrow = { direction, source, consumed: false };
    if (direction < 0) arrowTimer = setTimeout(() => {
      if (!arrow) return;
      arrow.consumed = true; home?.();
    }, 650);
  };
  const endArrow = source => {
    if (!arrow || arrow.source !== source) return;
    clearTimeout(arrowTimer);
    const current = arrow; arrow = null;
    if (!current.consumed) move(current.direction);
  };
  const cancelArrow = () => { clearTimeout(arrowTimer); arrow = null; };
  for (const [key, direction] of [[up, -1], [down, 1]]) {
    on(key, 'pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); key.setPointerCapture(e.pointerId); beginArrow(direction, key);
    });
    on(key, 'pointerup', e => { e.preventDefault(); endArrow(key); });
    on(key, 'pointercancel', cancelArrow);
    on(key, 'contextmenu', e => e.preventDefault());
    on(key, 'click', e => { if (e.detail === 0 && !arrow) move(direction); });
  }
  on(document, 'keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.code === 'Space' || e.code === 'Enter') && e.target.closest('button,a,summary') && !ok.contains(e.target)) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat && active === null) { active = e.code; press(); }
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); if (!e.repeat) beginArrow(e.code === 'ArrowUp' ? -1 : 1, e.code); }
  });
  on(document, 'keyup', e => {
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); endArrow(e.code); }
    if ((e.code === 'Space' || e.code === 'Enter') && active === e.code) { e.preventDefault(); end(); }
  });
  on(window, 'blur', () => { cancelArrow(); cancel('窗口失去焦点，本次未提交录音已丢弃'); });
  on(document, 'visibilitychange', () => { if (document.hidden) { cancelArrow(); cancel('页面隐藏，本次未提交录音已丢弃'); } });
  return () => { subscriptions.forEach(dispose => dispose()); cancelArrow(); cancel('演示输入已关闭'); };
}
