export const FLASH_BYTES: number;
export const TABLE_OFFSET: number;
export const TABLE_BYTES: number;
export function checkUpgrade(current: Uint8Array, target: Uint8Array, parts: {address: number; size: number}[],
  md5: (bytes: Uint8Array) => string, blankChip?: boolean, policy?: string): {source: number; destination: number; size: number} | null;
