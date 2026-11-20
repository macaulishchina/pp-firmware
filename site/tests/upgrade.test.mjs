import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkUpgrade, FLASH_BYTES, TABLE_BYTES, TABLE_OFFSET } from "../src/lib/pp/upgrade.mjs";
import { changedPPImages } from "../src/lib/pp/install.ts";
import { resolvePublishedParts } from "../src/lib/publishedFirmware.ts";

const digest = data => createHash("md5").update(data).digest();
const md5 = data => digest(data).toString("hex");
const original = [
  ["nvs", 1, 2, 0x9000, 0x6000],
  ["phy_init", 1, 1, 0xf000, 0x1000],
  ["factory", 0, 0, 0x10000, 0x770000],
  ["pp_cache", 1, 0x83, 0x780000, 0x80000],
];
const expanded = [...original.slice(0, 2), ["factory", 0, 0, 0x10000, 0x3f0000],
  ["pp_stream", 1, 0x40, 0x400000, 0x380000], original[3]];

function table(rows) {
  const buf = Buffer.alloc(TABLE_BYTES, 255);
  rows.forEach(([name, type, subtype, start, length, flags = 0], i) => {
    const at = i * 32;
    buf.writeUInt16LE(0x50aa, at);
    buf[at+2] = type;
    buf[at+3] = subtype;
    buf.writeUInt32LE(start, at+4);
    buf.writeUInt32LE(length, at+8);
    buf.fill(0, at+12, at+28);
    buf.write(name, at+12);
    buf.writeUInt32LE(flags, at+28);
  });
  const end = rows.length * 32;
  buf.writeUInt16LE(0xebeb, end);
  digest(buf.subarray(0, end)).copy(buf, end+16);
  return buf;
}

const images = [ {address: 0, data: Buffer.from("boot")}, {address: TABLE_OFFSET, data: table(expanded)},
  {address: 0x10000, data: Buffer.from("app")} ];
const parts = images.map(({address, data}) => ({address, size: data.length}));
const verify = (from, to) => checkUpgrade(table(from), table(to), parts, md5);
test("compatible additions from unused app space pass; rollback losing data fails", () => {
  verify(original, expanded);
  verify(expanded, expanded);
  assert.throws(() => verify(expanded, original), /pp_stream/);
});
test("existing data cannot move, shrink, grow, rename, change identity or flags", () => {
  const rows = [...expanded.slice(0, -1), ["future", 0x40, 1, 0x780000, 0x2000]];
  for (const [index, value] of [[0,"other"], [1,2], [2,2], [3,0x782000], [4,0x1000], [4,0x3000], [5,1]]) {
    const next = structuredClone(rows);
    next.at(-1)[index] = value;
    assert.throws(() => verify(rows, next), /future/);
  }
  assert.throws(() => verify(rows, rows.slice(0,-1)), /future/);
});
test("corruption, overlap, unaligned partitions, unsupported apps and unchecked writes are rejected", () => {
  const valid = table(expanded);
  const bad = Buffer.from(valid);
  bad[45] ^= 1;
  assert.throws(() => checkUpgrade(bad, valid, parts, md5));
  assert.throws(() => checkUpgrade(valid, bad, parts, md5));
  for (const row of [["nvs",1,2,0xa000,4096], ["new",1,2,0x781000,4096], ["other",0,1,0x780000,4096]]) {
    assert.throws(() => verify(expanded, [...expanded, row]));
  }
  for (const part of [{address:0x9000,size:1}, {address:0x10000,size:0x3f0001}, {address:0,size:1}]) {
    assert.throws(() => checkUpgrade(valid,valid,[...parts.slice(0,2),part],md5));
  }
  assert.throws(() => resolvePublishedParts({upgrade_policy:"future"}), /更新安装器/);
});
function device(current) {
  const byAddress = new Map(images.map(p=>[p.address,p.data]));
  byAddress.set(TABLE_OFFSET,current);
  return { IS_STUB:true, chip:{CHIP_NAME:"ESP32-C3"}, detectFlashSize:async()=>"8MB",
    readFlash:async()=>current, FLASH_READ_TIMEOUT:5000, transport:{read:async()=>digest(current)},
    flashMd5sum:async(address)=>md5(byAddress.get(address)) };
}
test("USB preflight selects only changed parts and verifies readback frame", async () => {
  assert.deepEqual(await changedPPImages(device(table(expanded)), images), []);
  assert.deepEqual((await changedPPImages(device(table(original)), images)).map(p=>p.address), [TABLE_OFFSET]);
  const broken = device(table(expanded));
  broken.transport.read = async()=>Buffer.alloc(16, 3);
  await assert.rejects(changedPPImages(broken,images), /串口/);
  broken.IS_STUB = false;
  await assert.rejects(changedPPImages(broken,images), /ESP32-C3/);
});
test("a blank table requires evidence that the entire chip is erased", async () => {
  const empty = device(Buffer.alloc(TABLE_BYTES,255));
  empty.flashMd5sum = async()=>md5(Buffer.from("other"));
  await assert.rejects(changedPPImages(empty,images), /分区表/);
  empty.flashMd5sum = async(_address,size)=>md5(Buffer.alloc(size,255));
  assert.equal((await changedPPImages(empty,images)).length,3);
  assert.equal(FLASH_BYTES,0x800000);
});

const splitCache = [...expanded.slice(0, 3), ["pp_stream", 1, 0x40, 0x400000, 0x300000],
  ["pp_cache", 1, 0x83, 0x700000, 0x100000]];
test("only the known temporary-to-history transfer is allowed and it cannot be downgraded", () => {
  const plan = (from, to, policy) => checkUpgrade(table(from), table(to), parts, md5, false, policy);
  assert.deepEqual(plan(expanded, splitCache, "pp-data-v2"), {source:0x780000, destination:0x700000, size:0x80000});
  assert.equal(plan(splitCache, splitCache, "pp-data-v2"), null);
  assert.throws(() => plan(expanded, splitCache, "pp-data-v1"));
  assert.throws(() => plan(original, splitCache, "pp-data-v2"));
  assert.throws(() => plan(splitCache, expanded, "pp-data-v2"));
  const altered = structuredClone(splitCache);
  altered[0][4] -= 0x1000;
  assert.throws(() => plan(expanded, altered, "pp-data-v2"), /nvs/);
});

test("history migration verifies the copy before offering the table and can resume", async () => {
  const data = Buffer.alloc(FLASH_BYTES, 255);
  table(expanded).copy(data, TABLE_OFFSET);
  data.fill(0x51, 0x780000);
  const before = Buffer.from(data);
  const target = images.map(p => p.address === TABLE_OFFSET ? {...p,data:table(splitCache)} : p);
  let last, writes = 0;
  const stub = {...device(table(expanded)),
    readFlash: async (addr, size) => last = data.subarray(addr, addr + size),
    transport: {read: async () => digest(last)},
    flashMd5sum: async (addr, size) => md5(data.subarray(addr, addr + size))
  };
  await assert.rejects(changedPPImages(stub, target, "pp-data-v2", async () => {}), /复制校验/);
  const write = async part => {
    assert.equal(part.address, 0x700000);
    assert.equal(part.data.length, 0x80000);
    data.set(part.data, part.address);
    writes++;
  };
  for (let i = 0; i < 2; i++)
    assert.ok((await changedPPImages(stub, target, "pp-data-v2", write)).some(p => p.address === TABLE_OFFSET));
  assert.equal(writes, 1);
  assert.deepEqual(data.subarray(0, 0x700000), before.subarray(0, 0x700000));
  assert.deepEqual(data.subarray(0x700000,0x780000), before.subarray(0x780000));
  assert.deepEqual(data.subarray(0x780000), before.subarray(0x780000));
});
