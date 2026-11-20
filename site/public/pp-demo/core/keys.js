import { PP_PROFILE } from './profile.js';

/** The three keys share one ADC. A gesture owns it until release or cancellation. */
export function bindHardwareKeys({ ok, up, down, press, release, abort, move, home, canJumpLatest, latest }) {
  const subscriptions = [];
  const on = (target, event, handler) => {
    target.addEventListener(event, handler);
    subscriptions.push(() => target.removeEventListener(event, handler));
  };
  const buttons = [ok, up, down];
  let active = null;

  function begin(key, source, allowHold = true) {
    const gesture = { key, source, consumed: false, timer: null };
    active = gesture;
    if (key === ok) press();
    else if (allowHold && (key === up || canJumpLatest())) {
      gesture.timer = setTimeout(() => {
        if (active !== gesture) return;
        gesture.consumed = true;
        if (key === up) home();
        else if (canJumpLatest()) latest();
      }, PP_PROFILE.interaction.arrowHoldMs);
    }
  }

  function finish(cancelReason) {
    if (!active) return;
    const { key, source, consumed, timer } = active;
    active = null;
    clearTimeout(timer);
    if (typeof source === 'number' && key.hasPointerCapture(source)) key.releasePointerCapture(source);
    if (cancelReason) {
      if (key === ok) abort(cancelReason);
    } else if (key === ok) release();
    else if (!consumed) move(key === up ? -1 : 1);
  }

  for (const key of buttons) {
    const ownsPointer = e => active?.key === key && active.source === e.pointerId;
    on(key, 'pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (active) return;
      key.setPointerCapture(e.pointerId);
      begin(key, e.pointerId);
    });
    on(key, 'pointerup', e => {
      if (!ownsPointer(e)) return;
      e.preventDefault();
      finish();
    });
    const cancelPointer = e => {
      if (ownsPointer(e)) finish('指针操作中断，本次未提交录音已丢弃');
    };
    on(key, 'pointercancel', cancelPointer);
    on(key, 'lostpointercapture', cancelPointer);
    on(key, 'contextmenu', e => e.preventDefault());
    // Assistive activation has no pointer or key events; deliver one short press.
    on(key, 'click', e => {
      if (e.detail === 0 && !active) {
        begin(key, null, false);
        finish();
      }
    });
  }

  on(document, 'keydown', e => {
    if (e.target.isContentEditable || e.target.closest?.('input,select,textarea')) return;
    let key, allowHold = true;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') key = e.code === 'ArrowUp' ? up : down;
    else if (e.code === 'Space' || e.code === 'Enter') {
      key = e.target.closest?.('button,a,summary') || ok;
      if (!buttons.includes(key)) return;
      allowHold = key === ok; // Native activation on a focused arrow is a single step.
    } else return;
    e.preventDefault();
    if (!e.repeat && !active) begin(key, e.code, allowHold);
  });
  on(document, 'keyup', e => {
    if (active?.source !== e.code) return;
    e.preventDefault();
    finish();
  });

  on(window, 'blur', () => finish('窗口失去焦点，本次未提交录音已丢弃'));
  on(document, 'visibilitychange', () => { if (document.hidden) finish('页面隐藏，本次未提交录音已丢弃'); });
  return () => {
    subscriptions.forEach(dispose => dispose());
    finish('演示输入已关闭');
  };
}
