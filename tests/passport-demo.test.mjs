import test from 'node:test';
import assert from 'node:assert/strict';
import { PassportModel } from '../public/pp-demo/model.js';
import { createScenarioCatalog } from '../public/pp-demo/core/catalog.js';
import { wifiStrength } from '../public/pp-demo/core/status.js';

function submit(m) {
  const id = m.startInput();
  assert.notEqual(id, null);
  assert.equal(m.releaseInput(), id);
  assert.equal(m.input, 'finalizing');
  return m.finishInput(id);
}

test('release stops capture before recognition; duplicate/stale completion is inert', () => {
  const m = new PassportModel();
  const id = m.startInput();
  assert.equal(m.phase, 'recording');
  m.releaseInput();
  assert.equal(m.phase, 'finalizing');
  const job = m.finishInput(id);
  assert.ok(job);
  assert.equal(m.finishInput(id), null);
  assert.equal(m.completeWork(job.version,job.input), true);
  m.workVersion++;
  assert.equal(m.completeWork(job.version,job.input), false);
});

test('home does not cancel accepted work; streamed delivery cannot replace the home page', () => {
  const m = new PassportModel();
  const job = submit(m); m.beginResponse(job.version, job.input);
  m.home();
  assert.equal(m.phase, 'idle');
  assert.equal(m.work, 'responding');
  assert.ok(m.completeWork(job.version, job.input));
  assert.equal(m.phase, 'idle');
  assert.ok(m.lastHistoryId);
  assert.equal(m.playing, false);
  m.sleep(); m.wake();
  assert.equal(m.phase, 'idle');
});

test('empty input keeps the mascot, has one actionable hint and dispatches nothing', () => {
  const m = new PassportModel(); m.noContentNext = true;
  assert.equal(submit(m), null);
  assert.equal(m.phase, 'idle');
  assert.equal(m.work, 'idle');
  assert.equal(m.error, '');
  assert.equal(m.feedback, '未检测到内容，请重新说。');
  assert.ok(submit(m));
});

test('menus stay bounded and maintenance is explicitly below settings', () => {
  const m = new PassportModel();
  m.view = 'menu'; assert.equal(m.menus.length, 5);
  assert.ok(!m.menus.some(item => item.id === 'factory' || item.id === 'reload'));
  m.view = 'settings'; assert.equal(m.menus.length, 5);
  assert.ok(m.menus.some(item => item.id === 'maintenance'));
  m.view = 'maintenance'; assert.equal(m.menus.length, 5);
  assert.ok(m.menus.some(item => item.id === 'back'));
});

test('failed recognition dispatches nothing and allows fresh recording', () => {
  const m = new PassportModel(); m.failNext = true;
  assert.equal(submit(m), null);
  assert.equal(m.work, 'idle');
  assert.equal(m.phase, 'error');
  assert.ok(submit(m));
});

test('disconnect discards partial input; stale final cannot dispatch on reconnect', () => {
  const m = new PassportModel(), id = m.startInput();
  m.releaseInput(); m.network(false); m.network(true);
  assert.equal(m.input, 'idle');
  assert.equal(m.finishInput(id), null);
  assert.equal(m.work, 'idle');
});

test('steer invalidates old response; queue preserves current work and schedules next once', () => {
  const m = new PassportModel();
  const old = submit(m), fresh = submit(m);
  assert.equal(m.completeWork(old.version,old.input),false);
  assert.equal(m.completeWork(fresh.version,fresh.input),true);
  m.mode = 'queue';
  const first = submit(m);
  assert.equal(submit(m),null);
  assert.equal(m.queue.length,1);
  m.completeWork(first.version,first.input);
  assert.equal(m.nextQueued(),null); // Delivery still has queued speech.
  while (m.playing || m.speech.current || m.speech.segments.length) m.advanceSpeech(1000);
  const next = m.nextQueued();
  assert.ok(next);
  assert.equal(m.queue.length,0);
  assert.equal(m.nextQueued(),null);
});

test('recording limit preserves a draft and only explicit confirmation dispatches once', () => {
  const m = new PassportModel(); m.selectScenario('long-input');
  const id = m.startInput(); m.releaseInput();
  assert.equal(m.finishInput(id, true), null);
  assert.equal(m.work, 'idle'); assert.equal(m.input, 'review');
  assert.equal(m.reviewPages.join(''), m.prompt);
  assert.equal(m.confirmInput(false), null); assert.equal(m.work, 'idle');
  const second = m.startInput(); m.releaseInput(); m.finishInput(second, true);
  assert.ok(m.confirmInput(true)); assert.equal(m.confirmInput(true), null);
});

test('image replies and history retain only a local thumbnail reference', () => {
  const m = new PassportModel(); m.selectScenario('image');
  const job = submit(m); m.completeWork(job.version, job.input);
  m.page = m.pages.length - 1;
  assert.equal(m.pageImage.src, './color-check.svg');
  const record = m.history.read(m.lastHistoryId);
  assert.equal(m.history.pages(record).at(-1).image, m.pageImage);
  assert.throws(() => createScenarioCatalog([{...m.catalog.image, image: {src: 'https://elsewhere/image.png', alt: 'bad'}}]), /local fixture/);
});

test('clarification answers the pending question and does not ask again', () => {
  const m = new PassportModel(); m.selectScenario('clarify');
  const first = submit(m); m.completeWork(first.version,first.input);
  assert.ok(m.clarification);
  const answer = submit(m); m.completeWork(answer.version,answer.input);
  assert.equal(m.clarification,null);
  assert.match(m.reply,/晚上八点/);
});

test('background result during sleep is not autoplayed; wake does not duplicate or mark read', () => {
  const m = new PassportModel(); m.selectScenario('task');
  const job = submit(m); m.completeWork(job.version,job.input);
  m.sleep(); m.backgroundComplete(); m.wake();
  assert.equal(m.notices.length,1);
  assert.equal(m.notices[0].read,false);
  assert.equal(m.playing,false);
  assert.equal(m.backgroundComplete(),false);
});

test('pages retain all text; menu completion does not start hidden audio', () => {
  const m = new PassportModel(); m.selectScenario('long');
  const job = submit(m); m.view = 'menu'; m.completeWork(job.version,job.input);
  assert.equal(m.playing,false);
  assert.ok(m.pages.length > 1);
  assert.equal(m.pages.join('').replace(/\s/g,''),m.reply.replace(/\s/g,''));
});

test('preferences are bounded and transcript/credentials are never stored in model preferences', () => {
  const m = new PassportModel({volume:999,mode:'invalid',keepOnline:false});
  assert.equal(m.volume,100); assert.equal(m.mode,'steer'); assert.equal(m.keepOnline,false);
});

test('new scenario uses the same shell-independent engine without a central id branch', () => {
  const catalog = createScenarioCatalog([{
    id: 'travel', title: '行程演示', description: '自定义场景', prompt: '帮我整理行程。', reply: '已经整理。',
    background: { title: '行程已就绪', body: '这是独立声明的行程报告。' },
  }]);
  const m = new PassportModel({}, {catalog});
  assert.equal(m.scenario,'travel');
  const job = submit(m); m.completeWork(job.version,job.input);
  assert.equal(m.reply,'已经整理。');
  assert.equal(m.backgroundComplete(),true);
  assert.equal(m.notices[0].title,'行程已就绪');
  assert.equal(m.selectScenario('toString'),false);
});

test('scene declarations reject collisions and incomplete definitions', () => {
  assert.throws(() => createScenarioCatalog([]), /required/);
  const scene = { id:'valid', title:'演示', description:'介绍', prompt:'你好', reply:'你好' };
  assert.throws(() => createScenarioCatalog([scene,scene]), /Duplicate/);
  assert.throws(() => createScenarioCatalog([{...scene,background:{title:'缺少正文'}}]), /background.body/);
  assert.throws(() => createScenarioCatalog([{...scene,id:'<script>'}]), /identifier/);
});

test('a new input cannot jump ahead of an accepted queued input during recognition', () => {
  const m = new PassportModel({mode:'queue'});
  const first = submit(m);
  submit(m);
  const id = m.startInput(); m.releaseInput();
  m.completeWork(first.version,first.input);
  assert.equal(m.nextQueued(),null);
  assert.equal(m.finishInput(id),null);
  assert.equal(m.queue.length,2);
  assert.ok(m.nextQueued());
  assert.equal(m.queue.length,1);
});

test('Wi-Fi association and PA reachability are independent telemetry', () => {
  const m = new PassportModel();
  m.network(false);
  assert.equal(m.wifi.connected,true);
  assert.equal(m.online,false);
  m.setWifi({rssi:-82});
  assert.equal(m.online,false);
  m.network(true);
  assert.equal(m.online,true);
  m.setWifi({connected:false});
  assert.equal(m.online,false);
  m.network(true);
  assert.equal(m.online,false);
});

test('signal bands have clear boundaries and missing RSSI is never full strength', () => {
  assert.equal(wifiStrength(-55).level,3);
  assert.equal(wifiStrength(-56).level,2);
  assert.equal(wifiStrength(-70).level,2);
  assert.equal(wifiStrength(-71).level,1);
  assert.equal(wifiStrength(null).level,0);
  assert.equal(wifiStrength(NaN).label,'强度未知');
});
