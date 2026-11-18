const params = new URLSearchParams(location.search);
const id = params.get("session");
type Share = { session: number; key: string };

function readShare(address: URL): Share | null {
  const number = address.searchParams.get("session");
  const key = new URLSearchParams(address.hash.slice(1)).get("key");
  if (!number || !/^(?:0|[1-9][0-9]{0,15})$/.test(number) || !Number.isSafeInteger(Number(number))
      || !key || !/^[a-f0-9]{48}$/.test(key)) return null;
  return { session: Number(number), key };
}

const share = readShare(new URL(location.href));
const cn = (params.get("lang") || navigator.language).startsWith("zh");
const words = cn ? {
  heading: "共享会话", create: "新建会话", join: "打开会话", copy: "复制链接",
  session: "会话链接", image: "固件版本", end: "结束会话", local: "本地模拟",
  copied: "已复制会话链接", invalid: "请使用完整会话链接", connecting: "正在连接…", waiting: "正在启动…",
  endConfirm: "关闭这台模拟设备？所有成员都会断开。", unavailable: "共享会话服务暂不可用",
  wait: "等待空位", cancelWait: "取消等待", cancelled: "已取消等待", interrupted: "等待连接已断开",
  position: (number: number) => `正在等待空位 · 第 ${number} 位`,
  replace: "顶掉最久未活动的实例",
  replaceConfirm: "如果仍然满额，将结束最久未活动的会话。原成员会断开，正在运行的场景会中断。继续新建？",
} : {
  heading: "Shared sessions", create: "New session", join: "Open session", copy: "Copy link",
  session: "Session link", image: "Firmware version", end: "End session", local: "Local emulator",
  copied: "Session link copied", invalid: "Enter the full session link", connecting: "Connecting…", waiting: "Starting…",
  endConfirm: "Stop this emulator for everyone in the session?", unavailable: "Session service unavailable",
  wait: "Wait for a slot", cancelWait: "Cancel wait", cancelled: "Wait cancelled", interrupted: "Queue disconnected",
  position: (number: number) => `Waiting for a slot · position ${number}`,
  replace: "Replace least recently active",
  replaceConfirm: "If all slots are still occupied, the least recently active session will end and its running scenario will be interrupted. Create anyway?",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function button(text: string) {
  const node = element("button", text);
  node.type = "button";
  return node;
}

function url(link: Share | null) {
  const address = new URL(location.href);
  if (link) {
    address.searchParams.set("session", String(link.session));
    address.hash = new URLSearchParams({ key: link.key }).toString();
  } else {
    address.searchParams.delete("session");
    address.hash = "";
  }
  return address;
}

const status = element("output");
status.setAttribute("role", "status");
const bar = element("section");
bar.className = "pp-session-bar";
bar.setAttribute("aria-label", words.heading);
bar.append(element("strong", share ? `${words.heading} #${share.session}` : words.heading));
document.getElementById("app")?.before(bar);

const input = element("input");
input.type = "text";
input.placeholder = words.session;
input.setAttribute("aria-label", words.session);
const join = button(words.join);
const joinForm = element("form");
join.type = "submit";
joinForm.append(input, join);
joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const address = new URL(input.value.trim());
    const link = readShare(address);
    if (address.origin !== location.origin || address.pathname !== location.pathname || !link) {
      status.textContent = words.invalid;
      return;
    }
    location.assign(url(link));
  } catch {
    status.textContent = words.invalid;
  }
});

if (id === null) {
  // Keep the upstream browser-hosted emulator entry intact.
  void import(new URL("./main.js", import.meta.url).href);
  const firmware = element("select");
  firmware.setAttribute("aria-label", words.image);
  const create = button(words.create);
  const wait = button(words.wait);
  const replace = button(words.replace);
  const cancelWait = button(words.cancelWait);
  wait.hidden = replace.hidden = cancelWait.hidden = true;
  let waiting: WebSocket | undefined;
  create.disabled = true;
  bar.append(firmware, create, wait, replace, cancelWait, joinForm, status);
  function finishWaiting(message: string) {
    const socket = waiting;
    waiting = undefined;
    socket?.close();
    firmware.disabled = create.disabled = false;
    cancelWait.hidden = true;
    wait.hidden = replace.hidden = false;
    status.textContent = message;
  }
  void fetch("./api/catalog", { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error();
    for (const item of await response.json()) firmware.add(new Option(item.version, item.image));
    create.disabled = !firmware.options.length;
    if (create.disabled) status.textContent = words.unavailable;
  }).catch(() => { status.textContent = words.unavailable; });
  async function submit(replaceOldest = false) {
    wait.hidden = replace.hidden = true;
    status.textContent = words.waiting;
    create.disabled = true;
    try {
      const response = await fetch("./api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: firmware.value, replace_oldest: replaceOldest }),
      });
      const data = await response.json();
      if (response.status === 409 && data.code === "capacity") wait.hidden = replace.hidden = false;
      if (!response.ok) throw new Error(data.error || words.unavailable);
      location.assign(url(data));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : words.unavailable;
      create.disabled = false;
      if (replaceOldest) wait.hidden = replace.hidden = false;
    }
  }
  create.onclick = () => void submit();
  replace.onclick = () => {
    if (confirm(words.replaceConfirm)) void submit(true);
  };
  wait.onclick = () => {
    const address = new URL("./api/wait", location.href);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(address);
    waiting = socket;
    status.textContent = words.connecting;
    wait.hidden = replace.hidden = true;
    cancelWait.hidden = false;
    firmware.disabled = create.disabled = true;
    socket.onopen = () => socket.send(JSON.stringify({ image: firmware.value }));
    socket.onmessage = (event) => {
      if (waiting !== socket) return;
      const data = JSON.parse(event.data);
      if (data.type === "queue") status.textContent = words.position(data.position);
      if (data.type === "error") finishWaiting(data.message);
      if (data.type === "created") {
        waiting = undefined;
        location.assign(url(data));
      }
    };
    socket.onclose = () => {
      if (waiting === socket) finishWaiting(words.interrupted);
    };
  };
  cancelWait.onclick = () => finishWaiting(words.cancelled);
} else {
  // Navigation between two links for the same number can change only the fragment.
  window.addEventListener("hashchange", () => location.reload());
  const local = element("a", words.local);
  local.href = url(null).href;
  const copy = button(words.copy);
  const end = button(words.end);
  end.hidden = share?.session === 0;
  bar.append(copy, end, local, joinForm, status);
  end.disabled = true;
  if (!share) {
    status.textContent = words.invalid;
    copy.disabled = true;
  } else {
    status.textContent = words.connecting;
    const { openSession } = await import("./remote");
    document.documentElement.classList.add("pp-remote");
    const session = openSession(share.session, share.key, (note) => {
      status.textContent = note;
      end.disabled = !session.state() || Boolean(session.state()?.busy);
    });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url(share).href);
        status.textContent = words.copied;
      } catch {
        input.value = url(share).href;
        input.select();
      }
    };
    end.onclick = async () => {
      if (!confirm(words.endConfirm)) return;
      const { err } = await session.end();
      if (err) status.textContent = JSON.parse(err).message;
    };
  }
}
