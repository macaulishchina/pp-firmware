/** Mouse + PC keyboard adapter. Returns one cleanup function; no model or scenario imports. */
export function bindHardwareKeys({ ok, up, down, press, release, abort, move }) {
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
  on(up, 'click', () => move(-1));
  on(down, 'click', () => move(1));
  on(document, 'keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.code === 'Space' || e.code === 'Enter') && e.target.closest('button,a,summary') && !ok.contains(e.target)) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat && active === null) { active = e.code; press(); }
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); move(e.code === 'ArrowUp' ? -1 : 1); }
  });
  on(document, 'keyup', e => {
    if ((e.code === 'Space' || e.code === 'Enter') && active === e.code) { e.preventDefault(); end(); }
  });
  on(window, 'blur', () => cancel('窗口失去焦点，本次未提交录音已丢弃'));
  on(document, 'visibilitychange', () => { if (document.hidden) cancel('页面隐藏，本次未提交录音已丢弃'); });
  return () => { subscriptions.forEach(dispose => dispose()); cancel('演示输入已关闭'); };
}
