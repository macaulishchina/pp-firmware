/** Local catalog adaptation. Esptool retains ownership of device transport. */
export interface PublishedPart {
  url: string;
  address: number;
  size: number;
  sha256: string;
}
export interface PublishedImage {
  parts: string[];
  addresses: (string | number)[];
  sizes: number[];
  sha256: string[];
}
export function resolvePublishedParts(image: PublishedImage): PublishedPart[] {
  const count = image?.parts?.length;
  if (!count || !Array.isArray(image.addresses) || !Array.isArray(image.sizes) || !Array.isArray(image.sha256) ||
      image.addresses.length !== count || image.sizes.length !== count || image.sha256.length !== count) {
    throw new Error("固件清单缺少完整的文件、地址、大小或 SHA256，请重新发布该版本。");
  }
  let end = 0;
  return image.parts.map((url, i) => {
    const address = typeof image.addresses[i] === "number" ? image.addresses[i] as number : Number(image.addresses[i]);
    const size = image.sizes[i];
    if (!Number.isSafeInteger(address) || address < 0 || address % 4096 ||
        !Number.isSafeInteger(size) || size <= 0 || address + size > 8 * 1024 * 1024 || address < end ||
        !/^[a-f0-9]{64}$/i.test(image.sha256[i]) || typeof url !== "string" || !url) {
      throw new Error("固件地址、扇区范围或校验值无效，未开始写入。");
    }
    // Each write erases complete sectors, even when eraseAll is false.
    end = Math.ceil((address + size) / 4096) * 4096;
    return {url, address, size, sha256: image.sha256[i].toLowerCase()};
  });
}
export async function verifyImage(data: Uint8Array, expected: {size: number; sha256: string}): Promise<void> {
  if (data.byteLength !== expected.size) throw new Error("固件下载大小不符，未开始写入。请重新下载。");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer);
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.sha256.toLowerCase()) throw new Error("固件 SHA256 校验失败，未开始写入。");
}
