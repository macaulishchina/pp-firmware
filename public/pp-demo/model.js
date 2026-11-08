import { createScenarioCatalog } from './core/catalog.js';
import { PP_PROFILE } from './core/profile.js';
import { scenarios } from './scenarios.js';
import { DemoHistory } from './core/history.js';
import { textPages } from './core/pagination.js';

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
    this.autoSpeak = true; this.speechLimit = profile.simulation.automaticSpeechCharacters;
    this.voiceRate = 1; this.sleepSeconds = profile.idleSleepMs / 1000;
    this.scenario = Object.keys(catalog)[0];
    this.online = true;
    this.wifi = { connected: true, ssid: 'Home Wi-Fi', rssi: -52 };
    this.batteryLevel = 85;
    this.clockSynced = true;
    this.input = 'idle';
    this.work = 'idle';
    this.view = 'home';
    this.homeOnly = true;
    this.noContentNext = false;
    this.playing = false;
    this.resetSpeech();
    this.sleeping = false;
    this.error = '';
    this.reply = '';
    this.replyImage = null;
    this.reviewDraft = null;
    this.responseText = '';
    this.responseVisible = '';
    this.submittedPrompt = '';
    this.page = 0;
    this.menuIndex = 0;
    this.noticeIndex = 0;
    this.activeNotice = null;
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
    this.history = new DemoHistory(catalog);
    this.lastHistoryId = null;
  }
  get prompt() { return this.clarification?.prompt || this.catalog[this.scenario].prompt; }
  get backgroundPending() { return this.backgroundResults.length > 0; }
  get phase() {
    if (this.sleeping) return 'sleeping';
    if (this.input === 'recording') return 'recording';
    if (this.input === 'finalizing') return 'finalizing';
    if (this.input === 'review') return this.view === 'input-review-text' ? 'input-review-text' : 'input-review';
    if (this.view !== 'home') return this.view;
    if (!this.online) return 'offline';
    if (this.error) return 'error';
    if (this.homeOnly && this.view === 'home') return 'idle';
    if (this.work === 'processing') return 'processing';
    if (this.work === 'responding') return 'responding';
    if (this.playing) return 'playing';
    if (this.work === 'clarifying') return 'clarifying';
    return this.reply ? 'reply' : 'idle';
  }
  get pages() {
    const text = this.view === 'notice' ? this.activeNotice?.body || ''
      : this.work === 'responding' ? this.responseVisible : this.reply;
    const rows = this.view === 'notice' ? 6 : 8;
    const result = textPages(text, 13, rows);
    if (this.replyImage && this.view !== 'notice' && this.work !== 'responding') result.push('');
    return result;
  }
  get pageImage() { return this.replyImage && this.page === this.pages.length - 1 ? this.replyImage : null; }
  get reviewPages() {
    return textPages(this.reviewDraft?.prompt || '');
  }

  get menus() {
    if (this.view === 'settings') return [
      { id: 'keep', label: '保持在线', value: this.keepOnline ? '开' : '关' },
      { id: 'status', label: '网络状态', value: this.online ? '在线' : '离线' },
      { id: 'sleep', label: '休眠', value: '' },
      { id: 'maintenance', label: '设备维护', value: '' },
      { id: 'back', label: '返回上级', value: '' },
    ];
    if (this.view === 'maintenance') return [
      { id: 'reload', label: '重载配置', value: '' },
      { id: 'retry', label: '重试连接', value: '' },
      { id: 'reconfigure', label: '重新配网', value: '' },
      { id: 'factory', label: '恢复出厂', value: '' },
      { id: 'back', label: '返回上级', value: '' },
    ];
    return [
      { id: 'notices', label: '任务消息', value: String(this.notices.filter(n => !n.read).length) },
      { id: 'volume', label: '音量', value: `${this.volume}%` },
      { id: 'cancel', label: '取消当前执行', value: ['processing', 'responding'].includes(this.work) ? '' : '无前台执行' },
      { id: 'settings', label: '设置', value: '' },
      { id: 'home', label: '返回主页', value: '' },
    ];
  }
  home() {
    this.discardInput('返回主页，未发送输入已丢弃');
    this.stopPlayback(); this.view = 'home'; this.homeOnly = true; this.page = 0; this.error = '';
    this.feedback = ''; this.menuIndex = 0;
    this.log('返回形象主页，已接受的执行和任务继续，结果留在历史');
  }
  log(text) {
    this.events.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text });
    this.events = this.events.slice(-this.profile.maxEvents);
  }
  selectScenario(id) {
    if (!Object.hasOwn(this.catalog, id)) return false;
    this.inputVersion++; this.workVersion++;
    Object.assign(this, { scenario: id, input: 'idle', work: 'idle', view: 'home', playing: false,
      sleeping: false, homeOnly: true, error: '', reply: '', replyImage: null, reviewDraft: null, responseText: '', responseVisible: '', submittedPrompt: '', page: 0, queue: [], clarification: null, feedback: '' });
    this.resetSpeech();
    this.log(`切换体验场景：${this.catalog[id].prompt}`);
    return true;
  }
  startInput() {
    if (this.sleeping || !this.online || this.input !== 'idle' || this.view !== 'home') return null;
    this.inputVersion++;
    this.homeOnly = false;
    this.stopPlayback();
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
    this.inputVersion++; this.input = 'idle'; this.error = ''; this.reviewDraft = null;
    this.log(reason);
  }
  finishInput(version, review = false) {
    if (version !== this.inputVersion || this.input !== 'finalizing' || !this.online) return null;
    this.input = 'idle';
    if (this.noContentNext) {
      this.noContentNext = false; this.homeOnly = true; this.error = '';
      this.feedback = '未检测到内容，请重新说。';
      this.log('最终转写为空，未派发执行；恢复形象主页');
      return null;
    }
    if (this.failNext) {
      this.failNext = false;
      this.error = '这次没听清';
      this.log('识别失败 → 未提交执行 → 录音状态已清理，可重新说');
      return null;
    }
    const input = { prompt: this.prompt, scenario: this.scenario, clarification: this.clarification };
    if (review) {
      this.input = 'review'; this.reviewDraft = input; this.page = this.menuIndex = 0;
      this.log('达到录音上限：收音与识别结束，全文保留；默认丢弃，明确确认前不提交');
      return null;
    }
    return this.acceptInput(input);
  }
  confirmInput(send) {
    if (this.input !== 'review' || !this.reviewDraft) return null;
    const input = this.reviewDraft;
    this.reviewDraft = null; this.input = 'idle'; this.view = 'home'; this.page = 0;
    this.log(send ? '用户明确确认，只提交一次已识别文字' : '用户丢弃待确认输入，没有模型派发');
    return send ? this.acceptInput(input) : null;
  }
  acceptInput(input) {
    this.log('最终转写确认，输入只提交一次');
    if ((['processing', 'responding'].includes(this.work) || this.queue.length) && this.mode === 'queue') {
      this.queue.push(input);
      this.feedback = `已排队 · ${this.queue.length} 句`;
      this.log('新输入进入队列，当前执行继续');
      return null;
    }
    if (['processing', 'responding'].includes(this.work)) this.log('引导当前执行，旧版本回复失效');
    this.workVersion++; this.work = 'processing'; this.view = 'home';
    this.resetSpeech();
    this.submittedPrompt = input.prompt;
    this.clarification = null; this.feedback = '';
    return { version: this.workVersion, input };
  }
  beginResponse(version, input) {
    if (version !== this.workVersion || this.work !== 'processing') return false;
    this.responseText = input.clarification?.reply || this.catalog[input.scenario].reply;
    this.replyImage = null;
    this.responseVisible = ''; this.page = 0; this.work = 'responding';
    this.resetSpeech();
    this.speech.muted = !this.autoSpeak || !this.online || this.sleeping || this.input !== 'idle' || this.view !== 'home';
    this.log('收到回复首段，开始模拟逐字输出；输入与回复分区呈现');
    return true;
  }
  completeWork(version, input) {
    if (version !== this.workVersion || !['processing', 'responding'].includes(this.work)) return false;
    const streamed = this.work === 'responding';
    this.page = 0;
    if (input.clarification) {
      this.reply = input.clarification.reply;
      this.work = 'done';
    } else {
      const scenario = this.catalog[input.scenario];
      this.reply = scenario.reply;
      this.replyImage = scenario.image || null;
      this.work = scenario.clarification ? 'clarifying' : 'done';
      this.clarification = scenario.clarification || null;
      if (scenario.background) this.backgroundResults.push({ ...scenario.background });
    }
    if (!streamed) this.resetSpeech();
    this.offerSpeech(this.reply, true);
    this.advanceSpeech(0);
    this.lastHistoryId = this.history.save(input.prompt, this.reply, true, this.replyImage).id;
    this.feedback = '';
    this.log(this.clarification ? '等待补充信息，不虚构已完成' : '文字生成完成，保留正文；已开始的播报继续，不从头重播');
    return true;
  }
  nextQueued() {
    if (!this.queue.length || ['processing', 'responding'].includes(this.work) || this.input !== 'idle'
      || (!this.speech.muted && (this.playing || this.speech.current || this.speech.segments.length))) return null;
    const input = this.queue.shift();
    this.workVersion++; this.work = 'processing'; this.playing = false; this.page = 0;
    this.resetSpeech();
    this.submittedPrompt = input.prompt;
    this.log('开始处理已排队输入，不重复当前执行');
    return { version: this.workVersion, input };
  }
  stopPlayback() {
    const wasPlaying = this.playing;
    this.speech.muted = true;
    this.speech.segments = []; this.speech.current = ''; this.speech.elapsed = 0;
    this.playing = false;
    if (wasPlaying) this.log('立即停止播报；后续句子不自动续播，文字生成继续');
    return wasPlaying;
  }
  resetSpeech() {
    this.playing = false;
    this.speech = { segments: [], offered: 0, spoken: 0, current: '', elapsed: 0, duration: 0,
      muted: !this.autoSpeak, limited: false, limit: this.speechLimit };
  }
  offerSpeech(text, final = false) {
    if (this.speech.muted) return;
    const chars = Array.from(text);
    while (this.speech.offered < chars.length) {
      const remaining = chars.slice(this.speech.offered).join('');
      const complete = remaining.match(/^[\s\S]*?[。！？!?；\n]+[”’」』）)]*/u);
      const segment = complete?.[0] || (final ? remaining : '');
      if (!segment) break;
      const length = Array.from(segment).length;
      if (this.speech.offered + length > this.speech.limit) {
        this.speech.limited = true;
        break;
      }
      this.speech.offered += length;
      if (segment.trim()) this.speech.segments.push(segment);
    }
  }
  advanceSpeech(seconds) {
    if (this.speech.muted) return false;
    if (!this.online || this.sleeping || this.input !== 'idle' || this.view !== 'home') {
      this.stopPlayback();
      return false;
    }
    let changed = false;
    if (!this.playing) {
      if (!this.speech.current) this.speech.current = this.speech.segments.shift() || '';
      if (!this.speech.current) return false;
      this.playing = true;
      this.speech.duration = Math.max(.7, Array.from(this.speech.current).length / (this.profile.simulation.speechCharactersPerSecond * this.voiceRate));
      this.log('完整句已就绪 → 模拟播报，后续文字可同时生成');
      changed = true;
    }
    this.speech.elapsed += seconds;
    if (this.speech.elapsed >= this.speech.duration) {
      this.speech.spoken += Array.from(this.speech.current).length;
      this.speech.current = ''; this.speech.elapsed = 0; this.playing = false;
      if (this.speech.segments.length) this.advanceSpeech(0);
      if (!this.playing && !this.speech.segments.length && this.work !== 'responding') {
        this.log(this.speech.limited ? '短播报结束，剩余内容只保留文字' : '回复已全部播完');
      }
      return true;
    }
    return changed;
  }
  network(online) {
    this.online = Boolean(online) && this.wifi.connected;
    if (!this.online) { this.discardInput('连接中断，残缺录音不提交'); this.stopPlayback(); }
    this.log(this.online ? 'PA 连接恢复，查询既有状态；不重放任务、不补播旧语音' : 'PA 连接已断开，已接受任务继续');
  }
  setWifi({ connected = this.wifi.connected, ssid = this.wifi.ssid, rssi = this.wifi.rssi } = {}) {
    this.wifi = { connected: Boolean(connected), ssid: typeof ssid === 'string' ? ssid : '',
      rssi: Number.isFinite(rssi) ? rssi : null };
    if (!this.wifi.connected) this.network(false);
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
    this.home();
    this.log('唤醒并同步；本次按键不作为录音，不重播历史语音');
  }
}
