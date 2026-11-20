import { md5 } from "js-md5";
import { checkUpgrade, FLASH_BYTES, TABLE_BYTES, TABLE_OFFSET } from "./upgrade.mjs";

interface Image { address: number; data: Uint8Array }
interface Device {
  chip: { CHIP_NAME: string };
  IS_STUB: boolean;
  FLASH_READ_TIMEOUT: number;
  transport: { read(timeout: number): Promise<Uint8Array> };
  detectFlashSize(): Promise<string | undefined>;
  readFlash(address: number, size: number): Promise<Uint8Array>;
  flashMd5sum(address: number, size: number): Promise<string>;
}

async function readVerified(device: Device, address: number, size: number) {
  const bytes = await device.readFlash(address, size);
  // The 0.7 stub sends the transfer digest after the last data frame.
  const digest = await device.transport.read(device.FLASH_READ_TIMEOUT);
  if (bytes.length !== size || digest.length !== 16 || !md5.array(bytes).every((n, i) => n === digest[i]))
    throw new Error("设备闪存串口读取校验失败，未开始写入。");
  return bytes;
}

export async function changedPPImages(device: Device, images: Image[], policy?: string,
  writeCopy?: (copy: Image) => Promise<void>): Promise<Image[]> {
  if (!device.IS_STUB || device.chip.CHIP_NAME !== "ESP32-C3" || await device.detectFlashSize() !== "8MB")
    throw new Error("保留数据安装仅适用于 8 MB 的 ESP32-C3 PP。");
  const table = images.find(part => part.address === TABLE_OFFSET);
  if (!table) throw new Error("缺少目标分区表。");
  const current = await readVerified(device, TABLE_OFFSET, TABLE_BYTES);
  const blank = current.length === TABLE_BYTES && current.every(n => n === 255) &&
    (await device.flashMd5sum(0, FLASH_BYTES)).toLowerCase() === md5(new Uint8Array(FLASH_BYTES).fill(255));
  const move = checkUpgrade(current, table.data, images.map(p => ({address: p.address, size: p.data.length})), md5, blank, policy);
  const changed = [];
  for (const part of images) {
    const actual = (await device.flashMd5sum(part.address, part.data.length)).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(actual)) throw new Error("设备镜像校验值无效，未开始写入。");
    if (actual !== md5(part.data)) changed.push(part);
  }
  if (move) {
    const data = await readVerified(device, move.source, move.size);
    const expected = md5(data);
    if ((await device.flashMd5sum(move.destination, move.size)).toLowerCase() !== expected) {
      if (!writeCopy) throw new Error("需要支持历史缓存迁移的安装器。");
      await writeCopy({address: move.destination, data});
      if ((await device.flashMd5sum(move.destination, move.size)).toLowerCase() !== expected)
        throw new Error("历史缓存复制校验失败，原分区表仍然有效。");
    }
  }
  return changed;
}
