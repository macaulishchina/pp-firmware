// Adapter for the Worker and command registry in the pinned PassportSim build.
export class Passport {
  constructor(worker, simulator) {
    this.worker = new Worker(`/engine/${worker}-${simulator}/worker.js`, { type: 'module' });
    this.pending = new Set();
    this.sequence = 0;
    this.console = '';
    this.serialCursor = 0;
    this.worker.addEventListener('message', ({ data }) => {
      if (data.type === 'error' || data.type === 'fatal') {
        this.reject(new Error(data.message));
        return;
      }
      for (const request of this.pending) {
        if (request.matches(data)) {
          request.finish(data);
          break;
        }
      }
    });
    this.worker.addEventListener('error', event => this.reject(new Error(event.message || 'PassportSim Worker failed')));
  }

  reject(error) {
    this.error = error;
    for (const request of this.pending) request.finish(null, error);
  }

  close() {
    this.worker.terminate();
    this.reject(new Error('模拟器已关闭'));
  }

  request(message, matches, transfer = []) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const request = { matches, finish: (data, error) => {
        clearTimeout(timer);
        this.pending.delete(request);
        if (error) reject(error);
        else resolve(data);
      } };
      const timer = setTimeout(() => {
        this.reject(new Error(`PassportSim 响应超时（${message.type}）`));
        this.worker.terminate();
      }, 20000);
      this.pending.add(request);
      try {
        this.worker.postMessage(message, transfer);
      } catch (error) {
        request.finish(null, error);
      }
    });
  }

  async boot(image, elf) {
    await this.request({
      type: 'boot', config: JSON.stringify({ fw: 'pa-terminal', seed: 0 }),
      image: new Uint8Array(image), assets: [{ kind: 2, bytes: new Uint8Array(elf) }],
    }, data => data.type === 'ready', [image, elf]);
    await this.call('input', { button: 'usb', action: 'open', then_run: '0ms' });
  }

  async call(cmd, args) {
    const id = ++this.sequence;
    const message = await this.request({ type: 'call', id, request: JSON.stringify({ cmd, args }) },
      reply => reply.type === 'call' && reply.id === id);
    if (message.err) {
      const error = JSON.parse(message.err);
      throw new Error(`${error.code}: ${error.message}`);
    }
    return JSON.parse(message.ok);
  }

  async advance(ms) {
    const { json } = await this.call('run', { for: `${ms}ms`, wall_budget_ms: 12000 });
    if (json.result === 'fail') throw new Error(`固件停止运行（${json.status}）`);
    return json;
  }

  async press(key, ms) {
    return (await this.call('input', {
      button: key, action: 'click', duration: `${ms}ms`, then_run: '160ms',
    })).json;
  }

  async ui() {
    const { json } = await this.call('ui', { max_nodes: 100 });
    return json;
  }

  async readSerial() {
    const { json, text } = await this.call('serial', {
      op: 'read', stream: 'usj', cursor: this.serialCursor, max_bytes: 16000,
    });
    const chunk = json.next_cursor > this.serialCursor && text?.trim() ? text + '\n' : '';
    this.serialCursor = json.next_cursor;
    this.console = (this.console + chunk).slice(-64000);
    return chunk;
  }

  async serial() {
    await this.readSerial();
    return this.console;
  }

  async send(line) {
    await this.readSerial();
    await this.call('serial', { op: 'write', stream: 'usj', text: line, newline: true });
    await this.advance(400);
    return this.readSerial();
  }

  async screen() {
    const frame = await this.request({ type: 'frame' }, reply => reply.type === 'frame');
    if (!frame.pixels || frame.width !== 240 || frame.height !== 320) throw new Error('LCD 帧不可用');
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(canvas.width, canvas.height);
    frame.pixels.forEach((word, pixel) => {
      const index = pixel * 4;
      image.data[index] = ((word >> 11) & 31) * 255 / 31;
      image.data[index + 1] = ((word >> 5) & 63) * 255 / 63;
      image.data[index + 2] = (word & 31) * 255 / 31;
      image.data[index + 3] = 255;
    });
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }
}
