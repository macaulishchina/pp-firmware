// Same-origin evidence and an exportable user handoff. The lab never starts jobs.
const labels = {
  pending: '未运行', running: '运行中', pass: '通过', fail: '待修复',
  waiting: '需要配合', interrupted: '已中断', stale: '待复跑', open: '待处理', retest: '待复测', resolved: '已收尾',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function badge(status) {
  const node = element('span', labels[status] || labels.pending, 'lab-badge');
  node.dataset.status = status;
  return node;
}

function item(title, status, text) {
  const row = element('li', '', 'lab-row');
  const heading = element('div', '', 'lab-row-title');
  heading.append(element('strong', title), badge(status));
  row.append(heading);
  if (text) row.append(element('p', text, 'scene-description'));
  return row;
}

async function json(name) {
  const response = await fetch(new URL(name, import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Lab HTTP ${response.status}`);
  return response.json();
}

export function mountLabPanel() {
  const get = id => document.getElementById(id);
  const panel = get('panel-lab');
  const chooser = get('lab-case');
  const exportButton = get('lab-export');
  let cases = [], report, casesRequest, busy = false;
  const formatDate = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const pickFeedback = id => {
    chooser.value = id;
    get('lab-note').focus();
  };

  function drawCases() {
    const rows = cases.map(test => {
      const verified = report?.manual?.[test.id] === 'pass';
      const row = item(test.title, verified ? 'pass' : 'waiting', test.steps);
      row.append(element('p', test.expected, 'scene-description'));
      const actions = element('div', '', 'compact-actions');
      const preview = element('button', '在 PP 交互演示中打开');
      preview.type = 'button';
      preview.addEventListener('click', () => {
        const scenario = get('scenario-picker');
        if (test.scene && [...scenario.options].some(option => option.value === test.scene)) {
          scenario.value = test.scene;
          scenario.dispatchEvent(new Event('change'));
        }
        document.querySelector(`[data-panel="${test.panel}"]`).click();
      });
      const feedback = element('button', '填写结果');
      feedback.type = 'button';
      feedback.addEventListener('click', () => pickFeedback(test.id));
      actions.append(preview, feedback);
      row.append(actions);
      return row;
    });
    get('lab-cases').replaceChildren(...rows);
  }

  async function refresh() {
    if (busy || panel.hidden) return;
    busy = true;
    try {
      casesRequest ??= json('cases.json').catch(error => { casesRequest = null; throw error; });
      if (!cases.length) {
        cases = await casesRequest;
        chooser.replaceChildren(...cases.map(test => new Option(test.title, test.id)));
      }
      const next = await json('status.json');
      if (next.schema !== 1) throw new Error('Unrecognized lab report');
      if (report?.updated === next.updated && JSON.stringify(report) === JSON.stringify(next)) return;
      report = next;
      get('lab-meta').textContent = `${report.firmware} · ${report.revision} · ${formatDate(report.updated)}`;
      get('lab-stages').replaceChildren(...Object.values(report.stages).map(stage => {
        const row = item(stage.title, stage.status, stage.hint);
        const details = [];
        if (stage.at) details.push(formatDate(stage.at));
        if (stage.duration != null) details.push(`${stage.duration} 秒`);
        if (stage.run && ['fail', 'waiting'].includes(stage.status)) details.push(`运行 ${stage.run}`);
        if (details.length) row.append(element('small', details.join(' · '), 'lab-evidence'));
        return row;
      }));
      get('lab-issue-count').textContent = `(${report.issues.filter(issue => issue.status !== 'resolved').length} 未结)`;
      get('lab-issues-panel').hidden = !report.issues.length;
      get('lab-issues').replaceChildren(...report.issues.map(issue =>
        item(`${cases.find(test => test.id === issue.case)?.title || issue.case} · ${issue.id}`, issue.status, issue.summary)));
      exportButton.disabled = !report.revision;
      drawCases();
    } catch {
      report = undefined;
      exportButton.disabled = true;
      get('lab-meta').textContent = '暂未读到本轮验收进度，运行检查后会在这里更新。';
      get('lab-stages').replaceChildren();
      get('lab-issues-panel').hidden = true;
      drawCases();
    } finally {
      busy = false;
    }
  }

  document.querySelector('[data-panel="lab"]').addEventListener('click', () => queueMicrotask(refresh));
  setInterval(refresh, 4000);

  get('lab-feedback').addEventListener('submit', event => {
    event.preventDefault();
    if (!report?.revision || !chooser.value) return;
    const outcome = get('lab-outcome').value;
    const note = get('lab-note').value.trim();
    if (outcome !== 'pass' && !note) {
      get('lab-feedback-note').textContent = '请填写操作步骤和实际结果。';
      get('lab-note').focus();
      return;
    }
    const data = { schema: 1, case: chooser.value, result: outcome, revision: report.revision, note };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = `pp-feedback-${chooser.value}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    get('lab-feedback-note').textContent = '已导出。把 JSON 文件发给开发会话，导入后会更新共享进度。';
  });
}
