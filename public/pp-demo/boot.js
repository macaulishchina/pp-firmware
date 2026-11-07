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
  document.querySelectorAll('.control-panel button').forEach(button => { button.disabled = true; });
});
