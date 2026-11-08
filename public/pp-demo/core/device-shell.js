/** Shared PP shell. Geometry and the physical keys stay consistent across experiments. */
export function mountDeviceShell(host) {
  host.innerHTML = `
    <div class="device" id="device">
      <img class="device-shell" src="${new URL('../passport-front.png', import.meta.url).href}" alt="FoloToy AI Passport 透明外壳" draggable="false">
      <div class="screen" id="screen" role="region" aria-label="设备屏幕">
        <div class="screen-top">
          <div class="clock-group"><span id="clock">--:--</span><span class="pa-link" id="pa-link" role="img" aria-label="Wi-Fi 已连接，PA 不可达" hidden>!</span></div>
          <div class="volume-status"><span class="speaker" id="speaker" role="img" data-level="2" aria-label="音量 65%">
            <svg viewBox="0 0 22 20" aria-hidden="true"><path d="M3 7h4l5-4v14l-5-4H3z"/><path class="speaker-wave speaker-near" d="M15 7a5 5 0 0 1 0 6"/><path class="speaker-wave speaker-far" d="M18 4a9 9 0 0 1 0 12"/><path class="speaker-mute" d="m16 8 4 4m0-4-4 4"/></svg>
          </span></div>
          <div class="wifi-status"><span class="signal" id="signal" role="img" data-level="3" data-connected="true" aria-label="Wi-Fi 信号强">
            <svg viewBox="0 0 20 16" aria-hidden="true"><path class="wifi-outer" d="M2 5Q10 -2 18 5"/><path class="wifi-middle" d="M5 8Q10 3.5 15 8"/><path class="wifi-inner" d="M8 11Q10 9 12 11"/><circle cx="10" cy="14" r="1"/><path class="wifi-slash" d="M3 1L17 15"/></svg>
          </span></div>
          <div class="battery-status" id="battery" role="img" aria-label="电量 85%"><span class="battery"><i id="battery-fill"></i><span id="battery-percent">85</span></span></div>
        </div>
        <div class="screen-content" id="screen-content"></div>
        <div class="screen-footer"><span id="screen-hint">按住 OK 说话</span><div class="footer-status"><span id="page-number"></span>
          <div class="mode-status" id="mode-badge" data-mode="steer" role="img" aria-label="当前直接引导，双击 OK 切换">
            <span class="mode-symbol mode-steer" title="直接引导：补充当前执行"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v6a4 4 0 0 0 4 4h12M15 10l5 5-5 5"/></svg></span>
            <span class="mode-symbol mode-queue" title="排队：等待当前执行结束"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v3l-5 6 5 6v3H6v-3l5-6-5-6z"/><path class="mode-solid" d="m9 5 3 4 3-4zm0 14h6l-3-4z"/></svg></span>
          </div>
        </div></div>
        <div class="volume-toast" id="volume-toast" role="status" aria-label="音量调整" hidden><span>音量</span><div class="volume-toast-track"><i id="volume-toast-fill"></i></div><span id="volume-toast-value">65</span></div>
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
