/** Shared PP shell. Geometry and the physical keys stay consistent across experiments. */
export function mountDeviceShell(host) {
  host.innerHTML = `
    <div class="device" id="device">
      <img class="device-shell" src="${new URL('../passport-front.png', import.meta.url).href}" alt="FoloToy AI Passport 透明外壳" draggable="false">
      <div class="screen" id="screen" role="region" aria-label="设备屏幕">
        <div class="screen-top"><span id="clock">14:27</span><div><span class="signal" id="signal" aria-label="网络在线">▂▄▆</span><span class="battery" aria-label="模拟电量 85%"><i></i></span></div></div>
        <div class="screen-identity"><strong>嘟嘟</strong><span id="mode-badge">引导</span></div>
        <div class="screen-content" id="screen-content"></div>
        <div class="screen-footer"><span id="screen-hint">按住 OK 说话</span><span id="page-number"></span></div>
      </div>
      <button class="hardware-key key-up" id="key-up" aria-label="上键"><i></i><span>上 <kbd>↑</kbd></span></button>
      <button class="hardware-key key-down" id="key-down" aria-label="下键"><i></i><span>下 <kbd>↓</kbd></span></button>
      <button class="hardware-key key-ok" id="key-ok" aria-label="OK 键，按住说话"><i></i><span>OK <kbd>空格</kbd></span></button>
    </div>`;
  return {
    screen: host.querySelector('#screen'),
    content: host.querySelector('#screen-content'),
    ok: host.querySelector('#key-ok'),
    up: host.querySelector('#key-up'),
    down: host.querySelector('#key-down'),
  };
}
