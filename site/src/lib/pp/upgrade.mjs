// ESP-IDF partition table is the on-device storage contract. Both installers run
// this planner before issuing any erase/write command. No release-version pairs.
export const FLASH_BYTES = 0x800000;
export const TABLE_OFFSET = 0x8000;
export const TABLE_BYTES = 0xc00;
const APP_OFFSET = 0x10000;
const SECTOR = 0x1000;

function parseTable(bytes, md5) {
  if (bytes.length !== TABLE_BYTES) throw new Error("分区表读取不完整，已停止安装。");
  const rows = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length; i += 32) {
    const magic = view.getUint16(i, true);
    if (magic === 0xebeb) {
      const checksum = Array.from(bytes.subarray(i + 16, i + 32), n => n.toString(16).padStart(2, "0")).join("");
      if (!bytes.subarray(i + 2, i + 16).every(n => n === 255) ||
          !bytes.subarray(i + 32).every(n => n === 255) || md5(bytes.subarray(0, i)) !== checksum)
        throw new Error("分区表校验失败，已停止安装。");
      const app = rows.get("factory");
      if (!app || app.type !== 0 || app.subtype !== 0 || app.start !== APP_OFFSET || app.flags !== 0 ||
          !Array.from(rows.values()).some(row => row.type === 1 && row.subtype === 2 && row.name === "nvs"))
        throw new Error("无法识别此设备的 PP 分区布局。");
      return rows;
    }
    if (magic !== 0x50aa) break;
    const type = bytes[i + 2], subtype = bytes[i + 3];
    const start = view.getUint32(i + 4, true), size = view.getUint32(i + 8, true);
    const raw = bytes.subarray(i + 12, i + 28);
    const nul = raw.indexOf(0);
    const name = String.fromCharCode(...raw.subarray(0, nul < 0 ? raw.length : nul));
    const flags = view.getUint32(i + 28, true);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || (nul >= 0 && !raw.subarray(nul).every(n => n === 0)) ||
        rows.has(name) || !size || start % SECTOR || size % SECTOR || start < TABLE_OFFSET + SECTOR ||
        start + size > FLASH_BYTES || (type === 0 && name !== "factory") ||
        Array.from(rows.values()).some(r => start < r.start + r.size && r.start < start + size))
      throw new Error("存在无法识别、重复或重叠的分区，已停止安装。");
    rows.set(name, {name, type, subtype, start, size, flags});
  }
  throw new Error("缺少有效的 ESP-IDF 分区表校验记录，已停止安装。");
}

// A blank table alone is ambiguous after an interrupted/manual erase. The
// transport must independently verify a blank chip before treating it as new.
export function checkUpgrade(current, target, parts, md5, blankChip = false, policy = "pp-data-v1") {
  if (!["pp-data-v1", "pp-data-v2"].includes(policy)) throw new Error("未知升级策略。");
  const next = parseTable(target, md5);
  const limits = new Map([[0, TABLE_OFFSET], [TABLE_OFFSET, TABLE_BYTES], [APP_OFFSET, next.get("factory").size]]);
  if (parts.length !== limits.size) throw new Error("固件必须包含引导、分区表和应用三段镜像。");
  for (const {address, size} of parts) {
    const limit = limits.get(address);
    if (!limit || !Number.isSafeInteger(size) || size <= 0 || size > limit ||
        (address === TABLE_OFFSET && size !== TABLE_BYTES))
      throw new Error("镜像地址或擦写范围超出允许的分区。");
    limits.delete(address);
  }
  if (current.length === TABLE_BYTES && current.every(n => n === 255) && blankChip) return null;
  const previous = parseTable(current, md5);
  // Only this exact transfer may reclaim part of the old disposable audio ring.
  // A different data partition or an older factory app may own that range.
  const matches = (rows, name, subtype, start, size) => {
    const p = rows.get(name);
    return p?.type === 1 && p.subtype === subtype && p.start === start && p.size === size && p.flags === 0;
  };
  const moveHistory = policy === "pp-data-v2" &&
    matches(previous, "pp_cache", 0x83, 0x780000, 0x80000) &&
    matches(previous, "pp_stream", 0x40, 0x400000, 0x380000) &&
    matches(next, "pp_stream", 0x40, 0x400000, 0x300000) &&
    matches(next, "pp_cache", 0x83, 0x700000, 0x100000);
  for (const row of previous.values()) {
    if (moveHistory && (row.name === "pp_cache" || row.name === "pp_stream")) continue;
    if (row.type === 0) continue;
    const to = next.get(row.name);
    if (!to || row.start !== to.start || row.size !== to.size || row.type !== to.type ||
        row.subtype !== to.subtype || row.flags !== to.flags)
      throw new Error(`升级会改变已有数据分区「${row.name}」，需要专门的迁移方案。未开始写入。`);
  }
  return moveHistory ? {source: 0x780000, destination: 0x700000, size: 0x80000} : null;
}
