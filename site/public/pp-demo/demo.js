import { PassportModel } from './model.js';
import { PP_PROFILE } from './core/profile.js';
import { mountDeviceShell } from './core/device-shell.js';
import { bindHardwareKeys } from './core/keys.js';
import { mountDisplay } from './core/display.js';
import { demoVoiceLevel } from './core/voice.js';
import { DemoProvisioning } from './core/provisioning.js';

const $ = id => document.getElementById(id);
const hardware = mountDeviceShell($('device-host'));
const display = await mountDisplay(hardware.canvas);
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Shanghai' });
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('pp-demo.preferences.v1') || '{}') || {}; } catch {}
const model = new PassportModel(preferences, { paginate: (value, size) => display.pages(value, size) });
const provisioning = new DemoProvisioning(model.volume, model.mode);
provisioning.config.keepOnline = model.keepOnline;
const { interaction, simulation } = PP_PROFILE;
$('scenario-picker').innerHTML = Object.values(model.catalog).map(scene =>
  `<option value="${escape(scene.id)}">${escape(scene.title)}</option>`).join('');
let pressed = false, pressStarted = 0, holdTimer = null, clickTimer = null, wakeGuard = false, stoppedOnPress = false;
let pressRoute = '', transitionAt = -Infinity;
let pressMenuChoice = '';
let wifiHold = false, wifiHoldConsumed = false;
let recordInterval = null, feedbackTimer = null;
let secondTap = false;
let volumeFeedbackUntil = 0, volumeSaveTimer = null;
let brightnessDraft = model.brightness;
let followResponse = true;
let pendingNotice = null;
let wifiDraft = provisioning.config.networks.map(network => ({ ...network }));
let appliedWifiNetworks = wifiDraft.map(network => ({ ...network }));
let wifiCycleVersion = 0;
let wifiRetryTimer = null;
let retryWifiBatch = null;
let paAvailable = true;
let appliedConfig = { ...provisioning.config };
function renderWifiDraft() {
  $('cloud-networks').innerHTML = wifiDraft.map((network, index) => `<div class="wifi-profile" data-index="${index}">
    <div class="wifi-profile-heading"><strong>${index + 1}</strong><span>连接优先级 ${index + 1}</span><div><button type="button" data-wifi-action="up" aria-label="上移网络" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-wifi-action="down" aria-label="下移网络" ${index === wifiDraft.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-wifi-action="remove" ${wifiDraft.length === 1 ? 'disabled' : ''}>移除</button></div></div>
    <div class="setup-grid"><label>Wi-Fi 名称<input data-wifi-field="ssid" value="${escape(network.ssid)}" maxlength="32" required></label><label>密码<input data-wifi-field="password" type="password" value="${escape(network.password)}" maxlength="63" autocomplete="off" placeholder="空白表示开放网络"></label></div>
    <label>连接结果（仅演示）<select data-wifi-field="available"><option value="yes" ${network.available ? 'selected' : ''}>可连接</option><option value="no" ${network.available ? '' : 'selected'}>模拟失败</option></select></label>
  </div>`).join('');
  $('wifi-add').disabled = wifiDraft.length >= 5;
}
function cancelWifiCycle() {
  clearTimeout(wifiRetryTimer);
  retryWifiBatch = null;
  return ++wifiCycleVersion;
}
function startWifiCycle() {
  if (model.sleeping) return;
  const version = cancelWifiCycle();
  const networks = appliedWifiNetworks.map(network => ({ ...network }));
  if (!networks.length) return;
  model.stopPlayback(); model.feedback = ''; provisioning.message = '';
  model.setWifi({ connected: false });
  let nextIndex = 0;
  const batch = () => {
    if (version !== wifiCycleVersion || model.sleeping) return;
    retryWifiBatch = null;
    const started = performance.now();
    provisioning.stage = 'wifi-trying';
    render();
    const attempt = tried => {
      const network = networks[nextIndex];
      nextIndex = (nextIndex + 1) % networks.length;
      wifiRetryTimer = later(() => {
        if (version !== wifiCycleVersion || model.sleeping) return;
        if (network.available) {
          model.setWifi({ connected: true, ssid: network.ssid });
          model.network(paAvailable && !provisioning.rejected && (provisioning.paired || !$('setup-fail').checked));
          model.clockSynced = true;
          if (provisioning.rejected) provisioning.stage = 'revoked';
          else if (!model.online) provisioning.stage = 'unreachable';
          else if (!provisioning.paired) provisioning.issueCode();
          else provisioning.stage = 'ready';
          render();
          return;
        }
        if (tried < PP_PROFILE.wifi.attempts) {
          attempt(tried + 1);
          return;
        }
        provisioning.stage = 'wifi-waiting';
        retryWifiBatch = batch;
        render();
        wifiRetryTimer = later(batch, Math.max(0, started + PP_PROFILE.wifi.retryMs - performance.now()));
      }, PP_PROFILE.wifi.attemptMs);
    };
    attempt(1);
  };
  batch();
}
function holdWifi() {
  if (!pressed || !wifiHold || wifiHoldConsumed || pressRoute !== model.view) return;
  wifiHoldConsumed = true;
  if (model.wifi.connected || provisioning.stage === 'wifi-trying' || provisioning.stage === 'hotspot') return;
  if (retryWifiBatch) {
    clearTimeout(wifiRetryTimer);
    retryWifiBatch();
  } else startWifiCycle();
}
function sleepDevice() {
  cancelWifiCycle();
  model.sleep();
  render();
}
function canStandbyFromHome() {
  return model.view === 'home' && model.homeOnly && !model.sleeping && !setupHome() && model.canSleep;
}
function wakeDevice() {
  model.wake();
  if (!model.wifi.connected && provisioning.savedWifi && provisioning.stage !== 'hotspot') {
    startWifiCycle();
    return;
  }
  if (model.wifi.connected) model.network(paAvailable && provisioning.paired && !provisioning.rejected);
  render();
}
function startHotspot() {
  cancelWifiCycle();
  cancelPress('进入配网，未提交录音已丢弃');
  leaveHistory(); model.selectScenario(model.scenario);
  provisioning.hotspot(); model.setWifi({ connected: false }); model.network(false);
  model.clockSynced = false;
  $('setup-code').value = ''; $('setup-password').value = '';
  model.log('模拟设备热点：手机只填写 Wi-Fi，设备使用固件预设的 PA 地址');
  render();
}
function requestConfigReload() {
  if (!provisioning.paired) { provisioning.message = '请先完成设备配对'; render(); return; }
  if (!model.online) { provisioning.message = '设备离线，保留本地配置；联网后同步'; render(); return; }
  if (model.input !== 'idle' || model.playing || model.view === 'brightness' ||
      ['processing', 'responding'].includes(model.work)) {
    provisioning.reloadPending = true;
    provisioning.sync = '等待本次交互结束后重载'; render(); return;
  }
  const config = provisioning.config;
  provisioning.reloadPending = false;
  // A reload does not overwrite local preferences unless that cloud field changed.
  for (const field of ['volume', 'mode', 'keepOnline', 'sleepSeconds', 'voiceRate', 'textSize', 'brightness', 'showImages']) {
    if (config[field] !== appliedConfig[field]) model[field] = config[field];
  }
  if (config.speechMode !== appliedConfig.speechMode) {
    model.autoSpeak = config.speechMode !== 'off';
    model.speechLimit = config.speechMode === 'full' ? Infinity : 200;
  }
  if (config.offlineHistory !== appliedConfig.offlineHistory) model.history.setEnabled(config.offlineHistory);
  appliedConfig = { ...config };
  provisioning.loadedVersion = provisioning.remoteVersion;
  provisioning.sync = `已同步 · v${provisioning.loadedVersion}`;
  provisioning.message = '配置已重载，没有重启或重复执行任务';
  savePreferences(); model.log(provisioning.message);
  if (JSON.stringify(appliedWifiNetworks) !== JSON.stringify(config.networks)) {
    appliedWifiNetworks = config.networks.map(network => ({ ...network }));
    startWifiCycle(); return;
  }
  render();
}
function renderProvisioning() {
  $('setup-connect').disabled = provisioning.stage !== 'hotspot';
  $('setup-bind').disabled = provisioning.stage !== 'pairing';
  $('cloud-fields').disabled = !provisioning.paired;
  $('cloud-reload').disabled = !provisioning.paired;
  $('setup-revoke').disabled = !provisioning.paired;
  $('setup-wifi').hidden = provisioning.stage !== 'hotspot';
  $('setup-pair').hidden = provisioning.stage !== 'pairing';
  $('cloud-settings').hidden = !provisioning.paired || provisioning.stage !== 'ready';
  $('setup-first').hidden = !provisioning.paired;
  $('scenario-picker').disabled = !provisioning.paired;
  $('setup-ready').hidden = provisioning.paired;
  const status = !setupHome() ? `${provisioning.name} · ${provisioning.sync}`
    : { hotspot: '等待手机配置初始 Wi-Fi', pairing: '等待在 PA 后台输入屏幕上的 8 位码', unreachable: 'Wi-Fi 已连接，PA 暂不可达', revoked: 'PA 拒绝当前身份，可在「PA 与维护」中更换配对' }[provisioning.stage];
  $('setup-state').textContent = [status, provisioning.message].filter(Boolean).join(' · ');
}
const historyView = { id: null, record: null, page: 0, loading: false, error: '', source: '', version: 0 };
function historyPages(record) {
  const parts = model.history.pages(record);
  return model.showImages ? parts : parts.filter(part => !part.image);
}
function leaveHistory() {
  historyView.version++;
  historyView.loading = false; historyView.record = null; historyView.error = '';
  model.view = 'home';
}
function openHistoryRecord(id, position = 'last', { stopPlayback = true } = {}) {
  if (!id) { feedback('已到最早记录'); return; }
  const version = ++historyView.version;
  Object.assign(historyView, { id, record: null, page: 0, error: '', loading: false, source: '' });
  if (stopPlayback) model.stopPlayback();
  model.feedback = ''; model.homeOnly = false; model.view = 'history';
  const show = (record, source) => {
    historyView.record = record; historyView.source = source;
    const parts = historyPages(record);
    const replyPage = parts.findIndex(part => part.role === '回复');
    historyView.page = position === 'last' ? parts.length - 1 : position === 'input'
      ? Math.max(0, replyPage - 1) : position === 'reply' ? Math.max(0, replyPage) : 0;
    render();
  };
  const cached = model.history.cached(id);
  if (cached) { show(cached, '本地缓存'); return; }
  if (!model.online) { historyView.error = '此处尚未缓存，联网后查看'; render(); return; }
  historyView.loading = true; render();
  later(() => {
    if (version !== historyView.version || model.view !== 'history') return;
    historyView.loading = false;
    if (!model.online) { historyView.error = '连接已断开，联网后按 ↑ 重试'; render(); return; }
    const record = model.history.read(id);
    if (!record) { historyView.error = '这段对话已不可用，按 ↓ 返回'; render(); return; }
    model.log('模拟按游标读取历史；最近缓存保持原有顺序');
    show(record, '在线读取');
  }, 650);
}
function browseHistory(direction) {
  model.stopPlayback();
  model.newReply = false;
  if (historyView.loading) {
    if (direction > 0) { leaveHistory(); render(); }
    return;
  }
  if (model.view !== 'history') {
    if (model.homeOnly && model.work === 'clarifying') {
      model.homeOnly = false; model.view = 'home'; render(); return;
    }
    if (model.homeOnly) {
      const latest = model.online ? model.lastHistoryId || model.history.latestId : model.history.latestCachedId;
      if (latest) openHistoryRecord(latest, 'last');
      else feedback(model.history.enabled ? '最近记录尚未缓存，请联网同步' : '离线缓存已关闭');
      return;
    }
    if (direction > 0) { feedback('已到最新记录'); return; }
    openHistoryRecord(model.lastHistoryId || model.history.latestId, model.lastHistoryId ? 'input' : 'last');
    return;
  }
  if (historyView.error) {
    if (direction < 0) openHistoryRecord(historyView.id);
    else { leaveHistory(); render(); }
    return;
  }
  const parts = historyPages(historyView.record);
  const nextPage = historyView.page + direction;
  if (nextPage >= 0 && nextPage < parts.length) {
    if (direction > 0 && historyView.id === model.lastHistoryId && parts[nextPage].role === '回复') {
      leaveHistory(); model.page = 0; render(); return;
    }
    historyView.page = nextPage; render(); return;
  }
  const nextId = model.history.neighborId(historyView.id, direction);
  if (!nextId) {
    if (direction > 0) { leaveHistory(); model.page = 0; render(); }
    else feedback('已到最早记录');
    return;
  }
  openHistoryRecord(nextId, direction < 0 ? 'last' : 'first');
}
function canJumpLatest() {
  return !model.sleeping && model.input === 'idle' && (model.view === 'history'
    || model.view === 'home' && !model.homeOnly && !setupHome() && model.work !== 'clarifying'
      && Boolean(model.reply || model.work === 'responding'));
}
function jumpLatest() {
  model.newReply = false;
  if (model.online && model.view === 'home' && model.work === 'responding') {
    followResponse = true;
    model.page = 0;
    render();
    return;
  }
  const id = model.online ? model.history.latestId : model.history.latestCachedId;
  if (id) openHistoryRecord(id, 'reply', { stopPlayback: false });
  else feedback(model.history.enabled ? '最近记录尚未缓存，请联网同步' : '离线缓存已关闭');
}
function later(fn, delay) { return setTimeout(fn, delay); }
function savePreferences() {
  try { localStorage.setItem('pp-demo.preferences.v1', JSON.stringify({ mode:model.mode, volume:model.volume, brightness:model.brightness, keepOnline:model.keepOnline, standbyWifi:model.standbyWifi })); } catch {}
}
function adjustVolume(delta, showToast = false) {
  model.volume = Math.max(0, Math.min(100, model.volume + delta));
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(savePreferences, 450);
  if (showToast) {
    volumeFeedbackUntil = performance.now() + 1400;
    later(renderScreen, 1410);
  }
  renderScreen();
}
function stopRecordClock() { clearInterval(recordInterval); recordInterval = null; }
function feedback(text) {
  model.feedback = text; clearTimeout(feedbackTimer); render();
  feedbackTimer = later(() => { model.feedback = ''; render(); }, 2600);
}
function setupHome() {
  return !provisioning.paired || provisioning.stage === 'hotspot' || provisioning.rejected;
}
function screenPhase() {
  if (model.sleeping || model.view !== 'home') return model.phase;
  if (setupHome()) return provisioning.stage;
  if (['wifi-trying', 'wifi-waiting'].includes(provisioning.stage)) return provisioning.stage;
  return model.phase;
}
function networkPages() {
  const name = model.wifi.connected ? model.wifi.ssid : '未连接';
  const rssi = model.wifi.connected ? `${model.wifi.rssi} dBm` : '未连接';
  return model.paginate(`Wi-Fi ${name}\n${model.online ? 'PA 已连接' : 'PA 离线'}\n信号 ${rssi}\n可用内存 29516\n最大连续块 7936`);
}

function renderScreen(phase = screenPhase()) {
  model.syncMenuExecution();
  const volume = model.volume;
  const frame = {
    view: 'idle', origin: '', body: '', state: '就绪', hint: '按住说 · OK菜单',
    clock: model.clockSynced ? clockFormat.format(new Date()) : '--:--',
    battery: model.batteryLevel,
    rssi: model.wifi.connected ? model.wifi.rssi ?? -127 : -127,
    wifiSearching: !model.sleeping && provisioning.stage === 'wifi-trying',
    queue: model.mode === 'queue', volume, brightness: model.brightness, textSize: model.textSize,
  };
  const info = (origin, body = '', hint = 'OK 菜单') => {
    Object.assign(frame, { view: 'info', origin, body, hint, state: origin });
  };
  const menu = (origin, choices, selection, state = '请选择') => {
    Object.assign(frame, { view: 'menu', origin, choices, selection, state, hint: 'OK 确认 · 长↑主页' });
  };
  const reply = (body, origin = '回复', state = '回复', hint = '上下翻页 · 长↑主页') => {
    Object.assign(frame, { view: 'reply', origin, body, state, hint });
  };
  switch (phase) {
    case 'hotspot':
      info('连接设备热点', 'PP-7C42\n密码 ppdemo88\n\n手机打开\nhttp://192.168.4.1');
      break;
    case 'pairing':
      info('等待配对', Date.now() < provisioning.expires
        ? `${provisioning.code}\n\n在 PA 后台输入这八位数字\n配对码十分钟有效`
        : '配对码已过期，请重新连接。', 'OK 菜单');
      break;
    case 'wifi-trying':
    case 'wifi-waiting':
      frame.state = '';
      if (setupHome()) frame.hint = 'OK 菜单';
      break;
    case 'revoked':
      info('PA 身份验证失败 (401)', '请检查 PA 接入设置。旧配对被撤销后，可更换配对并保留 Wi-Fi。', '下 更换配对 · OK 菜单');
      break;
    case 'unreachable':
      info('PA 暂不可达，稍后重连', '', 'OK 菜单');
      break;
    case 'offline':
      if (!model.homeOnly && model.reply && model.history.enabled) {
        reply(model.pages[model.page] || '');
      }
      frame.state = model.wifi.connected ? 'PA 暂不可达，稍后重连' : '';
      break;
    case 'recording':
    case 'finalizing':
    case 'processing':
      Object.assign(frame, {
        view: 'input', origin: '你说的',
        body: phase === 'processing' ? model.submittedPrompt : model.partialPrompt,
        state: phase === 'finalizing' ? '识别中' : phase === 'processing' ? '等待回复' : '正在听',
        hint: phase === 'recording' ? '正在听 · 松开结束' : '上下翻页 · 长↑主页',
        elapsed: phase === 'recording' ? model.elapsed : 0,
        signal: phase === 'recording' ? demoVoiceLevel(model.elapsed) : 0,
      });
      break;
    case 'input-review':
      menu('输入尚未发送', ['丢弃本次输入', '发送已识别文字', '查看完整转写'],
        model.menuIndex, '达到上限，确认后才发送');
      frame.hint = '上下选择 · OK确认';
      break;
    case 'input-review-text':
      reply(model.reviewPages[model.page], '你说的 · 待发送', '', '上下查看 · OK返回');
      break;
    case 'clarifying':
      reply(model.pages[model.page], '等待回答', '等待回答', '按住回答 · 长↑主页');
      break;
    case 'responding':
    case 'playing':
    case 'reply':
      reply(phase === 'responding' && followResponse ? Array.from(model.responseVisible).slice(-160).join('') : model.pages[model.page] || '');
      frame.hint = '上下翻页 · 长↓最新';
      frame.follow = phase === 'responding' && followResponse;
      if (model.pageImage) Object.assign(frame, { view: 'image', origin: '图片', image: model.pageImage });
      if (model.playing) Object.assign(frame, { state: '播放中', hint: '上下音量 · OK停播' });
      break;
    case 'menu':
    case 'sound':
    case 'connectivity':
    case 'power':
    case 'maintenance':
      menu({ menu: '操作菜单', sound: '声音与屏幕', connectivity: '网络与配对',
        power: '电源与待机', maintenance: 'PA 与维护' }[phase],
        model.menus.map(item => item.value ? `${item.label} · ${item.value}` : item.label),
        model.menuIndex, phase === 'menu' ? '请选择' : '');
      frame.menuDetail = model.menus[model.menuIndex]?.detail;
      frame.menuGrid = phase === 'menu';
      break;
    case 'volume':
      info('音量', '', '上下音量 · OK返回');
      frame.volumeFeedback = true;
      break;
    case 'brightness':
      Object.assign(frame, { view: 'brightness', origin: '屏幕亮度', body: `${brightnessDraft}%`,
        brightness: brightnessDraft, state: '', hint: '上下调整 · OK 保存' });
      break;
    case 'notices':
      menu('任务消息', [...model.notices.map(notice => notice.title), '返回菜单'],
        model.noticeIndex, pendingNotice ? '正在读取任务' : model.notices.length ? '选择任务查看' : '暂无任务消息');
      frame.task = true;
      break;
    case 'notice':
      reply(model.pages[model.page], `任务报告 · ${model.activeNotice.title}`, '任务结果', 'OK 返回列表 · 长↑主页');
      frame.task = true;
      break;
    case 'history': {
      const part = historyView.record && historyPages(historyView.record)[historyView.page];
      const status = part
        ? historyView.source === '本地缓存' ? '本地缓存' : '历史记录'
        : historyView.loading ? '正在读取' : historyView.error;
      if (part) {
        reply(part.text, part.role, status, '上下翻页 · 长↓最新');
        if (part.image) Object.assign(frame, { view: 'image', origin: '图片', image: part.image });
      } else Object.assign(frame, { state: status, hint: '上下翻页 · 长↓最新' });
      break;
    }
    case 'status': {
      const pages = networkPages();
      const hint = pages.length <= 1 ? 'OK 返回 · 长↑主页'
        : model.page === 0 ? '向下翻页 · OK 返回'
        : model.page < pages.length - 1 ? '上下翻页 · OK 返回' : '向上翻页 · OK 返回';
      info('网络状态', pages[model.page], hint);
      break;
    }
    case 'device-reset':
      info(provisioning.resetTarget === 'factory' ? '恢复出厂设置？' : provisioning.resetTarget === 'repair' ? '更换 PA 配对？' : '设置 Wi-Fi？',
        provisioning.resetTarget === 'factory'
          ? '将移除此设备的配对、Wi-Fi 和本地设置。服务器会话和任务不会被删除。'
          : provisioning.resetTarget === 'repair' ? '将更换设备身份并重启。保留 Wi-Fi 和设置。请在 PA 后台用新码绑定新会话。' : '将开启设备热点。提交前保留原配置。',
        model.menuIndex === 1 ? '确认 · OK执行' : '上下选择 · OK取消');
      break;
    case 'error':
      info('请求未完成', model.error, '上下翻页 · 长↑主页');
      break;
    case 'sleeping':
      frame.view = 'sleep';
      break;
    default:
      if (model.newReply) frame.state = '有新回复 · 上下查看';
      else if (model.work === 'processing' || model.work === 'responding') frame.state = '后台处理中';
  }
  if (model.feedback && phase !== 'sleeping') frame.state = model.feedback;
  frame.awaitingReply = phase === 'processing' && !model.feedback;
  if (model.playing) frame.volumeFeedback ||= performance.now() < volumeFeedbackUntil;
  hardware.screen.dataset.phase = phase;
  hardware.screen.dataset.view = frame.view;
  hardware.screen.dataset.mode = model.mode;
  hardware.screen.dataset.playing = String(model.playing);
  hardware.screen.dataset.volumeFeedback = String(Boolean(frame.volumeFeedback));
  hardware.screen.dataset.menuLayout = frame.menuGrid ? 'grid' : frame.view === 'menu' ? 'list' : '';
  hardware.screen.dataset.selected = frame.choices?.[frame.selection] || '';
  if (frame.origin && frame.state === frame.origin) frame.state = '';
  hardware.content.textContent = [frame.origin, frame.body, frame.choices?.join('\n'),
    frame.menuDetail, frame.image?.alt, frame.volumeFeedback ? `音量 ${volume}` : frame.state, frame.hint].filter(Boolean).join('\n');
  display.render(frame);
}

function render() {
  const phase = screenPhase();
  renderScreen(phase);
  $('stage-status').textContent = {
    idle: '就绪', recording: '正在收音', finalizing: '等待最终转写', processing: '处理中',
    responding: '接收回复', playing: '模拟播放', reply: '回复已收到', clarifying: '等待回答',
    menu: '操作菜单', sound: '声音与屏幕', connectivity: '网络与配对', power: '电源与待机',
    maintenance: 'PA 与维护', volume: '调整音量', brightness: '调整亮度', notices: '任务消息',
    notice: '查看任务报告', history: '查看历史', status: '网络状态', 'device-reset': '等待确认',
    error: '请求未完成', offline: model.wifi.connected ? 'PA 离线' : '', sleeping: '设备休眠', hotspot: '等待手机配网',
    revoked: '配对被拒绝', pairing: '等待 PA 配对', 'wifi-trying': '',
    'wifi-waiting': '', unreachable: 'PA 暂不可达',
    'input-review': '转写待确认', 'input-review-text': '查看待发送转写',
  }[phase] ?? '就绪';
  $('stage-dot').className = phase === 'error' ? 'error' : !model.online ? 'offline' : '';
  $('utterance').textContent = model.prompt;
  $('scene-description').textContent = model.catalog[model.scenario].description;
  const longInput = Array.from(model.prompt).length > 160;
  $('scene-actions').hidden = !model.backgroundPending && !longInput;
  $('task-complete').hidden = !model.backgroundPending;
  $('record-limit').hidden = !longInput;
  $('record-limit').disabled = model.input !== 'recording';
  $('network-toggle').textContent = model.wifi.connected ? '断开 Wi-Fi' : '恢复 Wi-Fi';
  if ($('wifi-name').value !== model.wifi.ssid) $('wifi-name').value = model.wifi.ssid;
  $('battery-level').value = model.batteryLevel;
  $('battery-value').textContent = `${model.batteryLevel}%`;
  $('pa-state').value = model.online ? 'online' : 'offline';
  $('pa-state').disabled = !model.wifi.connected;
  $('clock-synced').checked = model.clockSynced;
  $('recognition-failure').setAttribute('aria-pressed', String(model.failNext));
  $('empty-input').setAttribute('aria-pressed', String(model.noContentNext));
  $('history-cache-status').textContent = model.history.enabled
    ? `已缓存 ${model.history.cache.size} 条 · ${(model.history.bytes / 1024).toFixed(1)} KiB`
    : '离线历史已关闭';
  $('history-cache-clear').disabled = !model.history.cache.size;
  $('event-count').textContent = `${model.events.length} 步`;
  if ($('interaction-record').open) {
    $('event-log').innerHTML = model.events.map(e => `<li><time>${escape(e.at)}</time>${escape(e.text)}</li>`).join('');
  }
  renderProvisioning();
}
function startWork(job) {
  if (!job) {
    const queued = model.nextQueued();
    if (queued) startWork(queued);
    else render();
    return;
  }
  render();
  later(() => {
    if (!model.beginResponse(job.version, job.input)) return;
    followResponse = true;
    const characters = Array.from(model.responseText), started = performance.now();
    const reveal = () => {
      if (model.workVersion !== job.version || model.work !== 'responding') return;
      const count = Math.min(characters.length, Math.floor((performance.now() - started) / 1000 * simulation.responseCharactersPerSecond));
      model.responseVisible = characters.slice(0, count).join('');
      model.offerSpeech(model.responseVisible, count === characters.length);
      model.advanceSpeech(0);
      if (followResponse) model.page = 0;
      render();
      if (count < characters.length) { later(reveal, 80); return; }
      const deliveredPage = model.page;
      if (!model.completeWork(job.version, job.input)) return;
      if (!followResponse) model.page = Math.min(deliveredPage, model.pages.length - 1);
      render();
    };
    reveal();
  }, simulation.executionMs);
}
function pressOK() {
  const now = performance.now();
  if (pressed || (!model.sleeping && now - transitionAt <= interaction.doubleMs)) return;
  pressRoute = model.view;
  model.syncMenuExecution();
  pressMenuChoice = model.menuOpen ? model.menus[model.menuIndex].id : '';
  wifiHold = wifiHoldConsumed = false;
  pressed = true; pressStarted = now; $('key-ok').classList.add('pressed');
  if (model.sleeping) { wakeGuard = true; wakeDevice(); return; }
  wifiHold = !model.wifi.connected && provisioning.savedWifi && provisioning.stage !== 'hotspot' &&
    model.view !== 'device-reset' && model.input !== 'review';
  if (wifiHold) {
    if (model.view === 'home' && !setupHome()) {
      secondTap = Boolean(clickTimer);
      clearTimeout(clickTimer); clickTimer = null;
    }
    holdTimer = later(holdWifi, interaction.holdMs);
    return;
  }
  if (setupHome() || model.input === 'review') return;
  if (model.view === 'history') {
    const version = historyView.version;
    holdTimer = later(() => {
      if (!pressed || version !== historyView.version) return;
      leaveHistory(); startRecording();
    }, interaction.holdMs);
    return;
  }
  if (model.view !== 'home') return;
  secondTap = Boolean(clickTimer);
  clearTimeout(clickTimer); clickTimer = null;
  if (!model.online) { feedback('未连接 PA'); return; }
  if (model.input !== 'idle') { feedback('上一句正在确认，还没有重新收音'); return; }
  stoppedOnPress = model.stopPlayback();
  if (stoppedOnPress) { render(); }
  holdTimer = later(() => {
    if (pressed) startRecording();
  }, interaction.holdMs);
}
function startRecording() {
  if (model.startInput() === null) return;
  render();
  recordInterval = setInterval(() => {
    model.elapsed = (performance.now() - pressStarted) / 1000;
    model.partialPrompt = Array.from(model.prompt).slice(0, Math.floor(model.elapsed * 7)).join('');
    renderScreen();
    if (model.elapsed >= interaction.maxRecordingSeconds) finishAtLimit();
  }, 100);
}
function finishAtLimit() {
  if (model.input !== 'recording') return;
  pressed = false; clearTimeout(holdTimer); $('key-ok').classList.remove('pressed');
  stopRecordClock();
  const version = model.releaseInput(); render();
  later(() => { model.finishInput(version, true); render(); }, simulation.recognitionMs);
}
function releaseOK() {
  if (!pressed) return;
  if (performance.now() - pressStarted >= interaction.holdMs) holdWifi();
  pressed = false; $('key-ok').classList.remove('pressed'); clearTimeout(holdTimer);
  if (wakeGuard) { wakeGuard = false; return; }
  if (wifiHoldConsumed) return;
  if (pressRoute !== model.view && model.input !== 'recording') return;
  if (pressMenuChoice && model.menus[model.menuIndex]?.id !== pressMenuChoice) return;
  const before = model.view;
  finishOK();
  if (model.view !== before) transitionAt = performance.now();
}
function finishOK() {
  if (setupHome() && model.view === 'home') {
    model.openView('menu');
    render(); return;
  }
  if (model.input === 'review') {
    if (model.view === 'input-review-text') {
      model.view = 'home'; model.page = model.menuIndex = 0;
    } else if (model.menuIndex === 2) {
      model.view = 'input-review-text'; model.page = 0;
    } else {
      const send = model.menuIndex === 1;
      startWork(model.confirmInput(send));
      if (!send) feedback('已丢弃，未执行');
    }
    render(); return;
  }
  if (model.view !== 'home') { menuOK(); return; }
  if (model.input === 'recording') {
    stopRecordClock();
    const version = model.releaseInput(); render();
    later(() => startWork(model.finishInput(version)), simulation.recognitionMs);
    stoppedOnPress = false;
    return;
  }
  if (model.input !== 'idle') return;
  const stopped = stoppedOnPress; stoppedOnPress = false;
  if (performance.now() - pressStarted >= interaction.holdMs) return;
  if (secondTap) {
    secondTap = false;
    model.toggleMode(); savePreferences(); feedback(model.feedback);
  } else clickTimer = later(() => {
    clickTimer = null;
    if (stopped) return;
    model.stopPlayback(); model.openView('menu'); model.feedback = ''; render();
  }, interaction.doubleMs);
}
function cancelPress(reason) {
  pressed = false; wakeGuard = false; stoppedOnPress = false; secondTap = false;
  $('key-ok').classList.remove('pressed'); clearTimeout(holdTimer); clearTimeout(clickTimer); clickTimer = null;
  const interrupted = model.input !== 'idle';
  stopRecordClock(); model.discardInput(reason); render();
  if (interrupted) {
    const queued = model.nextQueued();
    if (queued) startWork(queued);
  }
}
function move(direction) {
  transitionAt = -Infinity;
  if (model.view === 'device-reset') { model.menuIndex = 1 - model.menuIndex; render(); return; }
  if (model.sleeping) { wakeDevice(); return; }
  if (model.input === 'review') {
    if (model.view === 'input-review-text') model.page = Math.max(0, Math.min(model.reviewPages.length - 1, model.page + direction));
    else model.menuIndex = (model.menuIndex + direction + 3) % 3;
    render(); return;
  }
  if (model.view === 'home' && setupHome()) {
    if (provisioning.rejected && direction > 0) openConfirmation('repair');
    return;
  }
  if (model.input !== 'idle') { feedback('先结束或确认当前输入'); return; }
  if (model.playing && model.view === 'home') { adjustVolume(direction * -5, true); return; }
  if (model.menuOpen) model.menuIndex = (model.menuIndex + direction + model.menus.length) % model.menus.length;
  else if (model.view === 'history') { browseHistory(direction); return; }
  else if (model.view === 'volume') adjustVolume(direction * -5);
  else if (model.view === 'brightness') brightnessDraft = Math.max(40, Math.min(100, brightnessDraft - direction * 5));
  else if (model.view === 'status') model.page = Math.max(0, Math.min(networkPages().length - 1, model.page + direction));
  else if (model.view === 'notices') {
    pendingNotice = null;
    model.noticeIndex = (model.noticeIndex + direction + model.notices.length + 1) % (model.notices.length + 1);
  }
  else if (model.view === 'notice') model.page = Math.max(0, Math.min(model.pages.length - 1, model.page + direction));
  else if (model.view === 'home') {
    if (model.work === 'responding') followResponse = false;
    model.stopPlayback();
    const next = model.page + direction;
    if ((model.reply || model.work === 'responding') && next >= 0 && next < model.pages.length) model.page = next;
    else { browseHistory(direction); return; }
  }
  render();
}
function returnHome() {
  transitionAt = -Infinity;
  if (model.sleeping) { wakeDevice(); return; }
  pendingNotice = null;
  cancelPress('返回主页，未发送输入已丢弃');
  leaveHistory(); model.home(); render();
}
function openConfirmation(action) {
  provisioning.returnView = model.view;
  provisioning.returnIndex = model.menuIndex;
  provisioning.resetTarget = action;
  model.view = 'device-reset'; model.menuIndex = 0;
  render();
}
function menuOK() {
  model.feedback = '';
  if (model.menuOpen) {
    const id = model.menus[model.menuIndex].id;
    if (id === 'cancel') {
      if (!model.canCancelExecution) { feedback('没有当前执行'); return; }
      model.workVersion++; model.work = 'idle'; model.stopPlayback();
      feedback('已请求取消');
      later(() => feedback('已收到取消结果'), 350); return;
    } else if (id === 'home') { returnHome(); return; }
    else if (id === 'back') model.openView(
      model.view === 'maintenance' ? 'connectivity' : 'menu', true);
    else if (id === 'reload') {
      feedback(model.online ? '正在获取配置' : '请先连上 PA 再同步');
      requestConfigReload(); return;
    }
    else if (id === 'retry') {
      if (model.online && provisioning.paired) { feedback('PA 已连接'); return; }
      if (!provisioning.savedWifi) { feedback('请先通过设备热点填写 Wi-Fi'); return; }
      model.view = 'home'; startWifiCycle(); return;
    }
    else if (['reconfigure', 'repair', 'factory'].includes(id)) {
      if (id === 'repair' && !provisioning.rejected) { feedback('仅在配对被拒后可用'); return; }
      if (id === 'reconfigure' && provisioning.stage === 'hotspot') { returnHome(); return; }
      openConfirmation(id); return;
    }
    else if (id === 'keep') { model.keepOnline = !model.keepOnline; savePreferences(); feedback(model.keepOnline ? '自动休眠已关闭' : '空闲后自动休眠'); return; }
    else if (id === 'standby-wifi') {
      model.standbyWifi = !model.standbyWifi; savePreferences();
      feedback(model.standbyWifi ? '熄屏后保持 Wi-Fi' : '熄屏后关 Wi-Fi'); return;
    }
    else if (id === 'sleep') {
      if (!model.canSleep) { feedback('当前交互未结束，暂不休眠'); return; }
      sleepDevice(); return;
    }
    else {
      if (id === 'brightness') brightnessDraft = model.brightness;
      model.openView(id);
      if (id === 'notices') model.noticeIndex = 0;
    }
  } else if (model.view === 'device-reset') {
    if (model.menuIndex === 1) {
      if (provisioning.resetTarget === 'repair') {
        provisioning.rejected = false;
        model.history.clearCache(); model.view = 'home';
        model.network(true); provisioning.issueCode(); provisioning.message = '';
        render(); return;
      }
      if (provisioning.resetTarget === 'factory') {
        provisioning.paired = provisioning.rejected = provisioning.savedWifi = false;
        model.history.clearCache(); model.volume = 45; model.mode = 'steer'; model.keepOnline = false;
        model.standbyWifi = true;
        model.autoSpeak = true; model.speechLimit = 200; model.sleepSeconds = 120; model.voiceRate = 1;
        model.textSize = 16; model.brightness = 65;
        savePreferences();
      }
      startHotspot(); return;
    }
    model.view = provisioning.returnView; model.menuIndex = provisioning.returnIndex;
  } else if (model.view === 'brightness') {
    model.brightness = brightnessDraft;
    savePreferences();
    model.openView('sound', true);
    feedback('亮度已保存');
    return;
  } else if (model.view === 'history') leaveHistory();
  else if (model.view === 'notices') {
    if (model.noticeIndex === model.notices.length) {
      pendingNotice = null;
      model.openView('menu', true);
    } else if (!pendingNotice) {
      const read = { notice: model.notices[model.noticeIndex] };
      pendingNotice = read;
      later(() => {
        if (pendingNotice !== read || model.view !== 'notices') return;
        pendingNotice = null;
        if (!model.online) { feedback('任务读取未发送，请重试'); return; }
        model.activeNotice = read.notice;
        model.activeNotice.read = true;
        model.page = 0;
        model.view = 'notice';
        model.log('任务报告已打开，标记已读');
        render();
      }, 260);
    }
  } else if (model.view === 'notice') {
    model.noticeIndex = Math.max(0, model.notices.indexOf(model.activeNotice));
    model.view = 'notices';
  }
  else model.openView(model.view === 'status' ? 'connectivity' : 'sound', true);
  render();
}
bindHardwareKeys({
  ...hardware, press: pressOK, release: releaseOK, abort: cancelPress, move, home: returnHome,
  canJumpLatest, latest: jumpLatest,
  canStandby: canStandbyFromHome, standby: sleepDevice,
});
document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && !e.target.closest('input,select,textarea')) returnHome();
});
$('interaction-record').addEventListener('toggle', render);
$('scenario-picker').addEventListener('change', event => {
  if (provisioning.stage === 'wifi-trying' || !provisioning.paired) {
    event.target.value = model.scenario;
    return;
  }
  pendingNotice = null;
  cancelPress('切换演示场景');
  leaveHistory();
  model.lastHistoryId = null;
  model.selectScenario(event.target.value);
  render();
});
$('empty-input').addEventListener('click', () => { model.noContentNext = !model.noContentNext; model.failNext = false; render(); });
$('recognition-failure').addEventListener('click', () => { model.failNext = !model.failNext; model.noContentNext = false; render(); });
$('record-limit').addEventListener('click', finishAtLimit);
$('setup-first').addEventListener('click', () => { provisioning.paired = provisioning.savedWifi = provisioning.rejected = false; provisioning.message = ''; startHotspot(); });
$('setup-ready').addEventListener('click', () => {
  cancelWifiCycle();
  cancelPress('恢复已配对演示'); leaveHistory(); model.selectScenario(model.scenario);
  provisioning.version++; provisioning.savedWifi = true; provisioning.rejected = false; provisioning.paired = true; provisioning.stage = 'ready'; provisioning.code = '';
  model.setWifi({ connected: true, ssid: $('setup-ssid').value || 'Home Wi-Fi' }); model.network(true);
  model.clockSynced = true;
  requestConfigReload();
});
$('setup-wifi').addEventListener('submit', event => {
  event.preventDefault();
  if (provisioning.stage !== 'hotspot') return;
  const ssid = $('setup-ssid').value.trim();
  if (!ssid || new TextEncoder().encode(ssid).length > 32) {
    provisioning.message = '请填写有效的 Wi-Fi 名称'; render(); return;
  }
  provisioning.savedWifi = true; appliedWifiNetworks = [{ ssid, password: '', available: true }];
  provisioning.config.networks = appliedWifiNetworks.map(network => ({ ...network }));
  $('setup-password').value = '';
  startWifiCycle();
});
$('setup-pair').addEventListener('submit', event => {
  event.preventDefault();
  if (!model.online || !provisioning.pair($('setup-code').value.trim(), $('setup-name').value.trim())) {
    provisioning.message = '配对失败：确认 PA 在线、数字正确且尚未过期'; render(); return;
  }
  $('setup-code').value = '';
  model.log('模拟绑定设备独立会话，配对码已失效');
  requestConfigReload();
});
$('cloud-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!provisioning.paired) return;
  const networks = wifiDraft.map(network => ({ ...network, ssid: network.ssid.trim() }));
  if (!networks.length || networks.length > 5 || networks.some(network => !network.ssid
    || new TextEncoder().encode(network.ssid).length > 32
    || (network.password && (new TextEncoder().encode(network.password).length < 8 || new TextEncoder().encode(network.password).length > 63)))) {
    provisioning.message = '保存 1～5 套网络；名称不超过 32 字节，密码为空或 8～63 字节'; render(); return;
  }
  provisioning.save({ volume: Number($('cloud-volume').value), mode: $('cloud-mode').value,
    speechMode: $('cloud-speak').value,
    keepOnline: $('cloud-keep').value === 'yes', sleepSeconds: Number($('cloud-sleep').value),
    brightness: Number($('cloud-brightness').value), textSize: Number($('cloud-text').value),
    voice: $('cloud-voice').value, voiceRate: Number($('cloud-rate').value),
    offlineHistory: $('cloud-cache').value === 'yes', showImages: $('cloud-images').value === 'yes', networks }, $('setup-name').value.trim() || '我的 PP');
  provisioning.message = '网络与配对 → PA 与维护 → 同步 PA 设置，或点击下方模拟同步';
  render();
});
$('cloud-reload').addEventListener('click', requestConfigReload);
$('setup-revoke').addEventListener('click', () => {
  if (!provisioning.paired) return;
  cancelWifiCycle();
  cancelPress('撤销模拟设备配对'); leaveHistory(); model.selectScenario(model.scenario);
  provisioning.version++; provisioning.stage = 'revoked'; provisioning.rejected = true;
  provisioning.paired = false; provisioning.code = ''; model.network(false);
  provisioning.message = '旧绑定已撤销，请选择「更换 PA 配对」';
  render();
});
$('wifi-add').addEventListener('click', () => {
  if (wifiDraft.length >= 5) return;
  wifiDraft.push({ ssid: '', password: '', available: true }); renderWifiDraft();
});
$('cloud-networks').addEventListener('input', event => {
  const field = event.target.dataset.wifiField, row = event.target.closest('[data-index]');
  if (!field || !row) return;
  wifiDraft[Number(row.dataset.index)][field] = field === 'available' ? event.target.value === 'yes' : event.target.value;
});
$('cloud-networks').addEventListener('click', event => {
  const button = event.target.closest('[data-wifi-action]');
  if (!button) return;
  const index = Number(button.closest('[data-index]').dataset.index), action = button.dataset.wifiAction;
  if (action === 'remove') {
    if (wifiDraft.length > 1) wifiDraft.splice(index, 1);
  } else {
    const target = index + (action === 'up' ? -1 : 1);
    if (target >= 0 && target < wifiDraft.length) [wifiDraft[index], wifiDraft[target]] = [wifiDraft[target], wifiDraft[index]];
  }
  renderWifiDraft();
});
$('history-cache-clear').addEventListener('click', () => {
  model.history.clearCache();
  if (model.view === 'history') {
    historyView.version++; historyView.loading = false; historyView.record = null;
    historyView.error = '缓存已清空，按 ↑ 在线重新读取';
  }
  model.log('只清空模拟设备缓存，服务端演示历史不删除');
  render();
});
$('network-toggle').addEventListener('click', () => {
  if (model.wifi.connected) {
    cancelPress('网络中断，本次未提交录音已丢弃');
    if (model.view === 'history') { leaveHistory(); model.homeOnly = true; }
    model.feedback = '';
    model.setWifi({ connected: false });
    render();
  } else if (provisioning.paired) startWifiCycle();
  else { model.setWifi({ connected: true }); model.network(true); render(); }
});
$('wifi-name').addEventListener('input', () => { model.setWifi({ ssid:$('wifi-name').value }); render(); });
$('wifi-strength').addEventListener('change', () => {
  const value = $('wifi-strength').value, wasConnected = model.wifi.connected;
  const connected = value !== 'off';
  if (!connected) { cancelPress('Wi-Fi 断开，本次未提交录音已丢弃'); }
  model.setWifi({ connected, rssi: ({strong:-52,medium:-67,weak:-82})[value] ?? model.wifi.rssi });
  if (connected && !wasConnected && !model.sleeping) model.network(paAvailable);
  render();
});
$('battery-level').addEventListener('input', () => { model.batteryLevel = Number($('battery-level').value); render(); });
$('pa-state').addEventListener('change', () => {
  const online = $('pa-state').value === 'online';
  paAvailable = online;
  if (!online) cancelPress('PA 连接中断，本次未提交录音已丢弃');
  if (!model.sleeping) model.network(online);
  render();
});
$('clock-synced').addEventListener('change', () => { model.clockSynced = $('clock-synced').checked; render(); });
$('task-complete').addEventListener('click', () => { model.backgroundComplete(); render(); });
let speechTickAt = performance.now();
let syncWasOnline = model.online;
setInterval(() => {
  const now = performance.now(), seconds = Math.min(.5, (now - speechTickAt) / 1000);
  speechTickAt = now;
  if (model.advanceSpeech(seconds)) render();
  if (model.queue.length) {
    const next = model.nextQueued();
    if (next) startWork(next);
  }
  const reconnected = model.online && !syncWasOnline;
  syncWasOnline = model.online;
  if (provisioning.paired && reconnected) requestConfigReload();
  else if (provisioning.paired && provisioning.reloadPending && model.view !== 'brightness' &&
    model.input === 'idle' && !model.playing && !['processing', 'responding'].includes(model.work)) requestConfigReload();
  else if (!provisioning.paired && !provisioning.rejected && provisioning.stage === 'unreachable' && reconnected && !$('setup-fail').checked) { provisioning.issueCode(); provisioning.message = ''; render(); }
  renderScreen();
}, 250);
let lastActivity = Date.now();
['pointerdown','keydown'].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }));
setInterval(() => {
  if (!provisioning.paired && provisioning.stage === 'pairing') render();
  if (provisioning.paired && provisioning.stage === 'ready' && !model.keepOnline && !model.sleeping && !pressed && model.canSleep && Date.now()-lastActivity >= model.sleepSeconds * 1000) sleepDevice();
}, 1000);
$('cloud-volume').value = String(model.volume);
$('cloud-mode').value = model.mode;
$('cloud-keep').value = model.keepOnline ? 'yes' : 'no';
renderWifiDraft();
render();
