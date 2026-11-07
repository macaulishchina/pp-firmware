import { createScenarioCatalog } from './core/catalog.js';
import { PP_PROFILE } from './core/profile.js';
import { scenarios } from './scenarios.js';

export const DEFAULT_CATALOG = createScenarioCatalog(scenarios);

/** Presentation-only model. No network, microphone, real timers, or device access. */
export class PassportModel {
  constructor(preferences = {}, { catalog = DEFAULT_CATALOG, profile = PP_PROFILE } = {}) {
    if (!Object.keys(catalog).length) throw new TypeError('A scenario catalog is required');
    this.catalog = catalog;
    this.profile = profile;
    this.mode = preferences.mode === 'queue' ? 'queue' : 'steer';
    this.volume = Number.isInteger(preferences.volume) ? Math.max(0, Math.min(100, preferences.volume)) : 65;
    this.keepOnline = preferences.keepOnline !== false;
    this.scenario = Object.keys(catalog)[0];
    this.online = true;
    this.input = 'idle';
    this.work = 'idle';
    this.view = 'home';
    this.playing = false;
    this.sleeping = false;
    this.error = '';
    this.reply = '';
    this.page = 0;
    this.menuIndex = 0;
    this.noticeIndex = 0;
    this.queue = [];
    this.notices = [];
    this.backgroundResults = [];
    this.failNext = false;
    this.elapsed = 0;
    this.inputVersion = 0;
    this.workVersion = 0;
    this.events = [];
    this.feedback = '';
    this.clarification = null;
  }
  get prompt() { return this.clarification?.prompt || this.catalog[this.scenario].prompt; }
  get backgroundPending() { return this.backgroundResults.length > 0; }
  get phase() {
    if (this.sleeping) return 'sleeping';
    if (this.input === 'recording') return 'recording';
    if (this.input === 'finalizing') return 'finalizing';
    if (this.view !== 'home') return this.view;
    if (!this.online) return 'offline';
    if (this.error) return 'error';
    if (this.playing) return 'playing';
    if (this.work === 'processing') return 'processing';
    if (this.work === 'clarifying') return 'clarifying';
    return this.reply ? 'reply' : 'idle';
  }
  get pages() {
    const text = this.view === 'notice' ? this.notices[this.noticeIndex]?.body || '' : this.reply;
    const result = [], chars = Array.from(text);
    // Bounded pages at sentence boundaries; all remaining text is preserved.
    while (chars.length) {
      let count = Math.min(this.profile.pageCharacters, chars.length);
      if (count < chars.length) {
        for (let i = count - 1; i >= 32; i--) {
          if (/[。！？；\n]/.test(chars[i])) { count = i + 1; break; }
        }
      }
      result.push(chars.splice(0, count).join('').trim());
    }
    return result.length ? result : [''];
  }
  get menus() {
    return [
      { id: 'listen', label: '继续听', value: this.reply ? '' : '暂无回复' },
      { id: 'notices', label: '任务消息', value: String(this.notices.filter(n => !n.read).length) },
      { id: 'cancel', label: '取消当前执行', value: this.work === 'processing' ? '' : '无前台执行' },
      { id: 'volume', label: '音量', value: `${this.volume}%` },
      { id: 'keep', label: '保持在线', value: this.keepOnline ? '开' : '关' },
      { id: 'status', label: '连接状态', value: this.online ? '在线' : '离线' },
      { id: 'sleep', label: '休眠', value: '' },
      { id: 'back', label: '返回对话', value: '' },
    ];
  }
  log(text) {
    this.events.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text });
    this.events = this.events.slice(-this.profile.maxEvents);
  }
  selectScenario(id) {
    if (!Object.hasOwn(this.catalog, id)) return false;
    this.inputVersion++; this.workVersion++;
    Object.assign(this, { scenario: id, input: 'idle', work: 'idle', view: 'home', playing: false,
      sleeping: false, error: '', reply: '', page: 0, queue: [], clarification: null, feedback: '' });
    this.log(`切换体验场景：${this.catalog[id].prompt}`);
    return true;
  }
  startInput() {
    if (this.sleeping || !this.online || this.input !== 'idle' || this.view !== 'home') return null;
    this.inputVersion++;
    this.playing = false; this.error = ''; this.feedback = ''; this.elapsed = 0;
    this.input = 'recording';
    this.log('开始本地收音（模拟），保留本次请求身份');
    return this.inputVersion;
  }
  releaseInput() {
    if (this.input !== 'recording') return null;
    this.input = 'finalizing';
    this.log('按键已松开 → 本地收音立即停止，等待最终转写');
    return this.inputVersion;
  }
  discardInput(reason) {
    if (this.input === 'idle') return;
    this.inputVersion++; this.input = 'idle'; this.error = '';
    this.log(reason);
  }
  finishInput(version) {
    if (version !== this.inputVersion || this.input !== 'finalizing' || !this.online) return null;
    this.input = 'idle';
    if (this.failNext) {
      this.failNext = false;
      this.error = '这次没听清';
      this.log('识别失败 → 未提交执行 → 录音状态已清理，可重新说');
      return null;
    }
    const input = { prompt: this.prompt, scenario: this.scenario, clarification: this.clarification };
    this.log('最终转写确认，输入只提交一次');
    if ((this.work === 'processing' || this.queue.length) && this.mode === 'queue') {
      this.queue.push(input);
      this.feedback = `已排队 · ${this.queue.length} 句`;
      this.log('新输入进入队列，当前执行继续');
      return null;
    }
    if (this.work === 'processing') this.log('引导当前执行，旧版本回复失效');
    this.workVersion++; this.work = 'processing'; this.view = 'home';
    this.clarification = null; this.feedback = '';
    return { version: this.workVersion, input };
  }
  completeWork(version, input) {
    if (version !== this.workVersion || this.work !== 'processing') return false;
    this.page = 0;
    if (input.clarification) {
      this.reply = input.clarification.reply;
      this.work = 'done';
    } else {
      const scenario = this.catalog[input.scenario];
      this.reply = scenario.reply;
      this.work = scenario.clarification ? 'clarifying' : 'done';
      this.clarification = scenario.clarification || null;
      if (scenario.background) this.backgroundResults.push({ ...scenario.background });
    }
    this.playing = this.online && !this.sleeping && this.input === 'idle' && this.view === 'home';
    this.feedback = '';
    this.log(this.clarification ? '等待补充信息，不虚构已完成' : '交付确定回复，开始模拟播报');
    return true;
  }
  nextQueued() {
    if (!this.queue.length || this.work === 'processing' || this.input !== 'idle') return null;
    const input = this.queue.shift();
    this.workVersion++; this.work = 'processing'; this.playing = false; this.page = 0;
    this.log('开始处理已排队输入，不重复当前执行');
    return { version: this.workVersion, input };
  }
  stopPlayback() {
    if (!this.playing) return false;
    this.playing = false;
    this.log('立即停止播报，保留完整文字和业务结果');
    return true;
  }
  network(online) {
    this.online = online;
    if (!online) { this.discardInput('网络中断，残缺录音不提交'); this.stopPlayback(); }
    this.log(online ? '网络恢复，查询既有状态；不重放任务、不补播旧语音' : '网络已断开，已接受任务继续');
  }
  toggleMode() {
    this.mode = this.mode === 'steer' ? 'queue' : 'steer';
    this.feedback = this.mode === 'steer' ? '已切换：直接引导' : '已切换：排队';
    this.log(`${this.feedback}，偏好已在浏览器保存`);
  }
  backgroundComplete() {
    if (!this.backgroundPending) return false;
    this.notices.unshift({ ...this.backgroundResults.shift(), read: false });
    this.log('后台结果归属本 PP；只提示待查看，不打断、不自动补播');
    return true;
  }
  sleep() {
    this.discardInput('主动休眠，未提交的录音已丢弃'); this.stopPlayback();
    this.sleeping = true; this.view = 'home';
    this.log('设备休眠，后台任务保留');
  }
  wake() {
    this.sleeping = false;
    this.log('唤醒并同步；本次按键不作为录音，不重播历史语音');
  }
}
