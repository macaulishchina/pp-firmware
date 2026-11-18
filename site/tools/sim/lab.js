import { Passport } from '/engine.js';

const get = id => document.getElementById(id);
const page = new URL(location.href);
let machine, busy = false, catalog;
let images, scenarios;

async function endpoint(path, options) {
  const response = await fetch(path, { signal: AbortSignal.timeout(20000), ...options });
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(error || `HTTP ${response.status}`);
  }
  return response;
}

function status(message, failed = false) {
  get('status').textContent = message;
  get('status').dataset.state = failed ? 'fail' : '';
}

function setBusy(active) {
  busy = active;
  for (const id of ['image', 'scenario', 'fault', 'boot', 'run']) get(id).disabled = active;
  for (const button of document.querySelectorAll('[data-key], #send')) button.disabled = active || !machine;
}

async function exclusive(work) {
  if (busy) throw new Error('本次操作尚未完成');
  setBusy(true);
  try {
    return await work();
  } catch (error) {
    status(error.message, true);
    throw error;
  } finally {
    setBusy(false);
  }
}

function labels(tree) {
  return [...tree.matchAll(/\blabel ("(?:[^"\\]|\\.)*")/g)].map(([, value]) => {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  });
}

async function readEvidence() {
  const tree = await machine.ui();
  const serial = await machine.serial();
  get('tree').textContent = tree.text || '';
  get('serial').textContent = serial;
  return { tree: tree.text || '', serial, labels: labels(tree.text || '') };
}

async function capture() {
  const screen = await machine.screen();
  get('screen').src = screen;
  get('screen').hidden = false;
  get('snapshot').href = screen;
  get('snapshot').hidden = false;
  return screen;
}

async function diagnosticEvidence() {
  const [tree, serial] = await Promise.all([
    machine.ui().catch(() => null), machine.serial().catch(() => null),
  ]);
  const text = tree?.text || get('tree').textContent;
  return { tree: text, serial: serial ?? get('serial').textContent, labels: labels(text) };
}

async function load(image) {
  const item = images.get(image);
  if (!item) throw new Error('找不到指定版本');
  const url = `/images/${encodeURIComponent(image)}`;
  machine?.close();
  machine = null;
  get('screen').hidden = true;
  get('snapshot').hidden = true;
  get('tree').textContent = '等待固件启动';
  get('serial').textContent = '等待固件启动';
  status(`正在校验和加载 ${item.title}…`);
  const response = await endpoint(url);
  const meta = JSON.parse(response.headers.get('X-PP-Image'));
  const bytes = await response.arrayBuffer();
  const flash = bytes.slice(0, meta.flashBytes);
  const elf = bytes.slice(meta.flashBytes);
  if (flash.byteLength !== meta.flashBytes || elf.byteLength !== meta.elfBytes) {
    throw new Error('固件传输不完整');
  }
  // The Worker remains paused. Only explicit scenario steps advance the guest.
  machine = new Passport(meta.worker, meta.simulator);
  try {
    await machine.boot(flash, elf);
    await machine.advance(1650);
  } catch (error) {
    machine.close();
    machine = null;
    throw error;
  }
  return meta;
}

function renderStep(step) {
  const item = document.createElement('li');
  item.className = step.status;
  item.textContent = `${step.name} · ${step.status === 'pass' ? '通过' : step.error}`;
  get('steps').append(item);
}

function select(image, scenario) {
  get('image').value = image;
  get('scenario').value = scenario;
  page.searchParams.set('image', image);
  page.searchParams.set('case', scenario);
  page.searchParams.delete('run');
  history.replaceState(null, '', page);
}

async function run(image, scenario, { fault = false, expected = null } = {}) {
  return exclusive(async () => {
    await catalog;
    const spec = scenarios.get(scenario);
    if (!images.has(image) || !spec) throw new Error('固件或场景不存在');
    select(image, scenario);
    get('steps').replaceChildren();
    const start = performance.now();
    const steps = [];
    let meta, evidence, error = null, bootMs;
    try {
      meta = await load(image);
      bootMs = Math.round(performance.now() - start);
      const fingerprint = { ...meta, scenarioSha256: spec.sha256 };
      if (expected && Object.entries(expected).some(([key, digest]) => fingerprint[key] !== digest)) {
        throw new Error('复跑所需的镜像、模拟器或场景已变化');
      }
      for (const [index, action] of spec.steps.entries()) {
        const started = performance.now();
        const want = fault && index === spec.steps.length - 1
          ? [...action.expect, 'PP Lab 注入的失败断言'] : action.expect;
        const step = {
          name: action.name, key: action.key, ms: action.key ? (action.ms || 210) : undefined,
          command: action.serial, expected: want,
          contains: action.contains, absent: action.absent, serialContains: action.serialContains,
        };
        evidence = null;
        status(`${spec.title} · ${index + 1}/${spec.steps.length} · ${action.name}`);
        try {
          if (action.key) await machine.press(action.key, step.ms);
          const reply = action.serial ? await machine.send(action.serial) : '';
          // Allow fresh boot to settle in slow browsers. Later steps have a
          // bounded virtual delay in the input command and read a safe UI point.
          if (index === 0) {
            for (let i = 0; i < 6; i++) {
              const tree = (await machine.ui()).text || '';
              if (want.every(label => labels(tree).includes(label))) break;
              await machine.advance(250);
            }
          }
          evidence = await readEvidence();
          const missing = want.filter(label => !evidence.labels.includes(label));
          const text = evidence.labels.join('\n');
          const missingText = (action.contains || []).filter(part => !text.includes(part));
          const forbidden = (action.absent || []).filter(part => text.includes(part));
          const missingSerial = (action.serialContains || []).filter(text => !reply.includes(text));
          if (missing.length) throw new Error(`界面缺少「${missing.join('」「')}」`);
          if (missingText.length) throw new Error(`界面内容缺少「${missingText.join('」「')}」`);
          if (forbidden.length) throw new Error(`界面出现「${forbidden.join('」「')}」`);
          if (missingSerial.length) throw new Error(`串口缺少「${missingSerial.join('」「')}」`);
          step.status = 'pass';
        } catch (failure) {
          step.status = 'fail';
          step.error = failure.message;
          error = failure.message;
          evidence ??= await diagnosticEvidence();
        }
        step.actual = evidence.labels;
        if (index === 0 || index === spec.steps.length - 1 || action.capture || error) {
          step.tree = evidence.tree;
          try {
            step.screen = await capture();
          } catch (failure) {
            step.captureError = failure.message;
            step.status = 'fail';
            step.error ||= `无法保留 LCD 截图（${failure.message}）`;
            error ||= step.error;
          }
        }
        step.wallMs = Math.round(performance.now() - started);
        steps.push(step);
        renderStep(step);
        if (error) break;
      }
    } catch (failure) {
      error = failure.message;
    }
    const result = {
      image, scenario, fault, version: meta?.version || images.get(image).version,
      sha256: meta?.sha256 || null, flashSha256: meta?.flashSha256 || null,
      elfSha256: meta?.elfSha256 || null, simulator: meta?.simulator || null, worker: meta?.worker || null,
      scenarioSha256: spec.sha256, initial: 'erased-nvs',
      seed: 0,
      status: error ? 'fail' : 'pass', error, bootMs,
      steps, serial: evidence?.serial || '', wallMs: Math.round(performance.now() - start),
    };
    const saved = await (await endpoint('/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
    })).json();
    status(`${spec.title} · ${error ? '失败' : '通过'} · ${saved.id}`, Boolean(error));
    await refreshRuns(saved.id);
    return saved;
  });
}

function link(text, href) {
  const node = document.createElement('a');
  node.textContent = text;
  node.href = href;
  return node;
}

async function showRecord(id) {
  const result = await (await endpoint(`/runs/${encodeURIComponent(id)}`)).json();
  const title = document.createElement('h2');
  title.textContent = `${scenarios.get(result.scenario)?.title || result.scenario} · ${result.status === 'pass' ? '通过' : '失败'}`;
  const meta = document.createElement('p');
  meta.textContent = [result.version, id, `${(result.wallMs / 1000).toFixed(2)} 秒`, result.error].filter(Boolean).join(' · ');
  const replay = document.createElement('button');
  replay.textContent = '按原版本复跑场景';
  replay.disabled = !result.sha256;
  const keys = ['sha256', 'flashSha256', 'elfSha256', 'scenarioSha256', 'simulator', 'worker'];
  replay.onclick = () => run(result.image, result.scenario, { expected: Object.fromEntries(
    keys.filter(key => result[key]).map(key => [key, result[key]]),
  ) }).catch(error => status(error.message, true));
  const tools = document.createElement('p');
  tools.append(replay, ' ', link('查看串口', `/runs/${id}/serial.txt`), ' ', link('运行 JSON', `/runs/${id}`));
  const list = document.createElement('ol');
  for (const step of result.steps) {
    const row = document.createElement('li');
    row.className = step.status;
    row.textContent = step.name;
    const detail = document.createElement('details');
    detail.open = step.status === 'fail';
    const summary = document.createElement('summary');
    summary.textContent = `${step.status === 'pass' ? '通过' : step.error} · ${step.wallMs} ms`;
    const comparison = document.createElement('pre');
    comparison.textContent = [
      `预期 ${step.expected.join(' / ')}`,
      step.contains?.length ? `界面应包含 ${step.contains.join(' / ')}` : '',
      step.absent?.length ? `界面应省略 ${step.absent.join(' / ')}` : '',
      step.serialContains?.length ? `串口应包含 ${step.serialContains.join(' / ')}` : '',
      `实际 ${step.actual.join(' / ')}`,
    ].filter(Boolean).join('\n');
    detail.append(summary, comparison);
    if (step.screen) {
      const screenshot = document.createElement('img');
      screenshot.src = `/runs/${id}/${step.screen}`;
      screenshot.alt = step.name;
      detail.append(screenshot, link('打开截图', screenshot.src));
    }
    if (step.tree) detail.append(' ', link('查看控件树', `/runs/${id}/${step.tree}`));
    row.append(detail);
    list.append(row);
  }
  get('record').replaceChildren(title, meta, tools, list);
  page.searchParams.set('run', id);
  history.replaceState(null, '', page);
}

async function refreshRuns(selectId) {
  const rows = await (await endpoint('/runs')).json();
  get('runs').replaceChildren(...rows.map(result => {
    const row = document.createElement('li');
    const a = link(`${result.status === 'pass' ? '通过' : '失败'} · ${result.version} · ${result.scenario}`,
      `?run=${result.id}`);
    const stamp = document.createElement('small');
    stamp.textContent = new Date(result.at).toLocaleString('zh-CN');
    a.onclick = event => {
      event.preventDefault();
      showRecord(result.id).catch(error => status(error.message, true));
    };
    row.append(a, document.createElement('br'), stamp);
    return row;
  }));
  if (selectId) await showRecord(selectId);
}

catalog = (async () => {
  const data = await (await endpoint('/catalog')).json();
  images = new Map(data.images.map(item => [item.id, item]));
  scenarios = new Map(Object.entries(data.scenarios));
  for (const [id, values] of [['image', images], ['scenario', scenarios]]) {
    get(id).replaceChildren(...[...values].map(([key, item]) => new Option(item.title, key)));
  }
  const image = page.searchParams.get('image');
  const scenario = page.searchParams.get('case');
  if (images.has(image)) get('image').value = image;
  else {
    const ready = [...images.values()].find(item => item.ready);
    if (ready) get('image').value = ready.id;
  }
  if (scenarios.has(scenario)) get('scenario').value = scenario;
  await refreshRuns(page.searchParams.get('run'));
  status('选择固件与场景，或启动后用按键和串口查看设备。');
})();
catalog.catch(error => status(error.message, true));

get('boot').onclick = () => exclusive(async () => {
  await catalog;
  get('steps').replaceChildren();
  select(get('image').value, get('scenario').value);
  const meta = await load(get('image').value);
  await readEvidence();
  await capture();
  status(`${meta.version} 已启动 · ${meta.sha256.slice(0, 12)}`);
}).catch(() => {});

get('run').onclick = () => run(get('image').value, get('scenario').value, {
  fault: get('fault').checked,
}).catch(() => {});

for (const button of document.querySelectorAll('[data-key]')) {
  button.onclick = () => exclusive(async () => {
    await machine.press(button.dataset.key, Number(button.dataset.ms || 210));
    await readEvidence();
    await capture();
    status(`已发送按键 ${button.textContent}`);
  }).catch(() => {});
}

get('serial-form').onsubmit = event => {
  event.preventDefault();
  exclusive(async () => {
    const command = get('command').value.trim();
    if (!command) return;
    await machine.send(command);
    await readEvidence();
    await capture();
    status(`已发送 ${command}`);
  }).catch(() => {});
};

window.ppLab = { run };
