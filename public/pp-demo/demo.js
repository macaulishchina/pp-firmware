import { PassportModel } from './model.js';
import { PP_PROFILE } from './core/profile.js';
import { mountDeviceShell } from './core/device-shell.js';
import { bindHardwareKeys } from './core/keys.js';
import { renderStatusBar, updateClock, wifiStrength, updateVolumeStatus } from './core/status.js';
import { voiceMarkup, updateVoice, demoVoiceLevel } from './core/voice.js';
import { DemoProvisioning } from './core/provisioning.js';

const $ = id => document.getElementById(id);
const hardware = mountDeviceShell($('device-host'));
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('pp-demo.preferences.v1') || '{}') || {}; } catch {}
const model = new PassportModel(preferences);
const provisioning = new DemoProvisioning(model.volume, model.mode);
provisioning.config.keepOnline = model.keepOnline;
const { interaction, simulation } = PP_PROFILE;
const imageMarkup = image => `<figure class="reply-image"><img src="${escape(image.src)}" alt="${escape(image.alt)}"><figcaption>${escape(image.alt)} · 缩略图</figcaption></figure>`;
document.querySelector('.scenarios').innerHTML = Object.values(model.catalog).map((scene,i) => `
  <button class="scenario${i === 0 ? ' is-selected' : ''}" data-scenario="${escape(scene.id)}" aria-pressed="${i === 0}">
    <span class="scenario-symbol">${escape(scene.symbol)}</span><span><strong>${escape(scene.title)}</strong><small>${escape(scene.description)}</small></span>
  </button>`).join('');
const timers = new Set();
let pressed = false, pressStarted = 0, holdTimer = null, clickTimer = null, wakeGuard = false, stoppedOnPress = false;
let recordInterval = null, feedbackTimer = null;
let volumeToastTimer = null, volumeSaveTimer = null;
let followResponse = true;
let renderedContentMarkup = null;
let wifiDraft = provisioning.config.networks.map(network => ({ ...network }));
let appliedWifiNetworks = wifiDraft.map(network => ({ ...network }));
let wifiCycleVersion = 0;
let wifiAttempt = null;
let wifiAttempts = [];
function renderWifiDraft() {
  $('cloud-networks').innerHTML = wifiDraft.map((network, index) => `<div class="wifi-profile" data-index="${index}">
    <div class="wifi-profile-heading"><strong>${index + 1}</strong><span>连接优先级 ${index + 1}</span><div><button type="button" data-wifi-action="up" aria-label="上移网络" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-wifi-action="down" aria-label="下移网络" ${index === wifiDraft.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-wifi-action="remove" ${wifiDraft.length === 1 ? 'disabled' : ''}>移除</button></div></div>
    <div class="setup-grid"><label>Wi-Fi 名称<input data-wifi-field="ssid" value="${escape(network.ssid)}" maxlength="32" required></label><label>密码<input data-wifi-field="password" type="password" value="${escape(network.password)}" maxlength="63" autocomplete="off" placeholder="空白表示开放网络"></label></div>
    <label>连接结果（仅演示）<select data-wifi-field="available"><option value="yes" ${network.available ? 'selected' : ''}>可连接</option><option value="no" ${network.available ? '' : 'selected'}>模拟失败</option></select></label>
  </div>`).join('');
  $('wifi-add').disabled = wifiDraft.length >= 5;
}
function startWifiCycle() {
  const version = ++wifiCycleVersion;
  const networks = appliedWifiNetworks.map(network => ({ ...network }));
  model.stopPlayback(); provisioning.stage = 'wifi-trying'; provisioning.message = '';
  model.setWifi({ connected: false }); model.network(false);
  wifiAttempts = [];
  const attempt = (round, index) => {
    if (version !== wifiCycleVersion) return;
    const network = networks[index];
    wifiAttempt = { round, index, total: networks.length, ssid: network.ssid };
    const entry = { round, index, ssid: network.ssid, status: '连接中' };
    wifiAttempts.push(entry); render();
    later(() => {
      if (version !== wifiCycleVersion) return;
      if (wifiDraft.find(candidate => candidate.ssid === network.ssid)?.available ?? network.available) {
        entry.status = '已连接';
        model.setWifi({ connected: true, ssid: network.ssid }); model.network(true);
        provisioning.stage = 'ready'; provisioning.message = `已连接 ${network.ssid}，停止后续尝试`;
        model.log(`Wi-Fi 第 ${round}/3 轮第 ${index + 1} 个网络连接成功，本轮结束`);
        render(); return;
      }
      entry.status = '失败';
      model.log(`Wi-Fi 第 ${round}/3 轮第 ${index + 1} 个网络失败，按顺序继续`);
      if (index + 1 < networks.length) attempt(round, index + 1);
      else if (round < 3) attempt(round + 1, 0);
      else {
        provisioning.stage = 'wifi-exhausted'; provisioning.message = '已尝试 3 轮，停止自动重试；可按 OK 重试或重新配网';
        render();
      }
    }, 850);
  };
  if (networks.length) attempt(1, 0);
}
function startHotspot() {
  wifiCycleVersion++;
  cancelPress('进入配网，未提交录音已丢弃');
  leaveHistory(); model.selectScenario(model.scenario);
  provisioning.hotspot(); model.setWifi({ connected: false }); model.network(false);
  model.clockSynced = false;
  $('setup-code').value = ''; $('setup-password').value = '';
  model.log('模拟设备热点：手机填写初始 Wi-Fi 与 PA 地址，不经过 USB');
  render();
}
function requestConfigReload() {
  if (provisioning.stage === 'wifi-trying') { provisioning.message = '正在按顺序连接网络，请稍候'; render(); return; }
  if (!provisioning.paired) { provisioning.message = '请先完成设备配对'; render(); return; }
  if (!model.online) { provisioning.message = '设备离线，保留本地配置；联网后同步'; render(); return; }
  if (model.input !== 'idle' || model.playing || ['processing', 'responding'].includes(model.work)) {
    provisioning.reloadPending = true;
    provisioning.sync = '等待本次交互结束后重载'; render(); return;
  }
  const config = provisioning.config;
  provisioning.reloadPending = false;
  Object.assign(model, { volume: config.volume, mode: config.mode, autoSpeak: config.speechMode !== 'off',
    speechLimit: config.speechMode === 'full' ? Infinity : 200, keepOnline: config.keepOnline, sleepSeconds: config.sleepSeconds,
    voiceRate: config.voiceRate });
  model.history.setEnabled(config.offlineHistory);
  hardware.screen.style.setProperty('--reading-size', `${config.textSize}px`);
  hardware.screen.style.setProperty('--screen-dim', String((100 - config.brightness) / 150));
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
  $('mode-badge').hidden = !provisioning.paired;
  const status = provisioning.paired ? `${provisioning.name} · ${provisioning.sync}`
    : { hotspot: '等待手机配置初始 Wi-Fi', 'wifi-connecting': '正在连接 Wi-Fi 与 PA…', pairing: '等待在 PA 后台输入屏幕上的 8 位码', unreachable: 'PA 无法连接，可重新配网或恢复模拟网络' }[provisioning.stage];
  $('setup-state').textContent = `${status}${provisioning.message ? ` · ${provisioning.message}` : ''}`;
  $('wifi-attempts').innerHTML = wifiAttempts.map(entry => `<li>第 ${entry.round}/3 轮 · ${entry.index + 1}. ${escape(entry.ssid)} · ${entry.status}</li>`).join('');
}
const historyView = { id: null, record: null, page: 0, loading: false, error: '', source: '', version: 0 };
function leaveHistory() {
  historyView.version++;
  historyView.loading = false; historyView.record = null; historyView.error = '';
  model.view = 'home';
}
function openHistoryRecord(id, position = 'last') {
  if (!id) { feedback('已经是最早的记录'); return; }
  const version = ++historyView.version;
  Object.assign(historyView, { id, record: null, page: 0, error: '', loading: false, source: '' });
  model.stopPlayback(); model.homeOnly = false; model.view = 'history';
  const show = (record, source) => {
    historyView.record = record; historyView.source = source;
    const parts = model.history.pages(record, PP_PROFILE.pageCharacters);
    historyView.page = position === 'last' ? parts.length - 1 : position === 'input'
      ? Math.max(0, parts.findIndex(part => part.role === '回复') - 1) : 0;
    render();
  };
  const cached = model.history.cached(id);
  if (cached) { show(cached, '本地缓存'); return; }
  if (!model.online) { historyView.error = '这段对话未缓存，联网后按 ↑ 重试'; render(); return; }
  historyView.loading = true; render();
  later(() => {
    if (version !== historyView.version || model.view !== 'history') return;
    historyView.loading = false;
    if (!model.online) { historyView.error = '连接已断开，联网后按 ↑ 重试'; render(); return; }
    const record = model.history.read(id);
    if (!record) { historyView.error = '这段对话已不可用，按 ↓ 返回'; render(); return; }
    const cached = model.history.remember(record);
    model.log('模拟按游标读取一段历史，缓存有界；查看不会重新执行');
    show(record, cached ? '在线读取 · 已缓存' : '在线读取');
  }, 650);
}
function browseHistory(direction) {
  model.stopPlayback();
  if (historyView.loading) {
    if (direction > 0) { leaveHistory(); render(); }
    return;
  }
  if (model.view !== 'history') {
    if (model.homeOnly && model.work === 'clarifying') {
      model.homeOnly = false; model.view = 'home'; render(); return;
    }
    if (model.homeOnly) { openHistoryRecord(model.lastHistoryId || model.history.latestId, 'last'); return; }
    if (direction > 0) { feedback('已经是最新对话'); return; }
    openHistoryRecord(model.lastHistoryId || model.history.latestId, model.lastHistoryId ? 'input' : 'last');
    return;
  }
  if (historyView.error) {
    if (direction < 0) openHistoryRecord(historyView.id);
    else { leaveHistory(); render(); }
    return;
  }
  const parts = model.history.pages(historyView.record, PP_PROFILE.pageCharacters);
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
    else feedback('已经是最早的记录');
    return;
  }
  openHistoryRecord(nextId, direction < 0 ? 'last' : 'first');
}
const pages = () => `<span>${model.page + 1} / ${model.pages.length}</span>`;
function later(fn, delay) { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; }
function savePreferences() {
  try { localStorage.setItem('pp-demo.preferences.v1', JSON.stringify({ mode:model.mode, volume:model.volume, keepOnline:model.keepOnline })); } catch {}
}
function adjustVolume(delta, showToast = false) {
  model.volume = Math.max(0, Math.min(100, model.volume + delta));
  updateVolumeStatus(hardware.screen, model.volume);
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(savePreferences, 450);
  if (showToast) {
    $('volume-toast-value').textContent = String(model.volume);
    $('volume-toast-fill').style.width = `${model.volume}%`;
    $('volume-toast').hidden = false;
    clearTimeout(volumeToastTimer);
    volumeToastTimer = setTimeout(() => { $('volume-toast').hidden = true; }, 1400);
  }
}
function stopRecordClock() { clearInterval(recordInterval); recordInterval = null; }
function feedback(text) {
  model.feedback = text; clearTimeout(feedbackTimer); render();
  feedbackTimer = later(() => { model.feedback = ''; render(); }, 2600);
}
function updateInputText(content, phase = model.phase) {
  const transcript = content.querySelector('.live-transcript');
  if (!transcript) return;
  transcript.textContent = phase === 'processing' ? model.submittedPrompt
    : phase === 'idle' ? ''
    : Array.from(model.prompt).slice(0, Math.floor(model.elapsed * 7)).join('');
  const region = content.querySelector('.live-input');
  if (region) {
    // Fit complete line boxes so following the transcript never clips the first line.
    const lineHeight = Math.round(parseFloat(getComputedStyle(region).fontSize) * 1.65);
    const available = region.parentElement.clientHeight - region.offsetTop - 8;
    const rows = Math.max(1, Math.floor(available / lineHeight));
    region.style.lineHeight = `${lineHeight}px`;
    region.style.height = `${rows * lineHeight}px`;
    region.scrollTop = region.scrollHeight;
  }
}
function render() {
  const phase = !provisioning.paired || ['wifi-trying', 'wifi-exhausted'].includes(provisioning.stage) ? provisioning.stage : model.phase, content = $('screen-content');
  let html = '', hint = '按住 OK 说话', page = '';
  const responseState = model.work === 'responding'
    ? model.playing ? '生成中 · 播报中' : model.speech.muted ? '生成中 · 已停播' : '正在生成'
    : model.playing ? '正在播报' : model.speech.limited ? '余下见文字' : model.work === 'clarifying' ? '等你回答' : '';
  $('screen').dataset.phase = phase;
  $('screen').classList.toggle('sleep', phase === 'sleeping');
  renderStatusBar(hardware.screen, { wifi: model.wifi, paOnline: model.online,
    batteryLevel: model.batteryLevel, clockSynced: model.clockSynced, volume: model.volume });
  if (!model.playing) $('volume-toast').hidden = true;
  $('mode-badge').dataset.mode = model.mode;
  $('mode-badge').setAttribute('aria-label', `当前${model.mode === 'steer' ? '直接引导' : '排队'}，双击 OK 切换`);
  $('mode-note').innerHTML = `<span class="mode-icon">${model.mode === 'steer' ? '↳' : '≋'}</span><span><strong>当前：${model.mode === 'steer' ? '直接引导' : '排队'}</strong><small>${model.mode === 'steer' ? '执行中再说话，会补充或调整当前执行。' : '执行中再说话，会在当前执行结束后处理。'}</small></span>`;
  const unread = model.notices.filter(n => !n.read).length;
  const notices = unread ? `<p class="screen-small center">${unread} 条任务消息待查看</p>` : '';
  const presence = voiceMarkup();
  const voiceStage = ['idle','recording','finalizing','processing'].includes(phase);
  const voiceScene = `<div class="home-content voice-scene">${presence}<div class="input-origin">你说的</div><div class="live-input" aria-label="输入转写"><span class="live-transcript"></span><span class="live-cursor" aria-hidden="true"></span></div><div class="ambient-notices">${notices}</div></div>`;
  if (phase === 'wifi-trying') {
    html = `<div class="setup-screen"><h3>正在连接 Wi-Fi</h3><p>第 ${wifiAttempt.round} / 3 轮 · 网络 ${wifiAttempt.index + 1} / ${wifiAttempt.total}</p><dl><dt>当前尝试</dt><dd>${escape(wifiAttempt.ssid)}</dd></dl><p>失败后尝试下一个<br>本轮结束后从第一套重新尝试</p></div>`;
    hint = '连接成功即停止尝试';
  } else if (phase === 'wifi-exhausted') {
    html = `<div class="setup-screen"><h3>暂时无法连接</h3><p>已按顺序尝试 3 轮<br>所有网络均连接失败</p><p>设置和配对已保留<br>按 OK 再尝试 3 轮<br>需要改网络时可进入重新配网</p></div>`;
    hint = 'OK 重试 · ↓ 重新配网';
  } else if (phase === 'hotspot') {
    html = `<div class="setup-screen"><h3>连接设备热点</h3><p>手机连接以下 Wi-Fi</p><dl><dt>热点</dt><dd>PP-7C42</dd><dt>密码</dt><dd>ppdemo88</dd><dt>浏览器打开</dt><dd>192.168.4.1</dd></dl><p>填写初始 Wi-Fi 和 PA 地址</p></div>`;
    hint = '在右侧模拟手机配网';
  } else if (phase === 'wifi-connecting') {
    html = `<div class="setup-screen"><h3>正在连接</h3><p>${escape(model.wifi.ssid)}</p><p>正在连接 Wi-Fi 与 PA<br>请稍候…</p></div>`;
    hint = '连接成功后显示配对码';
  } else if (phase === 'pairing') {
    const valid = Date.now() < provisioning.expires;
    html = `<div class="setup-screen pairing-screen"><h3>配对 PA</h3><p>在 PA 后台输入以下数字</p><div class="pairing-code">${valid ? provisioning.code : '已过期'}</div><p>${valid ? `${Math.ceil((provisioning.expires - Date.now()) / 60000)} 分钟内有效 · 仅使用一次` : '按 OK 生成新的配对码'}</p><p class="setup-endpoint">${escape(provisioning.address)}</p></div>`;
    hint = 'OK 刷新配对码';
  } else if (phase === 'unreachable') {
    html = `<div class="setup-screen"><h3>连接暂时不可用</h3><p>已保留网络设置<br>恢复网络后重新获取配对码</p></div>`;
    hint = 'OK 重试 · 可重新配网';
  } else if (phase === 'idle') {
    html = voiceScene;
    hint = model.feedback || (model.playing ? '↑↓ 音量 · OK 停播' : 'OK 菜单 · 按住说话');
  } else if (phase === 'recording') {
    html = voiceScene;
    hint = '正在听 · 松开结束';
    page = `${model.elapsed.toFixed(1)}s`;
  } else if (phase === 'finalizing') {
    html = voiceScene;
    hint = '收音已停 · 识别中';
  } else if (phase === 'processing') {
    html = voiceScene;
    hint = model.queue.length ? `已发送 · ${model.queue.length} 句排队` : '已发送 · 等待回复';
  } else if (phase === 'input-review') {
    const choices = ['丢弃本次输入', '发送已识别文字', '查看完整转写'];
    html = `<div class="menu-heading">输入尚未发送</div><p class="screen-small">达到录音上限，已停止收音。</p><ul class="menu-list">${choices.map((choice, i) => `<li class="${model.menuIndex === i ? 'selected' : ''}">${choice}</li>`).join('')}</ul>`;
    hint = '↑↓ 选择 · OK 确认';
  } else if (phase === 'input-review-text') {
    html = `<div class="response-content"><div class="response-origin">你说的 · 待发送</div><div class="response-body screen-text">${escape(model.reviewPages[model.page] || '')}</div></div>`;
    hint = '↑↓ 全文 · OK 返回'; page = `${model.page + 1}/${model.reviewPages.length}`;
  } else if (['responding', 'playing', 'reply', 'clarifying'].includes(phase)) {
    html = `<div class="response-content"><div class="response-origin"><span class="reply-symbol" aria-hidden="true">↳</span> 回复<span class="response-state">${responseState}</span></div><div class="response-body">${model.pageImage ? imageMarkup(model.pageImage) : `<span class="screen-text">${escape(model.pages[model.page] || '')}</span>`}${phase === 'responding' ? '<span class="reply-cursor" aria-hidden="true"></span>' : ''}</div><div class="screen-track speech-track" id="speech-track" ${model.playing ? '' : 'hidden'}><i id="play-progress"></i></div></div>`;
    hint = model.playing ? '↑↓ 音量 · OK 停播' : phase === 'responding' ? '逐字回复 · 按住可补充' : phase === 'clarifying' ? '按住 OK 回答' : '↑↓ 浏览对话 · OK 菜单';
    page = model.pages.length > 1 ? pages() : '';
  } else if (['menu', 'settings', 'maintenance'].includes(phase)) {
    model.menuIndex = Math.min(model.menuIndex, model.menus.length - 1);
    const start = Math.max(0, Math.min(model.menuIndex - 2, model.menus.length - 5));
    html = `<div class="menu-heading">${phase === 'menu' ? '操作菜单' : phase === 'settings' ? '设置' : '设备维护'}</div><ul class="menu-list">${model.menus.slice(start,start+5).map((item,i)=>`<li class="${start+i === model.menuIndex ? 'selected' : ''}">${escape(item.label)}<span>${escape(item.value)}</span></li>`).join('')}</ul>`;
    hint = model.feedback || 'OK 确认 · 长↑ 主页'; page = `${model.menuIndex+1}/${model.menus.length}`;
  } else if (phase === 'volume') {
    html = `<h3 class="screen-title">音量</h3><div class="volume-value">${model.volume}<span class="screen-small"> %</span></div><div class="volume-track"><i style="width:${model.volume}%"></i></div><p class="screen-small">仅模拟音量设置</p>`;
    hint = '↑↓ 调整 · OK 返回';
  } else if (phase === 'notices') {
    html = `<div class="menu-heading task-heading">任务消息</div>${!model.notices.length ? '<p class="screen-small">暂无任务消息</p>' : ''}<ul class="menu-list task-list">${model.notices.map((n,i)=>`<li class="${i === model.noticeIndex ? 'selected' : ''}">${n.read ? '' : '· '}${escape(n.title)}</li>`).join('')}<li class="${model.noticeIndex === model.notices.length ? 'selected' : ''}">返回菜单</li></ul>`;
    hint = 'OK 查看 · 长↑ 主页';
  } else if (phase === 'notice') {
    html = `<div class="response-content task-content"><div class="response-origin"><span class="task-type">任务报告</span><span class="task-label">${escape(model.activeNotice?.title || '')}</span></div><div class="response-body"><span class="screen-text">${escape(model.pages[model.page] || '')}</span></div></div>`;
    hint = 'OK 返回列表 · 长↑ 主页'; page = pages();
  } else if (phase === 'history') {
    if (historyView.record) {
      const parts = model.history.pages(historyView.record, PP_PROFILE.pageCharacters), part = parts[historyView.page];
      html = `<div class="response-content"><div class="response-origin"><span>${part.role}</span><span class="response-state">${escape(historyView.source)}</span></div><div class="response-body">${part.image ? imageMarkup(part.image) : `<span class="screen-text">${escape(part.text)}</span>`}</div></div>`;
      page = `${historyView.page + 1}/${parts.length}`;
    } else html = `<div class="response-content"><div class="response-origin">历史对话</div><p class="history-message">${historyView.loading ? '正在读取更早的对话…' : escape(historyView.error)}</p></div>`;
    hint = '↑↓ 浏览对话 · OK 最新';
  } else if (phase === 'status') {
    const strength = wifiStrength(model.wifi.rssi);
    const rssi = Number.isFinite(model.wifi.rssi) ? `${model.wifi.rssi} dBm` : '未知';
    html = `<h3 class="screen-title">连接详情</h3><dl class="network-details"><div><dt>Wi-Fi</dt><dd>${escape(model.wifi.connected ? model.wifi.ssid || '名称未知' : '未连接')}</dd></div><div><dt>信号</dt><dd>${model.wifi.connected ? `${strength.label} · ${rssi}` : '—'}</dd></div><div><dt>PA</dt><dd>${model.online ? '已连接' : '不可达'} · 8047</dd></div></dl>`;
    hint = 'OK 返回菜单';
  } else if (phase === 'cancel') {
    html = `<h3 class="screen-title">取消当前执行？</h3><p class="screen-small">停止尚未发出的动作。已经发生的操作，需要核对结果。</p><ul class="menu-list" style="margin-top:8px"><li class="${model.menuIndex === 0 ? 'selected' : ''}">返回，不取消</li><li class="${model.menuIndex === 1 ? 'selected' : ''}">确认取消</li></ul>`;
    hint = '↑↓ 选择 · OK 确认';
  } else if (phase === 'device-reset') {
    html = `<h3 class="screen-title">${provisioning.resetTarget === 'factory' ? '恢复出厂？' : '重新配网？'}</h3><p class="screen-small">${provisioning.resetTarget === 'factory' ? '清除设备绑定、网络和本地缓存。PA 的历史记录保留。' : '进入热点配网，PA 历史记录保留。'}</p><ul class="menu-list"><li class="${model.menuIndex === 0 ? 'selected' : ''}">返回</li><li class="${model.menuIndex === 1 ? 'selected' : ''}">确认</li></ul>`;
    hint = '↑↓ 选择 · OK 确认';
  } else if (phase === 'error') {
    html = `<div class="error-icon" aria-hidden="true">!</div><h3 class="screen-title screen-error">${escape(model.error)}</h3><p class="screen-small">这句话没有提交执行。<br>录音已停止，可以重新说。</p>`;
    hint = '重新按住 OK 说话';
  } else if (phase === 'offline') {
    html = `<h3 class="screen-title">${model.wifi.connected ? 'PA 暂时不可达' : 'Wi-Fi 未连接'}</h3><p class="screen-small">未完成的录音不会发送。<br>已经接受的任务继续执行。<br><br>恢复连接后同步结果。</p>`;
    hint = 'OK 菜单 · 右侧恢复网络';
  } else if (phase === 'sleeping') {
    html = `${presence}<p class="screen-small">休息一下</p>${notices}`;
    hint = '轻按任意键唤醒';
  }
  const preserveScene = voiceStage && content.querySelector('.voice-scene');
  const preserveResponse = phase === 'responding' && content.dataset.responseVersion === String(model.workVersion) && content.querySelector('.reply-cursor');
  if (preserveResponse) {
    content.querySelector('.screen-text').textContent = model.pages[model.page] || '';
    content.querySelector('.response-state').textContent = responseState;
    content.querySelector('#speech-track').hidden = !model.playing;
  } else if (!preserveScene && renderedContentMarkup !== html) {
    content.innerHTML = html;
    renderedContentMarkup = html;
    content.dataset.responseVersion = phase === 'responding' ? String(model.workVersion) : '';
    if (voiceStage && phase !== 'idle') {
      const scene = content.querySelector('.voice-scene');
      scene.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => scene.classList.remove('entering')));
    }
  }
  if (voiceStage) {
    updateInputText(content, phase);
    const notice = content.querySelector('.ambient-notices');
    if (notice) notice.innerHTML = notices;
    if (phase !== 'recording') updateVoice(content, 0);
  }
  if (phase === 'recording') updateVoice(content, demoVoiceLevel(model.elapsed));
  $('screen-hint').textContent = hint;
  $('page-number').innerHTML = page;
  $('stage-status').textContent = model.feedback || (phase.startsWith('history') ? '历史查看 · 本地有限缓存，在线按需读取，不重新执行' : phase === 'responding' && model.playing ? '边生成边模拟播报 · 短按停止声音，文字继续' : {idle:'就绪，等你开口',recording:'正在收音 · 松开立即停止',finalizing:'收音已停 · 等待最终转写',processing:'执行中 · 可以继续补充',responding:'模拟逐字回复 · 等待完整句后播报',playing:'模拟播报中 · 短按可停止',reply:'回复已交付 · 全文可翻页',clarifying:'等你补充信息',menu:'操作菜单',settings:'设备设置',maintenance:'设备维护',volume:'音量设置',notices:'任务消息',notice:'查看任务报告',status:'查看连接状态',cancel:'确认取消',error:'本次未执行 · 可重新说话',offline:'离线 · 不重放已接受的任务',sleeping:'休眠 · 后台任务继续'}[phase] || phase);
  $('stage-dot').className = phase === 'error' ? 'error' : phase === 'offline' ? 'offline' : '';
  $('utterance').textContent = model.prompt;
  $('network-toggle').textContent = model.wifi.connected ? '模拟断网' : '恢复网络';
  if ($('wifi-name').value !== model.wifi.ssid) $('wifi-name').value = model.wifi.ssid;
  $('wifi-strength').value = model.wifi.connected ? ({ 3:'strong', 2:'medium', 1:'weak' }[wifiStrength(model.wifi.rssi).level] || 'weak') : 'off';
  $('battery-level').value = model.batteryLevel;
  $('battery-value').textContent = `${model.batteryLevel}%`;
  $('pa-state').value = model.online ? 'online' : 'offline';
  $('pa-state').disabled = !model.wifi.connected;
  $('clock-synced').checked = model.clockSynced;
  $('recognition-failure').setAttribute('aria-pressed', String(model.failNext));
  $('recognition-failure').textContent = model.failNext ? '下次识别会失败 ✓' : '让下次识别失败';
  $('task-complete').disabled = !model.backgroundPending;
  $('history-cache-status').textContent = model.history.enabled
    ? `已缓存 ${model.history.cache.size} 条 · ${(model.history.bytes / 1024).toFixed(1)} KiB。未缓存内容在线读取。容量仅为 Demo 参考，真机按实测确定。`
    : '离线历史已关闭，不保留历史缓存；联网时仍可按 ↑↓ 查询。';
  $('history-cache-clear').disabled = !model.history.cache.size;
  $('fault-note').textContent = model.backgroundPending ? '后台任务已接受。点“模拟任务完成”，体验结果到达与查看。' : model.failNext ? '下一次松开发送后会模拟识别失败，不创建任何执行。' : '失败的录音不会提交；恢复后可以重新按住说话。';
  $('event-count').textContent = `${model.events.length} 步`;
  $('event-log').innerHTML = model.events.map(e=>`<li><time>${escape(e.at)}</time>${escape(e.text)}</li>`).join('');
  renderProvisioning();
  if (phase === 'wifi-trying') $('stage-status').textContent = `连接 Wi-Fi · 第 ${wifiAttempt.round}/3 轮，第 ${wifiAttempt.index + 1}/${wifiAttempt.total} 套`;
  if (phase === 'wifi-exhausted') $('stage-status').textContent = '3 轮均失败 · 已停止自动重试';
  if (!provisioning.paired) $('stage-status').textContent = $('setup-state').textContent;
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
      if (followResponse) model.page = model.pages.length - 1;
      render();
      if (count < characters.length) { later(reveal, 80); return; }
      const deliveredPage = model.page;
      if (!model.completeWork(job.version, job.input)) return;
      model.page = deliveredPage;
      render();
    };
    reveal();
  }, simulation.executionMs);
}
function pressOK() {
  if (pressed) return;
  pressed = true; pressStarted = performance.now(); $('key-ok').classList.add('pressed');
  if (['wifi-trying', 'wifi-exhausted'].includes(provisioning.stage)) {
    wakeGuard = true;
    if (provisioning.stage === 'wifi-exhausted') startWifiCycle();
    return;
  }
  if (!provisioning.paired) {
    wakeGuard = true;
    if (['pairing', 'unreachable'].includes(provisioning.stage) && model.online) provisioning.issueCode();
    render(); return;
  }
  if (model.sleeping) { model.wake(); wakeGuard = true; render(); return; }
  if (model.input === 'review') {
    wakeGuard = true;
    if (model.view === 'input-review-text') { model.view = 'home'; model.page = model.menuIndex = 0; }
    else if (model.menuIndex === 2) { model.view = 'input-review-text'; model.page = 0; }
    else { startWork(model.confirmInput(model.menuIndex === 1)); }
    render(); return;
  }
  if (model.view === 'history') { leaveHistory(); wakeGuard = true; render(); return; }
  if (model.view !== 'home') return;
  if (!model.online) { feedback('暂时离线，恢复后再说'); return; }
  if (model.input !== 'idle') { feedback('上一句正在确认，还没有重新收音'); return; }
  stoppedOnPress = model.stopPlayback();
  if (stoppedOnPress) { render(); }
  holdTimer = later(() => {
    clearTimeout(clickTimer); clickTimer = null;
    if (!pressed) return;
    if (model.startInput() === null) return;
    render();
    recordInterval = setInterval(() => {
      model.elapsed = (performance.now() - pressStarted) / 1000;
      if (model.phase === 'recording') {
        const content = $('screen-content');
        $('page-number').textContent = `${model.elapsed.toFixed(1)}s`;
        updateInputText(content, 'recording');
        updateVoice(content, demoVoiceLevel(model.elapsed));
      }
      if (model.elapsed >= interaction.maxRecordingSeconds) finishAtLimit();
    }, 100);
  }, interaction.holdMs);
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
  pressed = false; $('key-ok').classList.remove('pressed'); clearTimeout(holdTimer);
  if (wakeGuard) { wakeGuard = false; return; }
  if (model.view !== 'home') { menuOK(); return; }
  if (model.input === 'recording') {
    stopRecordClock();
    const version = model.releaseInput(); render();
    later(() => startWork(model.finishInput(version)), simulation.recognitionMs);
    stoppedOnPress = false;
    return;
  }
  if (model.input !== 'idle') return;
  if (stoppedOnPress) { stoppedOnPress = false; return; }
  if (performance.now() - pressStarted >= interaction.holdMs) return;
  if (clickTimer) {
    clearTimeout(clickTimer); clickTimer = null;
    model.toggleMode(); savePreferences(); feedback(model.feedback);
  } else clickTimer = later(() => {
    clickTimer = null; model.stopPlayback(); model.view = 'menu'; model.menuIndex = 0; render();
  }, interaction.doubleMs);
}
function cancelPress(reason) {
  pressed = false; wakeGuard = false; stoppedOnPress = false;
  $('key-ok').classList.remove('pressed'); clearTimeout(holdTimer); clearTimeout(clickTimer); clickTimer = null;
  const interrupted = model.input !== 'idle';
  stopRecordClock(); model.discardInput(reason); render();
  if (interrupted) {
    const queued = model.nextQueued();
    if (queued) startWork(queued);
  }
}
function move(direction) {
  if (provisioning.stage === 'wifi-trying') return;
  if (provisioning.stage === 'wifi-exhausted') {
    if (direction > 0) { model.view = 'device-reset'; model.menuIndex = 0; provisioning.resetTarget = 'wifi'; provisioning.stage = 'ready'; render(); }
    return;
  }
  if (!provisioning.paired) return;
  if (model.sleeping) { model.wake(); render(); return; }
  if (model.input === 'review') {
    if (model.view === 'input-review-text') model.page = Math.max(0, Math.min(model.reviewPages.length - 1, model.page + direction));
    else model.menuIndex = (model.menuIndex + direction + 3) % 3;
    render(); return;
  }
  if (model.input !== 'idle') { feedback('先松开 OK，结束这次输入'); return; }
  if (model.playing && model.view === 'home') { adjustVolume(direction * -5, true); return; }
  if (['menu', 'settings', 'maintenance'].includes(model.view)) model.menuIndex = (model.menuIndex + direction + model.menus.length) % model.menus.length;
  else if (model.view === 'history') { browseHistory(direction); return; }
  else if (['cancel', 'device-reset'].includes(model.view)) model.menuIndex = 1 - model.menuIndex;
  else if (model.view === 'volume') adjustVolume(direction * -5);
  else if (model.view === 'notices') model.noticeIndex = (model.noticeIndex + direction + model.notices.length + 1) % (model.notices.length + 1);
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
  if (!provisioning.paired || provisioning.stage !== 'ready') return;
  cancelPress('返回主页，未发送输入已丢弃');
  leaveHistory(); model.home(); render();
}
function menuOK() {
  if (['menu', 'settings', 'maintenance'].includes(model.view)) {
    const id = model.menus[model.menuIndex].id;
    if (id === 'cancel') {
      if (!['processing', 'responding'].includes(model.work)) { feedback('没有正在执行的前台请求'); return; }
      model.workVersion++; model.work = 'idle'; model.stopPlayback();
      feedback('当前执行已取消，已接受的排队输入保留'); return;
    } else if (id === 'home') { returnHome(); return; }
    else if (id === 'back') model.view = model.view === 'maintenance' ? 'settings' : 'menu';
    else if (id === 'reload') { requestConfigReload(); return; }
    else if (id === 'retry') { startWifiCycle(); return; }
    else if (id === 'reconfigure' || id === 'factory') { provisioning.resetTarget = id === 'factory' ? 'factory' : 'wifi'; model.view = 'device-reset'; }
    else if (id === 'keep') { model.keepOnline = !model.keepOnline; savePreferences(); feedback(model.keepOnline ? '已保持在线' : '空闲后自动休眠'); return; }
    else if (id === 'sleep') model.sleep();
    else { model.view = id; if (id === 'notices') model.noticeIndex = 0; }
    model.menuIndex = 0;
  } else if (model.view === 'device-reset') {
    if (model.menuIndex === 1) {
      if (provisioning.resetTarget === 'factory') {
        model.history.clearCache(); model.volume = 65; model.mode = 'steer'; model.keepOnline = true;
        model.autoSpeak = true; model.speechLimit = 200; model.sleepSeconds = 120; model.voiceRate = 1;
        hardware.screen.style.removeProperty('--reading-size'); hardware.screen.style.removeProperty('--screen-dim');
        savePreferences();
      }
      startHotspot(); return;
    }
    model.view = 'maintenance'; model.menuIndex = 0;
  } else if (model.view === 'history') leaveHistory();
  else if (model.view === 'notices') {
    if (model.noticeIndex === model.notices.length) { model.view = 'menu'; model.menuIndex = 0; }
    else { model.activeNotice = model.notices[model.noticeIndex]; model.activeNotice.read = true; model.page = 0; model.view = 'notice'; model.log('任务报告已打开，标记已读；OK返回列表，长按上回主页'); }
  } else if (model.view === 'notice') {
    model.noticeIndex = Math.max(0, model.notices.indexOf(model.activeNotice));
    model.view = 'notices';
  }
  else { model.view = model.view === 'status' ? 'settings' : 'menu'; model.menuIndex = 0; }
  render();
}
bindHardwareKeys({ ...hardware, press: pressOK, release: releaseOK, abort: cancelPress, move, home: returnHome });
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') returnHome();
});
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  if (provisioning.stage === 'wifi-trying') { provisioning.message = '请等待本次网络连接流程结束'; render(); return; }
  if (!provisioning.paired) { provisioning.message = '完成配网、配对后即可体验对话'; render(); return; }
  cancelPress('切换场景，未提交录音已丢弃');
  leaveHistory();
  model.lastHistoryId = null;
  model.selectScenario(button.dataset.scenario);
  document.querySelectorAll('[data-scenario]').forEach(b => { b.classList.toggle('is-selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  render();
}));
$('empty-input').addEventListener('click', () => { model.noContentNext = true; feedback('下次模拟空输入'); });
$('recognition-failure').addEventListener('click', () => { model.failNext = !model.failNext; render(); });
$('record-limit').addEventListener('click', finishAtLimit);
$('setup-first').addEventListener('click', () => { provisioning.message = ''; startHotspot(); });
$('setup-ready').addEventListener('click', () => {
  wifiCycleVersion++;
  cancelPress('恢复已配对演示'); leaveHistory(); model.selectScenario(model.scenario);
  provisioning.version++; provisioning.paired = true; provisioning.stage = 'ready'; provisioning.code = '';
  model.setWifi({ connected: true, ssid: $('setup-ssid').value || 'Home Wi-Fi' }); model.network(true);
  model.clockSynced = true;
  requestConfigReload();
});
$('setup-wifi').addEventListener('submit', event => {
  event.preventDefault();
  if (provisioning.stage !== 'hotspot') return;
  const ssid = $('setup-ssid').value.trim(), address = $('setup-address').value.trim();
  let validAddress = false;
  try { validAddress = ['http:', 'https:'].includes(new URL(address).protocol); } catch {}
  if (!ssid || new TextEncoder().encode(ssid).length > 32 || !validAddress) {
    provisioning.message = '请填写有效 Wi-Fi 名称与 http / https PA 地址'; render(); return;
  }
  const version = ++provisioning.version, fail = $('setup-fail').checked;
  provisioning.address = address; provisioning.stage = 'wifi-connecting'; provisioning.message = '';
  model.setWifi({ connected: false, ssid });
  $('setup-password').value = '';
  render();
  later(() => {
    if (version !== provisioning.version || provisioning.stage !== 'wifi-connecting') return;
    model.setWifi({ connected: true, ssid }); model.network(!fail);
    model.clockSynced = true;
    if (fail) { provisioning.stage = 'unreachable'; provisioning.message = '联网失败模拟；取消勾选后重新配网可恢复'; }
    else { provisioning.issueCode(); model.log('模拟向 PA 申请 8 位一次性配对码，有效期 10 分钟'); }
    render();
  }, 1100);
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
    offlineHistory: $('cloud-cache').value === 'yes', networks }, $('setup-name').value.trim() || '我的 PP');
  provisioning.message = '设备菜单 → 重载配置，或点击下方模拟重载';
  render();
});
$('cloud-reload').addEventListener('click', requestConfigReload);
$('setup-revoke').addEventListener('click', () => {
  if (!provisioning.paired) return;
  wifiCycleVersion++;
  cancelPress('撤销模拟设备配对'); leaveHistory(); model.selectScenario(model.scenario);
  provisioning.issueCode(); provisioning.message = '旧绑定已撤销，需重新配对';
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
  if (provisioning.paired) {
    if (provisioning.stage === 'wifi-trying') return;
    cancelPress('模拟掉线，重新按配置顺序连接');
    startWifiCycle(); return;
  }
  const connected = !model.wifi.connected;
  if (!connected) cancelPress('网络中断，本次未提交录音已丢弃');
  model.setWifi({ connected }); model.network(connected); render();
});
$('wifi-name').addEventListener('input', () => { model.setWifi({ ssid:$('wifi-name').value }); render(); });
$('wifi-strength').addEventListener('change', () => {
  const value = $('wifi-strength').value, wasConnected = model.wifi.connected;
  const connected = value !== 'off';
  if (!connected) { cancelPress('Wi-Fi 断开，本次未提交录音已丢弃'); }
  model.setWifi({ connected, rssi: ({strong:-52,medium:-67,weak:-82})[value] ?? model.wifi.rssi });
  if (connected && !wasConnected) model.network(true);
  render();
});
$('battery-level').addEventListener('input', () => { model.batteryLevel = Number($('battery-level').value); render(); });
$('pa-state').addEventListener('change', () => {
  const online = $('pa-state').value === 'online';
  if (!online) cancelPress('PA 连接中断，本次未提交录音已丢弃');
  model.network(online); render();
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
  else if (provisioning.paired && provisioning.reloadPending && model.input === 'idle' && !model.playing && !['processing', 'responding'].includes(model.work)) requestConfigReload();
  else if (!provisioning.paired && provisioning.stage === 'unreachable' && reconnected) { provisioning.issueCode(); provisioning.message = ''; render(); }
  const bar = $('play-progress');
  if (bar) bar.style.width = `${model.playing ? Math.min(100, model.speech.elapsed / model.speech.duration * 100) : 0}%`;
  updateClock($('clock'), model.clockSynced);
}, 250);
let lastActivity = Date.now();
['pointerdown','keydown'].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }));
setInterval(() => {
  if (!provisioning.paired && provisioning.stage === 'pairing') render();
  if (provisioning.paired && provisioning.stage === 'ready' && !model.keepOnline && !model.sleeping && !pressed && model.input === 'idle' && !['processing','responding','clarifying'].includes(model.work) && !model.playing && Date.now()-lastActivity >= model.sleepSeconds * 1000) { model.sleep(); render(); }
}, 1000);
$('cloud-volume').value = String(model.volume);
$('cloud-mode').value = model.mode;
$('cloud-keep').value = model.keepOnline ? 'yes' : 'no';
renderWifiDraft();
render();
