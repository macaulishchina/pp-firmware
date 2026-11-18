import { mountLabPanel } from './lab/workbench.js';

document.querySelector('.panel-nav').addEventListener('click', event => {
  const selected = event.target.closest('button[data-panel]');
  if (!selected) return;
  for (const button of document.querySelectorAll('.panel-nav button')) {
    button.setAttribute('aria-pressed', String(button === selected));
    document.getElementById(button.getAttribute('aria-controls')).hidden = button !== selected;
  }
});
mountLabPanel();

// Invalid scene declarations must show a useful diagnosis instead of a blank device.
import('./demo.js').catch(error => {
  const host = document.getElementById('device-host');
  host.replaceChildren();
  const message = document.createElement('p');
  message.className = 'startup-error';
  message.setAttribute('role', 'alert');
  message.textContent = `演示未启动：${error.message || '请检查场景声明与静态资源。'}`;
  host.append(message);
  document.getElementById('stage-status').textContent = '演示配置需要修正';
  document.querySelectorAll('.control-panel section:not(#panel-lab) button').forEach(button => { button.disabled = true; });
});
