import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {md5} from "js-md5";
import {resolvePublishedParts, verifyImage} from "../src/lib/publishedFirmware.ts";

const hash = "a".repeat(64);
function image() { return {parts:["/firmware/boot.bin","/firmware/app.bin"], addresses:["0x0","0x10000"], sizes:[32,48], sha256:[hash,hash]}; }
test("published offsets and complete checksum metadata resolve", () => {
  assert.deepEqual(resolvePublishedParts(image()).map(p=>p.address),[0,65536]);
});
test("misaligned, overlapping erase sectors and out-of-flash writes are refused", () => {
  for (const addresses of [[0,1],[0,0],[0,4096],[0,8*1024*1024],[-4096,65536]]) {
    const value=image(); value.addresses=addresses;
    if (addresses[1]===4096) value.sizes[0]=4097;
    assert.throws(()=>resolvePublishedParts(value));
  }
});
test("missing checksum metadata does not create an unverified install", () => {
  const value=image(); value.sha256=[]; assert.throws(()=>resolvePublishedParts(value));
});
test("download verification accepts exact bytes and rejects corruption / short data", async () => {
  const data=new TextEncoder().encode("PP demo test");
  const expected={size:data.length,sha256:createHash("sha256").update(data).digest("hex")};
  await verifyImage(data,expected);
  await assert.rejects(verifyImage(data.subarray(1),expected),/大小/);
  const changed=data.slice(); changed[0]^=1;
  await assert.rejects(verifyImage(changed,expected),/SHA256/);
});
test("MD5 used by native esptool matches the host digest including padded bytes", () => {
  for (const data of [new Uint8Array(),new Uint8Array([0,1,255,255]),new Uint8Array(8192).fill(3)]) {
    assert.equal(md5(data),createHash("md5").update(data).digest("hex"));
  }
});
