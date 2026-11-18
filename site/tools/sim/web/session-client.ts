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

export function sessionClient(session: number, key: string, onState: (state: SessionState) => void, onNote: (note: string) => void) {
  let socket: WebSocket;
  let ended = false;
  let synced = false;
  let seq = 0;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, (reply: Reply) => void>();
  const fail = (message: string): Reply => ({ err: JSON.stringify({ code: "E_STATE", message }) });

  function connect() {
    clearTimeout(reconnect);
    const address = new URL("./api/session", location.href);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    const connection = new WebSocket(address);
    socket = connection;
    let waiting = false;
    connection.addEventListener("open", () => connection.send(JSON.stringify({ session, key })));
    connection.addEventListener("message", (event) => {
      if (socket !== connection) return;
      const data = JSON.parse(event.data);
      if (data.type === "state") {
        waiting = false;
        synced = true;
        onState(data);
      } else if (data.type === "waiting") {
        waiting = true;
        synced = false;
        onNote(data.message);
      } else if (data.type === "ended") {
        ended = true;
        onNote(data.message);
        connection.close();
      } else if (data.type === "reply") {
        pending.get(data.id)?.({ ok: data.ok, err: data.err });
      }
    });
    connection.addEventListener("close", () => {
      if (socket !== connection) return;
      synced = false;
      for (const settle of pending.values()) settle(fail("连接中断，操作结果未确认"));
      if (!ended) {
        if (!waiting) onNote("连接中断，正在重连");
        reconnect = setTimeout(() => { if (!ended) connect(); }, waiting ? 2000 : 1200);
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
    synced = false;
    clearTimeout(reconnect);
    socket.close();
    for (const settle of pending.values()) settle(fail("页面已离开，操作结果未确认"));
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
