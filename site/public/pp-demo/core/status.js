/** Device telemetry presentation only; never reads the browser's or a real PP's Wi-Fi. */
export function wifiStrength(rssi) {
  if (!Number.isFinite(rssi)) return { level: 0, label: '强度未知' };
  if (rssi >= -55) return { level: 3, label: '强' };
  if (rssi >= -70) return { level: 2, label: '中' };
  return { level: 1, label: '弱' };
}

export function updateClock(clock, synced, now = new Date()) {
  clock.textContent = synced ? now.toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '--:--';
  clock.setAttribute('aria-label', synced ? `时间 ${clock.textContent}` : '时间尚未同步');
}

export function updateVolumeStatus(root, volume) {
  const value = Number.isFinite(volume) ? Math.round(Math.max(0, Math.min(100, volume))) : 0;
  const speaker = root.querySelector('#speaker');
  speaker.dataset.level = String(value === 0 ? 0 : value <= 33 ? 1 : value <= 66 ? 2 : 3);
  speaker.setAttribute('aria-label', value === 0 ? '静音' : `音量 ${value}%`);
  speaker.title = value === 0 ? '静音' : `音量 ${value}%`;
}

export function renderStatusBar(root, { wifi, paOnline, batteryLevel, clockSynced, volume = 65 }) {
  updateVolumeStatus(root, volume);
  const signal = root.querySelector('#signal');
  const strength = wifiStrength(wifi.rssi);
  signal.dataset.level = wifi.connected ? String(strength.level) : '0';
  signal.dataset.connected = String(wifi.connected);
  signal.setAttribute('aria-label', wifi.connected
    ? `Wi-Fi ${wifi.ssid || '名称未知'}，信号${strength.label}${Number.isFinite(wifi.rssi) ? `，${wifi.rssi} dBm` : ''}`
    : 'Wi-Fi 未连接');
  root.querySelector('#pa-link').hidden = !wifi.connected || paOnline;

  const battery = root.querySelector('#battery');
  const level = Number.isFinite(batteryLevel) ? Math.round(Math.max(0, Math.min(100, batteryLevel))) : null;
  battery.dataset.low = String(level !== null && level <= 15);
  battery.setAttribute('aria-label', level === null ? '电量未知' : `电量 ${level}%`);
  root.querySelector('#battery-percent').textContent = level === null ? '--' : String(level);
  root.querySelector('#battery-fill').style.width = `${level ?? 0}%`;
  updateClock(root.querySelector('#clock'), clockSynced);
}
