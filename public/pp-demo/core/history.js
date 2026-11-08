import { textPages } from './pagination.js';
/** In-memory server fixture + separately bounded device cache. No network or persistence. */
export class DemoHistory {
  constructor(catalog, { maxRecords = 3, maxBytes = 4096 } = {}) {
    this.maxRecords = maxRecords; this.maxBytes = maxBytes;
    this.server = [];
    this.cache = new Map();
    this.enabled = true;
    this.sequence = 0;
    const scenes = Object.values(catalog);
    for (const scene of [...scenes].reverse()) this.save(scene.prompt, scene.reply, false, scene.image);
    for (const record of this.server.slice(0, 2).reverse()) this.remember(record);
  }
  get bytes() { return [...this.cache.values()].reduce((sum, r) => sum + this.size(r), 0); }
  size(record) { return new TextEncoder().encode(JSON.stringify(record)).length; }
  save(prompt, reply, cache = true, image = null) {
    const record = Object.freeze({ id: `demo-turn-${++this.sequence}`, prompt, reply, image,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) });
    this.server.unshift(record);
    // Only the simulated server keeps older turns; the device cache has its own bounds.
    this.server.length = Math.min(64, this.server.length);
    if (cache) this.remember(record);
    return record;
  }
  remember(record) {
    if (!this.enabled || this.size(record) > this.maxBytes) return false;
    this.cache.delete(record.id);
    this.cache.set(record.id, record);
    while (this.cache.size > this.maxRecords || this.bytes > this.maxBytes) this.cache.delete(this.cache.keys().next().value);
    return true;
  }
  cached(id) {
    const record = this.cache.get(id);
    if (record) this.remember(record);
    return record;
  }
  get latestId() { return this.sequence ? `demo-turn-${this.sequence}` : null; }
  neighborId(id, direction) {
    // Sequential IDs stand in for opaque server cursors in this fixed local fixture.
    const sequence = Number(id.slice('demo-turn-'.length)) + direction;
    return sequence >= Math.max(1, this.sequence - 63) && sequence <= this.sequence ? `demo-turn-${sequence}` : null;
  }
  read(id) { return this.server.find(record => record.id === id); }
  pages(record, capacity = 104) {
    const result = [['你说的', record.prompt], ['回复', record.reply]].flatMap(([role, text]) => {
      return textPages(text, 13, Math.max(1, Math.min(8, Math.floor(capacity / 13)))).map(text => ({ role, text }));
    });
    if (record.image) result.push({ role: '回复 · 图片', text: '', image: record.image });
    return result;
  }
  clearCache() { this.cache.clear(); }
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.clearCache();
  }
}
