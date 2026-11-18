import type { CommandTransport } from "../../../../upstream/passportsim/web/src/api/client";

export interface SessionState {
  type: "state";
  revision: number;
  version: string;
  image?: string;
  serial?: string;
  ui: { text?: string };
  vt_us: number;
  running: boolean;
  busy: boolean;
  failed?: boolean;
  activity: string;
}

type Reply = { ok?: string; err?: string };

export function sessionClient(session: string, onState: (state: SessionState) => void, onNote: (note: string) => void) {
  let socket: WebSocket;
  let ended = false;
  let synced = false;
  let seq = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  const fail = (message: string): Reply => ({ err: JSON.stringify({ code: "E_STATE", message }) });

  function connect() {
    const address = new URL("./api/session", location.href);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(address);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ session })));
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "state") {
        synced = true;
        onState(data);
      } else if (data.type === "ended") {
        ended = true;
        onNote(data.message);
        socket.close();
      } else if (data.type === "reply") {
        pending.get(data.id)?.({ ok: data.ok, err: data.err });
      }
    });
    socket.addEventListener("close", () => {
      synced = false;
      for (const settle of pending.values()) settle(fail("连接中断，操作结果未确认"));
      if (!ended) {
        onNote("连接中断，正在重连");
        setTimeout(() => { if (!ended) connect(); }, 1200);
      }
    });
  }

  const transport: CommandTransport = (request) => {
    if (!synced || socket.readyState !== WebSocket.OPEN) return Promise.resolve(fail("会话尚未连接"));
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => pending.get(id)?.(fail("操作结果未确认，请查看当前状态")), 25_000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(reply);
      });
      try {
        socket.send(JSON.stringify({ ...JSON.parse(request), id }));
      } catch {
        pending.get(id)?.(fail("操作发送失败"));
      }
    });
  };
  window.addEventListener("pagehide", () => {
    ended = true;
    socket.close();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      ended = false;
      connect();
    }
  });
  connect();
  return transport;
}
