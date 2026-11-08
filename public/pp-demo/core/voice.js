// Idle and recording share one mark; a real terminal supplies a smoothed PCM level in [0, 1].
export function voiceMarkup() {
  const image = new URL('../cat-companion-v2.png', import.meta.url).href;
  const blink = new URL('../cat-companion-blink.png', import.meta.url).href;
  return `<div class="presence" aria-hidden="true"><span class="presence-halo"></span><div class="presence-mark"><img class="presence-avatar" src="${image}" alt="" draggable="false"><img class="presence-avatar presence-blink" src="${blink}" alt="" draggable="false"></div></div>`;
}

export function updateVoice(root, level) {
  const amount = Math.max(0, Math.min(1, level));
  const mark = root.querySelector('.presence-mark');
  if (mark) mark.style.transform = `scale(${1 + amount * .09})`;
  const halo = root.querySelector('.presence-halo');
  if (halo) halo.style.opacity = String(amount * .35);
}

// Synthetic speech/silence envelope only. This demo never opens a microphone.
export function demoVoiceLevel(seconds) {
  const phrase = seconds % 5.6;
  if (phrase > 4.4) return .035;
  return .24 + .6 * (.5 + .5 * Math.sin(seconds * 3.1)) ** .8;
}
