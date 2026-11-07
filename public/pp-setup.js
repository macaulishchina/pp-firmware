const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
let port, reader, writer, reading, reply, bundle, ready = false;
function status(text) { $('result').textContent = text; }
function validateBundle(value) {
  const u = new URL(value.url);
  if (value.protocol !== 1 || u.protocol !== 'wss:' || u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/stream')) throw Error('配对地址无效');
  for (const key of ['device_id','credential','pairing_token']) if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value[key])) throw Error('配对材料无效');
  if (!Number.isFinite(value.expires) || value.expires * 1000 <= Date.now()) throw Error('配对材料已过期，请在 PA 重新生成');
  return value;
}
$('pairing').onchange = async () => {
  bundle = undefined;
  try {
    const file = $('pairing').files[0]; if (!file || file.size > 8192) throw Error('请选择有效配对文件');
    bundle = validateBundle(JSON.parse(await file.text()));
    $('target').textContent = '目标：' + bundle.url;
    $('online').checked = bundle.settings?.keep_online === true;
  } catch { $('target').textContent = '配对文件无效或已过期，请重新导入。'; }
};
async function exchange(line, matches) {
  if (reply) throw Error('已有 USB 操作进行中');
  let timer;
  const pending = new Promise((resolve, reject) => {
    timer = setTimeout(() => { reply = undefined; reject(Error('设备响应超时。不要自动重复写入，请查看设备是否已重启。')); }, 12000);
    reply = value => { if (matches(value)) { clearTimeout(timer); reply = undefined; resolve(value); } };
  });
  try { await writer.write(encoder.encode(line + '\n')); return await pending; }
  finally { clearTimeout(timer); reply = undefined; }
}
async function consume() {
  const decoder = new TextDecoder(); let line = '';
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      line += decoder.decode(value, {stream:true});
      for (;;) {
        const end = line.indexOf('\n'); if (end < 0) break;
        const part = line.slice(0,end).trim(); line = line.slice(end+1);
        if (part.startsWith('{') && part.length < 4096) { try { reply?.(JSON.parse(part)); } catch { /* Firmware logs are not configuration responses. */ } }
      }
      if (line.length > 8192) line = '';
    }
  } catch { status('USB 已断开。若刚写入，请查看设备启动状态。'); }
  finally { ready = false; $('save').disabled = true; }
}
async function disconnect() {
  ready = false; $('save').disabled = true;
  try { await reader?.cancel(); await reading; reader?.releaseLock(); writer?.releaseLock(); await port?.close(); } catch { /* Already disconnected. */ }
  reader = writer = port = reading = undefined;
  $('connect').disabled = false; $('disconnect').disabled = true; $('device').textContent = '已断开';
}
$('connect').onclick = async () => {
  try {
    if (!window.isSecureContext || !navigator.serial) throw Error('请使用可信 HTTPS 或 localhost 下的 Chrome / Edge');
    port = await navigator.serial.requestPort({filters:[{usbVendorId:0x303a}]});
    await port.open({baudRate:115200}); reader = port.readable.getReader(); writer = port.writable.getWriter(); reading = consume();
    const value = await exchange('pp.status', v => v.app === 'PA-Terminal' && v.protocol === 1);
    ready = value.protocol === 1; $('connect').disabled = true; $('disconnect').disabled = false; $('save').disabled = !ready; $('device').textContent = 'PA-Terminal · 已连接'; status('可以填写配置。');
  } catch (e) { status(e.name === 'NotFoundError' ? '未选择设备。' : '连接未完成：' + e.message); await disconnect(); }
};
$('disconnect').onclick = disconnect;
$('setup').onsubmit = async event => {
  event.preventDefault(); if (!ready) return;
  try {
    validateBundle(bundle);
    const caFile = $('ca').files[0]; if (!caFile || caFile.size > 4096) throw Error('请选择不超过 4 KiB 的公开 CA 证书');
    const ca = await caFile.text();
    if (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY')) throw Error('必须使用公开 CA 证书，不得使用私钥');
    const ssid = $('ssid').value, password = $('password').value;
    if (!ssid || encoder.encode(ssid).length > 32 || encoder.encode(password).length > 64) throw Error('Wi-Fi 名称或密码超过设备字节限制');
    const config = {protocol:1,url:bundle.url,device_id:bundle.device_id,credential:bundle.credential,pairing_token:bundle.pairing_token,settings:{...bundle.settings,keep_online:$('online').checked},ssid,password,ca};
    const line = 'pp.config ' + JSON.stringify(config);
    if (encoder.encode(line).length > 8190) throw Error('配置超出设备接收大小');
    if (!confirm('写入新的网络和配对配置，并重启这台 PP？')) return;
    $('save').disabled = true;
    const response = await exchange(line, v => typeof v.configured === 'boolean');
    if (!response.configured) throw Error('设备拒绝配置，请检查字段和文件');
    $('password').value = ''; $('pairing').value = ''; $('ca').value = ''; bundle = undefined;
    status('配置已写入，设备正在重启。请在 PP 上核对连接状态。'); await disconnect();
  } catch (e) { status(e.message); $('save').disabled = !ready; }
};
if (!window.isSecureContext || !navigator.serial) status('当前浏览器不支持安全 USB 串口，请使用 Windows Chrome / Edge 和可信 HTTPS。');

$('reset').onclick = async () => {
  if (!ready) { status('请先连接 PA-Terminal 设备。'); return; }
  if (!confirm('确定清除本设备的 Wi-Fi、配对和个人偏好？此操作不能撤销，服务器任务仍会继续。')) return;
  try {
    const response = await exchange('pp.reset CONFIRM', v => typeof v.reset === 'boolean');
    if (!response.reset) throw Error('设备未确认清除。');
    status('设备已恢复出厂设置，请在 PA 后台撤销旧配对。'); await disconnect();
  } catch (e) { status(e.message); }
};
