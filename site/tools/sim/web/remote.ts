import { createPage } from "../../../../upstream/passportsim/web/src/app/page";
import { LIT_PANEL, type RawFrame } from "../../../../upstream/passportsim/web/src/app/capture";
import { EventKind, RingId } from "../../../../upstream/passportsim/web/src/worker/layout";
import { sessionClient, type SessionState } from "./session-client";

export function openSession(id: number, key: string, onNote: (note: string) => void) {
  const mount = document.getElementById("app");
  if (!mount) throw new Error("PassportSim mount is missing");
  let state: SessionState | undefined;
  let receivedFrame = "";
  let serial = "";
  let booting = true;
  const transport = sessionClient(id, key, update, (note) => {
    page.setLease("agent");
    onNote(note);
  });
  const page = createPage({
    mount,
    transport: (request) => {
      const command = JSON.parse(request);
      // Attaching must not change the shared clock. Suppress the local page's first auto-resume.
      if (booting && command.cmd === "clock") {
        if (command.args.op === "resume") booting = false;
        return Promise.resolve(state?.running
          ? { ok: '{"json":{}}' }
          : command.args.op === "set_mode"
            ? { ok: '{"json":{}}' }
            : { err: '{"code":"E_STATE","message":"Session paused"}' });
      }
      return transport(request);
    },
    toWorker: () => {},
    rewindSource: { snapshot: () => new Uint8Array(0), frame: () => null },
    now: () => performance.now(),
    scheduleFrame: (callback) => window.requestAnimationFrame(callback),
    confirm: (message) => window.confirm(message),
    viewport: () => ({ width: innerWidth, height: innerHeight }),
    devicePixelRatio: () => devicePixelRatio,
    storage: () => localStorage,
    search: location.search,
    systemLocale: () => navigator.language,
    readFrame: async (): Promise<RawFrame | null> => {
      const ctx = page.canvas.getContext("2d");
      if (!ctx || !receivedFrame) return null;
      const { width, height } = page.canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      const pixels = new Uint16Array(width * height);
      for (let i = 0; i < pixels.length; i++) {
        const r = data[i * 4] ?? 0, g = data[i * 4 + 1] ?? 0, b = data[i * 4 + 2] ?? 0;
        pixels[i] = (Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255);
      }
      return { width, height, pixels };
    },
  });
  const automation = { call: page.automation.call };
  (globalThis as { passportEmu?: typeof automation }).passportEmu = automation;
  window.addEventListener("resize", () => page.resize());
  window.addEventListener("keydown", (event) => { if (page.key(event, true)) event.preventDefault(); });
  window.addEventListener("keyup", (event) => page.key(event, false));
  window.addEventListener("blur", () => page.releaseControls());
  document.addEventListener("visibilitychange", () => { if (document.hidden) page.releaseControls(); });

  function update(next: SessionState) {
    const first = state === undefined;
    state = next;
    if (first) {
      page.ready();
      page.display({ backend: "canvas2d", reason: null, contextLost: false });
      page.panel({ ...LIT_PANEL, inverted: false });
    }
    page.setLease(next.busy || next.failed ? "agent" : "ui");
    page.stats({ mode: "Wall", nowPs: BigInt(next.vt_us) * 1_000_000n, realTimeFactor: 0, reanchors: 0, sliceVtPs: 0n });
    if (next.image && next.image !== receivedFrame) {
      receivedFrame = next.image;
      const image = new Image();
      image.onload = () => {
        if (image.src === receivedFrame) page.canvas.getContext("2d")?.drawImage(image, 0, 0, page.canvas.width, page.canvas.height);
      };
      image.src = receivedFrame;
      page.events([{ kind: EventKind.Frame, vtPs: BigInt(next.vt_us) * 1_000_000n, arg: BigInt(next.revision) }]);
    }
    const log = next.serial || "";
    if (log !== serial) {
      const offset = log.startsWith(serial) ? serial.length : 0;
      const segment = log.slice(offset);
      serial = log;
      if (segment) page.serial({
        stream: RingId.UsjTx, bytes: new TextEncoder().encode(segment), dropped: 0n, lines: [], linesDropped: 0n,
      });
    }
    onNote(next.activity || (next.running ? `${next.version} · 运行中` : `${next.version} · 已连接`));
  }

  return { end: () => transport(JSON.stringify({ cmd: "end", args: {} })), state: () => state };
}
