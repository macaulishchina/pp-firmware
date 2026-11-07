import { PassportModel } from './model.js';
import { PP_PROFILE } from './core/profile.js';
import { mountDeviceShell } from './core/device-shell.js';
import { bindHardwareKeys } from './core/keys.js';

const $ = id => document.getElementById(id);
const hardware = mountDeviceShell($('device-host'));
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('pp-demo.preferences.v1') || '{}') || {}; } catch {}
const model = new PassportModel(preferences);
const { interaction, simulation } = PP_PROFILE;
document.querySelector('.scenarios').innerHTML = Object.values(model.catalog).map((scene,i) => `
  <button class="scenario${i === 0 ? ' is-selected' : ''}" data-scenario="${escape(scene.id)}" aria-pressed="${i === 0}">
    <span class="scenario-symbol">${escape(scene.symbol)}</span><span><strong>${escape(scene.title)}</strong><small>${escape(scene.description)}</small></span>
  </button>`).join('');
const timers = new Set();
let pressed = false, pressStarted = 0, holdTimer = null, clickTimer = null, wakeGuard = false, stoppedOnPress = false;
let recordInterval = null, playbackTimer = null, playbackStarted = 0, feedbackTimer = null;
const wave = (playing = false) => `<div class="wave${playing ? ' playback' : ''}" aria-hidden="true">${Array.from({length:13},(_,i)=>`<i style="--n:${i}"></i>`).join('')}</div>`;
const pages = () => `<span>${model.page + 1} / ${model.pages.length}</span>`;
function later(fn, delay) { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; }
function savePreferences() {
  try { localStorage.setItem('pp-demo.preferences.v1', JSON.stringify({ mode:model.mode, volume:model.volume, keepOnline:model.keepOnline })); } catch {}
}
function stopRecordClock() { clearInterval(recordInterval); recordInterval = null; }
function stopPlaybackClock() { clearTimeout(playbackTimer); playbackTimer = null; }
function feedback(text) {
  model.feedback = text; clearTimeout(feedbackTimer); render();
  feedbackTimer = later(() => { model.feedback = ''; render(); }, 2600);
}
function render() {
  const phase = model.phase, content = $('screen-content');
  let html = '', hint = '按住 OK 说话', page = '';
  $('screen').classList.toggle('sleep', phase === 'sleeping');
  $('signal').classList.toggle('offline', !model.online);
  $('signal').setAttribute('aria-label', model.online ? '网络在线' : '网络离线');
  $('mode-badge').textContent = model.mode === 'steer' ? '引导' : '排队';
  $('mode-note').innerHTML = `<span class="mode-icon">${model.mode === 'steer' ? '↳' : '≋'}</span><span><strong>当前：${model.mode === 'steer' ? '直接引导' : '排队'}</strong><small>${model.mode === 'steer' ? '执行中再说话，会补充或调整当前执行。' : '执行中再说话，会在当前执行结束后处理。'}</small></span>`;
  const unread = model.notices.filter(n => !n.read).length;
  const notices = unread ? `<p class="screen-small center">${unread} 条任务消息待查看</p>` : '';
  const presence = '<div class="presence" aria-hidden="true"></div>';
  const header = text => `<div class="screen-kicker">${escape(text)}</div>`;
  if (phase === 'idle') {
    html = `<div class="home-content">${presence}<h3 class="home-title">我在，按住说。</h3><p class="screen-small center">松开就交给我</p>${notices}</div>`;
  } else if (phase === 'recording') {
    const length = Math.min(Array.from(model.prompt).length, Math.floor(model.elapsed * 7));
    html = `<div class="listening-heading"><h3 class="screen-title"><i class="live-dot"></i>正在听</h3><span class="record-time">${model.elapsed.toFixed(1)}s</span></div>${wave()}<p class="screen-text">${escape(Array.from(model.prompt).slice(0,length).join('') || '…')}</p>`;
    hint = '松开 OK，立即停止收音';
  } else if (phase === 'finalizing') {
    html = `${header('麦克风已停止')}<h3 class="screen-title">收音已结束</h3><p class="screen-user">${escape(model.prompt)}</p><div class="spinner" aria-hidden="true"></div><p class="screen-small center">正在确认最后一句</p>`;
    hint = '等待转写，不再收音';
  } else if (phase === 'processing') {
    html = `${header('输入已接受')}<h3 class="screen-title">交给我了</h3><p class="screen-user">${escape(model.prompt)}</p><div class="spinner" aria-hidden="true"></div><p class="screen-small center">${model.queue.length ? `${model.queue.length} 句已排队` : model.mode === 'steer' ? '可以按住补充一句' : '可以继续说，稍后处理'}</p>`;
    hint = model.queue.length ? `${model.queue.length} 句排队中` : '按住可继续说话';
  } else if (phase === 'playing' || phase === 'reply' || phase === 'clarifying') {
    html = `${header(phase === 'playing' ? '嘟嘟正在说' : phase === 'clarifying' ? '等你补充' : '嘟嘟的回复')}<p class="screen-text">${escape(model.pages[model.page] || '')}</p>${phase === 'playing' ? wave(true) + '<div class="screen-track"><i id="play-progress"></i></div>' : ''}`;
    hint = phase === 'playing' ? '短按停止 · 按住说话' : phase === 'clarifying' ? '按住 OK 回答' : '↑↓ 全文 · OK 菜单';
    page = model.pages.length > 1 ? pages() : '';
  } else if (phase === 'menu') {
    const start = Math.max(0, Math.min(model.menuIndex - 2, model.menus.length - 5));
    html = `<div class="menu-heading">操作菜单</div><ul class="menu-list">${model.menus.slice(start,start+5).map((item,i)=>`<li class="${start+i === model.menuIndex ? 'selected' : ''}">${escape(item.label)}<span>${escape(item.value)}</span></li>`).join('')}</ul>`;
    hint = '↑↓ 选择 · OK 确认'; page = `${model.menuIndex+1}/${model.menus.length}`;
  } else if (phase === 'volume') {
    html = `${header('音量设置')}<h3 class="screen-title">舒服地听清楚</h3><div class="volume-value">${model.volume}<span class="screen-small"> %</span></div><div class="volume-track"><i style="width:${model.volume}%"></i></div><p class="screen-small">仅模拟音量设置</p>`;
    hint = '↑↓ 调整 · OK 返回';
  } else if (phase === 'notices') {
    if (!model.notices.length) html = `${header('任务消息')}<div class="home-content"><h3 class="home-title">暂时没有消息</h3><p class="screen-small center">任务完成后会留在这里</p></div>`;
    else html = `${header('任务消息')}<ul class="menu-list">${model.notices.map((n,i)=>`<li class="${i === model.noticeIndex ? 'selected' : ''}">${n.read ? '' : '· '}${escape(n.title)}</li>`).join('')}</ul><p class="screen-small" style="margin-top:12px">离线期间的结果只提示，<br>不会连续补播。</p>`;
    hint = model.notices.length ? '↑↓ 选择 · OK 查看' : 'OK 返回菜单';
  } else if (phase === 'notice') {
    html = `${header('任务报告')}<h3 class="notice-title">${escape(model.notices[model.noticeIndex]?.title || '')}</h3><p class="screen-text">${escape(model.pages[model.page] || '')}</p>`;
    hint = '↑↓ 全文 · OK 返回'; page = pages();
  } else if (phase === 'status') {
    html = `${header('连接状态')}<h3 class="screen-title">${model.online ? '已连接 PA' : '暂时离线'}</h3><p class="screen-text">独立的 PP 会话<br>Wi-Fi：${model.online ? '演示网络' : '未连接'}<br>待查看消息：${unread}<br>保持在线：${model.keepOnline ? '开' : '关'}</p><p class="screen-small" style="margin-top:9px">以上均为模拟状态</p>`;
    hint = 'OK 返回菜单';
  } else if (phase === 'cancel') {
    html = `${header('取消当前执行')}<h3 class="screen-title">确定要取消吗？</h3><p class="screen-small">停止尚未发出的动作。已经发生的操作，需要核对结果。</p><ul class="menu-list" style="margin-top:12px"><li class="${model.menuIndex === 0 ? 'selected' : ''}">返回，不取消</li><li class="${model.menuIndex === 1 ? 'selected' : ''}">确认取消</li></ul>`;
    hint = '↑↓ 选择 · OK 确认';
  } else if (phase === 'error') {
    html = `<div class="error-icon" aria-hidden="true">!</div><h3 class="screen-title screen-error">${escape(model.error)}</h3><p class="screen-small">这句话没有提交执行。<br>录音已停止，可以重新说。</p>`;
    hint = '重新按住 OK 说话';
  } else if (phase === 'offline') {
    html = `${header('连接已断开')}<h3 class="screen-title">暂时离线</h3><p class="screen-small">未完成的录音不会发送。<br>已经接受的任务继续执行。<br><br>恢复网络后同步结果。</p>`;
    hint = 'OK 菜单 · 右侧恢复网络';
  } else if (phase === 'sleeping') {
    html = `${presence}<p class="screen-small">休息一下</p>${notices}`;
    hint = '轻按任意键唤醒';
  }
  content.innerHTML = html;
  $('screen-hint').textContent = hint;
  $('page-number').innerHTML = page;
  $('stage-status').textContent = model.feedback || ({idle:'就绪，等你开口',recording:'正在收音 · 松开立即停止',finalizing:'收音已停 · 等待最终转写',processing:'执行中 · 可以继续补充',playing:'模拟播报中 · 短按可停止',reply:'回复已交付 · 全文可翻页',clarifying:'等你补充信息',menu:'操作菜单',volume:'音量设置',notices:'任务消息',notice:'查看任务报告',status:'查看连接状态',cancel:'确认取消',error:'本次未执行 · 可重新说话',offline:'离线 · 不重放已接受的任务',sleeping:'休眠 · 后台任务继续'}[phase] || phase);
  $('stage-dot').className = phase === 'error' ? 'error' : phase === 'offline' ? 'offline' : '';
  $('utterance').textContent = model.prompt;
  $('network-toggle').textContent = model.online ? '模拟断网' : '恢复网络';
  $('recognition-failure').setAttribute('aria-pressed', String(model.failNext));
  $('recognition-failure').textContent = model.failNext ? '下次识别会失败 ✓' : '让下次识别失败';
  $('task-complete').disabled = !model.backgroundPending;
  $('fault-note').textContent = model.backgroundPending ? '后台任务已接受。点“模拟任务完成”，体验结果到达与查看。' : model.failNext ? '下一次松开发送后会模拟识别失败，不创建任何执行。' : '失败的录音不会提交；恢复后可以重新按住说话。';
  $('event-count').textContent = `${model.events.length} 步`;
  $('event-log').innerHTML = model.events.map(e=>`<li><time>${escape(e.at)}</time>${escape(e.text)}</li>`).join('');
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
    if (!model.completeWork(job.version, job.input)) return;
    startPlaybackClock(); render();
    if (model.queue.length) later(() => startWork(model.nextQueued()), simulation.queuedDelayMs);
  }, simulation.executionMs);
}
function startPlaybackClock() {
  stopPlaybackClock();
  if (!model.playing) return;
  playbackStarted = performance.now();
  playbackTimer = later(() => {
    if (!model.playing) return;
    model.playing = false; model.log('短播报结束；全文保留，可翻页或继续听'); render();
  }, model.catalog[model.scenario].longPlayback ? simulation.longPlaybackMs : simulation.playbackMs);
}
function pressOK() {
  if (pressed) return;
  pressed = true; pressStarted = performance.now(); $('key-ok').classList.add('pressed');
  if (model.sleeping) { model.wake(); wakeGuard = true; render(); return; }
  if (model.view !== 'home') return;
  if (!model.online) { feedback('暂时离线，恢复后再说'); return; }
  if (model.input !== 'idle') { feedback('上一句正在确认，还没有重新收音'); return; }
  stoppedOnPress = model.stopPlayback();
  if (stoppedOnPress) { stopPlaybackClock(); render(); }
  holdTimer = later(() => {
    clearTimeout(clickTimer); clickTimer = null;
    if (!pressed) return;
    if (model.startInput() === null) return;
    stopPlaybackClock(); render();
    recordInterval = setInterval(() => {
      model.elapsed = (performance.now() - pressStarted) / 1000; render();
      if (model.elapsed >= interaction.maxRecordingSeconds) { cancelPress('达到最长录音时长，已丢弃本次录音'); model.error = '这句话太长了'; render(); }
    }, 100);
  }, interaction.holdMs);
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
    clickTimer = null; model.stopPlayback(); stopPlaybackClock(); model.view = 'menu'; model.menuIndex = 0; render();
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
  if (model.sleeping) { model.wake(); render(); return; }
  if (!model.online && model.view === 'home') { feedback('离线中，短按 OK 可查看菜单'); return; }
  if (model.input !== 'idle') { feedback('先松开 OK，结束这次输入'); return; }
  if (model.view === 'menu') model.menuIndex = (model.menuIndex + direction + model.menus.length) % model.menus.length;
  else if (model.view === 'cancel') model.menuIndex = 1 - model.menuIndex;
  else if (model.view === 'volume') { model.volume = Math.max(0,Math.min(100,model.volume + direction * -5)); savePreferences(); }
  else if (model.view === 'notices' && model.notices.length) model.noticeIndex = (model.noticeIndex + direction + model.notices.length) % model.notices.length;
  else if (model.reply || model.view === 'notice') {
    model.stopPlayback(); stopPlaybackClock(); model.page = Math.max(0, Math.min(model.pages.length - 1, model.page + direction));
  }
  render();
}
function menuOK() {
  if (model.view === 'menu') {
    const id = model.menus[model.menuIndex].id;
    if (id === 'listen') {
      if (!model.online) { feedback('当前离线，暂不能请求继续播报'); return; }
      if (!model.reply) { feedback('还没有可以继续听的回复'); return; }
      model.view = 'home'; model.playing = true; startPlaybackClock(); model.log('用户主动继续听当前回复');
    } else if (id === 'cancel') {
      if (model.work !== 'processing') { feedback('没有正在执行的前台请求'); return; }
      model.view = 'cancel'; model.menuIndex = 0;
    } else if (id === 'keep') { model.keepOnline = !model.keepOnline; savePreferences(); feedback(model.keepOnline ? '已保持在线，不自动休眠' : '已开启空闲两分钟休眠'); }
    else if (id === 'sleep') { model.sleep(); stopPlaybackClock(); }
    else if (id === 'back') model.view = 'home';
    else model.view = id;
  } else if (model.view === 'notices') {
    if (!model.notices.length) model.view = 'menu';
    else { model.notices[model.noticeIndex].read = true; model.page = 0; model.view = 'notice'; model.log('用户打开任务报告，标记已读；没有自动播报'); }
  } else if (model.view === 'notice') model.view = 'notices';
  else if (model.view === 'cancel') {
    if (model.menuIndex === 1) {
      model.workVersion++; model.work = 'idle'; model.queue = []; model.view = 'home';
      model.reply = '当前模拟执行已取消，未派发后续动作。'; model.log('取消已确认；旧响应版本失效，不重做业务');
    } else model.view = 'home';
  } else model.view = 'menu';
  render();
}
bindHardwareKeys({ ...hardware, press: pressOK, release: releaseOK, abort: cancelPress, move });
document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && model.input === 'idle') { model.view = 'home'; render(); }
});
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  cancelPress('切换场景，未提交录音已丢弃'); stopPlaybackClock();
  model.selectScenario(button.dataset.scenario);
  document.querySelectorAll('[data-scenario]').forEach(b => { b.classList.toggle('is-selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  render();
}));
$('recognition-failure').addEventListener('click', () => { model.failNext = !model.failNext; render(); });
$('network-toggle').addEventListener('click', () => {
  if (model.online) cancelPress('网络中断，本次未提交录音已丢弃');
  model.network(!model.online); stopPlaybackClock(); render();
});
$('task-complete').addEventListener('click', () => { model.backgroundComplete(); render(); });
setInterval(() => {
  if (model.playing) { const bar = $('play-progress'); const duration = model.catalog[model.scenario].longPlayback ? simulation.longPlaybackMs : simulation.playbackMs; if (bar) bar.style.width = `${Math.min(100,(performance.now()-playbackStarted)/duration * 100)}%`; }
  $('clock').textContent = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
}, 250);
let lastActivity = Date.now();
['pointerdown','keydown'].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }));
setInterval(() => {
  if (!model.keepOnline && !model.sleeping && !pressed && model.input === 'idle' && !['processing','clarifying'].includes(model.work) && !model.playing && Date.now()-lastActivity >= PP_PROFILE.idleSleepMs) { model.sleep(); render(); }
}, 1000);
render();
