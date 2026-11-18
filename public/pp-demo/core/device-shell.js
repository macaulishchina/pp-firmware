/** Shared PP shell. Screen content uses the firmware's native 240×320 coordinate space. */
export function mountDeviceShell(host) {
  host.innerHTML = `
    <div class="device" id="device">
      <img class="device-shell" src="${new URL('../passport-front.png', import.meta.url).href}" alt="FoloToy AI Passport 透明外壳" draggable="false">
      <div class="screen" id="screen" role="region" aria-label="设备屏幕">
        <canvas id="display" width="240" height="320" aria-hidden="true"></canvas>
        <div class="sr-only" id="screen-content"></div>
      </div>
      <button class="hardware-key key-up" id="key-up" aria-label="上键"><i></i><span>上 <kbd>↑</kbd></span></button>
      <button class="hardware-key key-down" id="key-down" aria-label="下键"><i></i><span>下 <kbd>↓</kbd></span></button>
      <button class="hardware-key key-ok" id="key-ok" aria-label="OK 键，按住说话"><i></i><span>OK <kbd>空格</kbd></span></button>
    </div>`;
  return {
    screen: host.querySelector('#screen'),
    canvas: host.querySelector('#display'),
    content: host.querySelector('#screen-content'),
    ok: host.querySelector('#key-ok'),
    up: host.querySelector('#key-up'),
    down: host.querySelector('#key-down'),
  };
}
