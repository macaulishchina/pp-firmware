import { Passport } from '/engine.js';

globalThis.bootPassport = async ({ worker, simulator, flashBytes, elfBytes }) => {
  const response = await fetch('/boot-data');
  if (!response.ok) throw new Error('Firmware data unavailable');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== flashBytes + elfBytes) throw new Error('Incomplete firmware data');
  const machine = new Passport(worker, simulator);
  await machine.boot(bytes.slice(0, flashBytes), bytes.slice(flashBytes));
  await machine.advance(1650);
  globalThis.passport = machine;
};
