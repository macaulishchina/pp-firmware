/** Provisioning and cloud settings fixture. No access point, credentials or PA requests. */
export class DemoProvisioning {
  constructor(volume = 65, mode = 'steer') {
    this.paired = true;
    this.stage = 'ready';
    this.version = 0;
    this.code = ''; this.expires = 0;
    this.address = 'http://47.109.34.254:8047';
    this.name = '我的 PP';
    this.remoteVersion = 1; this.loadedVersion = 1;
    this.sync = '已同步 · v1'; this.reloadPending = false;
    this.config = { volume, mode, speechMode: 'brief', keepOnline: true,
      sleepSeconds: 120, brightness: 85, textSize: 10, voiceRate: 1, offlineHistory: true,
      voice: '系统中文音色 A', networks: [
        { ssid: 'Home Wi-Fi', password: '', available: true },
        { ssid: '手机热点', password: '', available: true },
      ] };
  }
  hotspot() {
    this.version++; this.paired = false; this.stage = 'hotspot';
    this.code = ''; this.reloadPending = false; this.sync = '未配对';
  }
  issueCode() {
    this.version++; this.paired = false; this.stage = 'pairing';
    const number = new Uint32Array(1); crypto.getRandomValues(number);
    this.code = String(number[0] % 100000000).padStart(8, '0');
    this.expires = Date.now() + 10 * 60 * 1000;
  }
  pair(code, name) {
    if (this.stage !== 'pairing' || Date.now() >= this.expires || code !== this.code) return false;
    this.paired = true; this.stage = 'ready'; this.name = name || '我的 PP';
    this.code = ''; this.expires = 0;
    return true;
  }
  save(config, name) {
    this.config = { ...config }; this.name = name;
    this.remoteVersion++;
    this.sync = `PA 已保存 v${this.remoteVersion} · 设备 v${this.loadedVersion}`;
  }
}
