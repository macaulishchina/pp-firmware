"""Shared PassportSim instances and their public and local control interfaces."""
import asyncio
from collections import deque
from contextlib import suppress
import json
import os
import re
import secrets
from time import monotonic

from aiohttp import WSMsgType, web

import pp_scenario
from pp_sim import DEFAULT_SESSION_IDLE_HOURS
from pp_sim_runtime import run_site, runtime


SESSION_ID = re.compile(r"[a-f0-9]{48}")
BUTTONS = {"up", "ok", "down", "power"}
MAX_PEERS = 16
TICK_SECONDS = 0.25
REJOIN_SECONDS = 10
IDLE_ENDED = "会话因空闲超时已结束"
REPLACED_ENDED = "该会话已被新建会话顶掉"
MAX_WAITERS = 12


class SessionError(Exception):
    def __init__(self, message, status=409, *, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


def at_capacity():
    return SessionError("所有模拟实例都在使用中", code="capacity")


class Session:
    def __init__(self, ident, image, machine, idle_timeout):
        self.ident = ident
        self.image = image
        self.machine = machine
        self.idle_timeout = idle_timeout
        self.touch()
        self.rejoin_until = 0
        self.peers = set()
        self.lock = asyncio.Lock()
        self.joined = asyncio.Event()
        self.held = {}
        self.running = False
        self.busy = False
        self.activity = ""
        self.result = None
        self.job = None
        self.vt_us = 0
        self.snapshot = {}
        self.ticker = None
        self.closed = False
        self.closed_message = "会话已结束"

    def touch(self):
        self.last_used = self.last_access = monotonic()

    def idle(self, now):
        return not (self.peers or self.busy or self.lock.locked() or self.rejoin_until > now)

    def expired(self, now):
        return not (self.busy or self.lock.locked()) and now - self.last_access >= self.idle_timeout

    async def capture(self):
        try:
            tree = await self.machine.invoke("ui")
            self.snapshot = {
                "type": "state",
                "version": self.machine.meta["version"],
                "revision": self.snapshot.get("revision", 0) + 1,
                "image": await self.machine.invoke("screen"),
                "serial": await self.machine.invoke("serial"),
                "ui": tree,
                "vt_us": self.vt_us,
                "running": self.running,
                "busy": self.busy,
                "activity": self.activity,
            }
        except Exception:
            self.running = False
            self.snapshot = {
                **self.snapshot, "type": "state", "failed": True, "running": False,
                "busy": self.busy, "activity": "模拟器响应失败，请结束会话并新建",
                "revision": self.snapshot.get("revision", 0) + 1,
            }
        for peer in self.peers:
            peer.set()

    async def advance(self, ms):
        result = await self.machine.invoke("advance", ms)
        self.vt_us = result.get("vt_us", self.vt_us + ms * 1000)

    async def tick(self):
        while True:
            await asyncio.sleep(TICK_SECONDS)
            if not self.peers or self.busy or self.lock.locked() or not (self.running or self.held):
                continue
            if self.expired(monotonic()):
                continue
            async with self.lock:
                try:
                    await self.advance(int(TICK_SECONDS * 1000))
                except Exception:
                    self.running = False
                    self.held.clear()
                await self.capture()

    async def close(self):
        self.closed = True
        for peer in self.peers:
            peer.set()
        tasks = [task for task in (self.job, self.ticker) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.machine.close()

    async def command(self, peer, cmd, args):
        if self.closed:
            raise SessionError("会话已结束", 404)
        if cmd == "ui":
            return {"json": self.snapshot.get("ui", {})}
        if cmd == "status" and not args:
            return {"json": {key: self.snapshot.get(key) for key in ("version", "running", "busy", "vt_us", "activity")}}
        if cmd == "serial" and args.get("op") == "read":
            return {"json": {}, "text": self.snapshot.get("serial", "")}
        if self.busy:
            raise SessionError("自动验收进行中")
        async with self.lock:
            if self.busy or self.closed:
                raise SessionError("当前无法操作会话")
            if cmd == "input":
                output = await self.input(peer, args)
            elif cmd == "serial" and args.get("op") == "write":
                text = args.get("text")
                if not isinstance(text, str) or args.get("stream", "usj") != "usj":
                    raise SessionError("共享会话使用 USB 串口", 400)
                line = text.removesuffix("\n").removesuffix("\r")
                if not 0 < len(line) <= 128 or "\n" in line or "\r" in line:
                    raise SessionError("串口命令需为一行，最多 128 个字符", 400)
                output = {"json": {}, "text": await self.machine.invoke("send", line)}
            elif cmd == "clock":
                operation = args.get("op")
                if operation == "resume":
                    self.running = True
                elif operation == "pause":
                    self.running = False
                elif operation == "step":
                    await self.advance(1)
                elif operation != "set_mode" or args.get("mode") != "realtime":
                    raise SessionError("共享会话不支持该时钟操作", 400)
                output = {"json": {"vt_us": self.vt_us, "running": self.running}}
            else:
                raise SessionError("共享会话不支持该操作", 400)
            self.touch()
            await self.capture()
            return output

    async def input(self, peer, args):
        button, action = args.get("button"), args.get("action", "click")
        if not isinstance(button, str) or button not in BUTTONS:
            raise SessionError("不支持该按键", 400)
        owner = self.held.get(button)
        pressed_at = self.vt_us
        if action == "click":
            duration = args.get("duration", "210ms")
            if not isinstance(duration, str) or not re.fullmatch(r"[1-9][0-9]{1,3}ms", duration):
                raise SessionError("按键时长无效", 400)
            ms = int(duration[:-2])
            if owner or not 40 <= ms <= 1200:
                raise SessionError("按键正被按住或时长无效")
            await self.machine.invoke("press", button, ms)
            self.vt_us += (ms + 160) * 1000
        elif action == "press":
            if owner:
                raise SessionError("按键正被按住")
            await self.machine.invoke("call", "input", {"button": button, "action": "press"})
            self.held[button] = peer
            await self.advance(85)
        elif action == "release":
            if owner != peer or owner is None:
                return {"json": {"vt_us": self.vt_us}}
            await self.release_button(button)
        else:
            raise SessionError("不支持该按键动作", 400)
        return {"json": {"vt_us": pressed_at}}

    async def release_button(self, button):
        self.held.pop(button, None)
        await self.machine.invoke("call", "input", {"button": button, "action": "release"})
        await self.advance(160)

    async def disconnect(self, peer):
        self.peers.discard(peer)
        self.last_used = monotonic()
        self.rejoin_until = self.last_used + REJOIN_SECONDS
        if self.closed or not any(owner == peer for owner in self.held.values()):
            return
        async with self.lock:
            if self.closed:
                return
            for button in [key for key, owner in self.held.items() if owner == peer]:
                with suppress(Exception):
                    await self.release_button(button)
            await self.capture()


class Sessions:
    def __init__(self, lab, engine, limit, idle_timeout=DEFAULT_SESSION_IDLE_HOURS * 3600):
        self.lab = lab
        self.engine = engine
        self.limit = limit
        self.idle_timeout = idle_timeout
        self.items = {}
        self.creating = asyncio.Lock()
        self.recent_requests = deque()
        self.waiters = deque()
        self.replaced = deque(maxlen=64)

    def get(self, ident):
        if not isinstance(ident, str) or not SESSION_ID.fullmatch(ident) or ident not in self.items:
            if isinstance(ident, str) and ident in self.replaced:
                raise SessionError(REPLACED_ENDED, 404)
            raise SessionError("会话不存在或已结束", 404)
        room = self.items[ident]
        if room.expired(monotonic()):
            raise SessionError(IDLE_ENDED, 404)
        return room

    async def expire(self):
        now = monotonic()
        expired = [room for room in self.items.values() if room.expired(now)]
        for room in expired:
            self.remove(room)
            room.closed_message = IDLE_ENDED
        await asyncio.gather(*(room.close() for room in expired), return_exceptions=True)

    async def reap(self):
        interval = max(0.1, min(30, self.idle_timeout))
        while True:
            await asyncio.sleep(interval)
            await self.expire()

    def public_admission(self):
        now = monotonic()
        while self.recent_requests and self.recent_requests[0] + 60 < now:
            self.recent_requests.popleft()
        if len(self.recent_requests) >= 12:
            raise SessionError("创建请求过多，请稍后重试", 429)
        self.recent_requests.append(now)

    def idle_room(self, now):
        return min((room for room in self.items.values() if room.idle(now)),
                   key=lambda item: item.last_used, default=None)

    def has_capacity(self):
        now = monotonic()
        return (not self.limit or len(self.items) < self.limit or self.idle_room(now) is not None
                or any(room.expired(now) for room in self.items.values()))

    async def wait_for_room(self, image, report, *, public=True):
        if not isinstance(image, str) or (public and not image.startswith("release:")):
            raise SessionError("请选择已发布固件", 400)
        if len(self.waiters) >= MAX_WAITERS:
            raise SessionError("等候人数已满，请稍后重试", 429)
        if public:
            self.public_admission()
        ticket = object()
        self.waiters.append(ticket)
        previous_position = None
        try:
            while True:
                position = self.waiters.index(ticket) + 1
                if position != previous_position:
                    await report(position)
                    previous_position = position
                if position == 1 and self.has_capacity():
                    try:
                        return await self.create(image, public=public, ticket=ticket)
                    except SessionError as error:
                        if error.code != "capacity":
                            raise
                await asyncio.sleep(0.5)
        finally:
            self.waiters.remove(ticket)

    async def create(self, image, *, public=False, ticket=None, replace=False):
        if not isinstance(image, str) or (public and not image.startswith("release:")):
            raise SessionError("请选择已发布固件", 400)
        if public and ticket is None:
            self.public_admission()
            if self.creating.locked() and not self.waiters:
                raise SessionError("创建请求过多，请稍后重试", 429)
        async with self.creating:
            if self.waiters and self.waiters[0] is not ticket and not replace:
                raise at_capacity()
            try:
                assets = await asyncio.to_thread(self.lab.image, image)
            except (OSError, ValueError, KeyError) as exc:
                message = "固件暂不可用" if public else str(exc)
                raise SessionError(message, 400) from exc
            await self.expire()
            if self.limit and len(self.items) >= self.limit:
                room = self.idle_room(monotonic())
                if room is None:
                    if not replace:
                        raise at_capacity()
                    room = min(self.items.values(), key=lambda item: item.last_access)
                    room.closed_message = REPLACED_ENDED
                    self.replaced.append(room.ident)
                    self.remove(room, replace=True)
                else:
                    self.remove(room)
                await room.close()
            try:
                machine = await self.engine.boot(*assets)
            except Exception as exc:
                raise SessionError("模拟器启动失败" if public else str(exc), 503) from exc
            ident = secrets.token_hex(24)
            room = Session(ident, image, machine, self.idle_timeout)
            try:
                await room.capture()
                if room.snapshot.get("failed"):
                    raise SessionError("模拟器启动后无法读取画面", 503)
            except BaseException:
                await machine.close()
                raise
            if public or ticket is not None:
                room.rejoin_until = monotonic() + REJOIN_SECONDS
            room.ticker = asyncio.create_task(room.tick())
            self.items[ident] = room
            return room

    def remove(self, room, *, replace=False):
        if room.closed:
            raise SessionError("会话已结束", 404)
        if not replace and (room.busy or room.lock.locked()):
            raise SessionError("结束前请等待当前操作完成")
        self.items.pop(room.ident)
        room.closed = True

    async def close(self):
        await asyncio.gather(*(room.close() for room in self.items.values()), return_exceptions=True)
        self.items.clear()

    async def run(self, room, spec, scenario, *, expected=None, fault=False, wait=False):
        room.busy = True
        room.activity = "等待加入会话" if wait else "准备执行场景"
        await room.capture()

        async def changed(message):
            room.activity = message
            await room.capture()

        async def job():
            try:
                if wait:
                    with suppress(TimeoutError):
                        await asyncio.wait_for(room.joined.wait(), timeout=30)
                async with room.lock:
                    record = await pp_scenario.run(self.lab, room.machine, room.image, scenario, spec,
                                                   fault=fault, expected=expected, changed=changed)
                room.result = {"record": record}
                room.activity = f'{spec["title"]} · {"通过" if record["status"] == "pass" else "失败"}'
            except Exception as error:
                room.result = {"error": str(error)}
                room.activity = "场景执行失败"
            finally:
                async with room.lock:
                    room.busy = False
                    room.touch()
                    if not room.closed:
                        await room.capture()

        room.job = asyncio.create_task(job())


async def request_data(request):
    try:
        value = await request.json()
        if isinstance(value, dict):
            return value
    except (ValueError, UnicodeDecodeError):
        pass
    raise SessionError("请求格式无效", 400)


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except SessionError as error:
        body = {"error": str(error)}
        if error.code:
            body["code"] = error.code
        return web.json_response(body, status=error.status, headers={"Cache-Control": "no-store"})


def same_origin(request):
    try:
        expected = f"{request.headers.get('X-Forwarded-Proto', 'https')}://{request.host}"
    except ValueError:
        return False
    return request.headers.get("Origin") == expected


async def waiting_socket(request, sessions, *, public, prepare=None, on_created=None):
    ws = web.WebSocketResponse(heartbeat=15, max_msg_size=4096)
    await ws.prepare(request)
    try:
        hello = await ws.receive_json(timeout=5)
    except (TimeoutError, ValueError, TypeError):
        await ws.close(code=1008)
        return ws

    async def report(position):
        await asyncio.wait_for(ws.send_json({"type": "queue", "position": position}), timeout=5)

    image = hello.get("image") if isinstance(hello, dict) else None

    async def create():
        if prepare:
            prepare(hello)
        return await sessions.wait_for_room(image, report, public=public)

    waiting = asyncio.create_task(create())
    disconnect = asyncio.create_task(ws.receive())
    room = None
    delivered = False
    try:
        await asyncio.wait((waiting, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if waiting.done():
            room = waiting.result()
            if not disconnect.done():
                await asyncio.wait_for(
                    ws.send_json({"type": "created", "session": room.ident}), timeout=5,
                )
                delivered = True
                if on_created:
                    await on_created(room, hello)
    except SessionError as error:
        if not ws.closed:
            await ws.send_json({"type": "error", "message": str(error)})
    except (TimeoutError, ConnectionError):
        pass
    finally:
        waiting.cancel()
        disconnect.cancel()
        await asyncio.gather(waiting, disconnect, return_exceptions=True)
        if room is not None and not delivered and not room.closed:
            sessions.remove(room)
            await room.close()
        await ws.close()
    return ws


def public_app(sessions):
    app = web.Application(middlewares=[errors], client_max_size=4096)

    async def catalog(_):
        return web.json_response([{"image": item["id"], "version": item["version"]}
                                  for item in sessions.lab.published() if item["ready"]],
                                 headers={"Cache-Control": "no-store"})

    async def create(request):
        if not same_origin(request):
            raise web.HTTPForbidden()
        data = await request_data(request)
        room = await sessions.create(data.get("image"), public=True, replace=data.get("replace_oldest") is True)
        return web.json_response({"session": room.ident}, status=201, headers={"Cache-Control": "no-store"})

    async def wait(request):
        if not same_origin(request):
            raise web.HTTPForbidden()
        return await waiting_socket(request, sessions, public=True)

    async def connect(request):
        if not same_origin(request):
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=4096)
        await ws.prepare(request)
        room = None
        try:
            hello = await ws.receive_json(timeout=5)
            room = sessions.get(hello.get("session") if isinstance(hello, dict) else None)
            if len(room.peers) >= MAX_PEERS:
                raise SessionError("该会话连接数已满")
        except (SessionError, TimeoutError, ValueError, TypeError) as exc:
            await ws.send_json({"type": "ended", "message": str(exc) if isinstance(exc, SessionError) else "会话编号无效"})
            await ws.close()
            return ws

        peer = asyncio.Event()
        room.peers.add(peer)
        room.touch()
        room.joined.set()
        peer.set()

        async def updates():
            try:
                while True:
                    await peer.wait()
                    peer.clear()
                    if room.closed:
                        await asyncio.wait_for(
                            ws.send_json({"type": "ended", "message": room.closed_message}), timeout=5,
                        )
                        break
                    await asyncio.wait_for(ws.send_json(room.snapshot), timeout=5)
            finally:
                await ws.close()

        updates_task = asyncio.create_task(updates())
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    break
                try:
                    data = json.loads(message.data)
                    if not isinstance(data, dict) or type(data.get("id")) is not int or not isinstance(data.get("args", {}), dict):
                        raise SessionError("请求格式无效", 400)
                except (ValueError, SessionError):
                    await ws.close(code=1008)
                    break
                try:
                    sessions.get(room.ident)
                    cmd = data.get("cmd")
                    if cmd == "end":
                        sessions.remove(room)
                        try:
                            await asyncio.wait_for(ws.send_json({
                                "type": "reply", "id": data["id"], "ok": '{"json":{}}',
                            }), timeout=5)
                        finally:
                            await room.close()
                        break
                    result = await room.command(peer, cmd, data.get("args", {}))
                    output = {"ok": json.dumps(result, ensure_ascii=False)}
                except SessionError as exc:
                    output = {"err": json.dumps({"code": "E_STATE", "message": str(exc)}, ensure_ascii=False)}
                except Exception:
                    output = {"err": json.dumps({"code": "E_INTERNAL", "message": "操作结果未确认，请查看当前状态"})}
                await asyncio.wait_for(ws.send_json({"type": "reply", "id": data["id"], **output}), timeout=5)
        except (TimeoutError, ConnectionError):
            pass
        finally:
            if not room.closed:
                updates_task.cancel()
            await asyncio.gather(updates_task, return_exceptions=True)
            await room.disconnect(peer)
        return ws

    app.router.add_get("/catalog", catalog)
    app.router.add_post("/sessions", create)
    app.router.add_get("/wait", wait)
    app.router.add_get("/session", connect)
    return app


def control_app(sessions):
    app = web.Application(middlewares=[errors], client_max_size=8192)

    def validate(data):
        if not isinstance(data, dict):
            raise SessionError("请求格式无效", 400)
        scenario = data.get("scenario")
        if scenario is not None and (not isinstance(scenario, str) or scenario not in sessions.lab.scenarios):
            raise SessionError("场景不存在", 400)

    async def start_scenario(room, data):
        if scenario := data.get("scenario"):
            await sessions.run(room, sessions.lab.scenarios[scenario], scenario, expected=data.get("expected"),
                               fault=data.get("fault", False), wait=data.get("wait", False))

    async def create(request):
        data = await request_data(request)
        validate(data)
        room = await sessions.create(data.get("image"), replace=data.get("replace_oldest") is True)
        await start_scenario(room, data)
        return web.json_response({"session": room.ident}, status=201)

    async def wait(request):
        return await waiting_socket(request, sessions, public=False, prepare=validate, on_created=start_scenario)

    async def session(request):
        room = sessions.get(request.match_info["ident"])
        if request.method == "GET":
            room.touch()
            return web.json_response({"state": room.snapshot, "result": room.result})
        if request.method == "DELETE":
            sessions.remove(room)
            await room.close()
            return web.json_response({})
        data = await request_data(request)
        args = data.get("args", {})
        if not isinstance(args, dict):
            raise SessionError("请求格式无效", 400)
        return web.json_response(await room.command(None, data.get("cmd"), args))

    app.router.add_post("/sessions", create)
    app.router.add_get("/wait", wait)
    for method in ("GET", "POST", "DELETE"):
        app.router.add_route(method, "/sessions/{ident}", session)
    return app


async def serve(lab, limit, public_socket, private_socket, public_group, *, idle_timeout):
    public_socket.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    public_socket.parent.chmod(0o755)
    private_socket.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    private_socket.parent.chmod(0o700)
    async with runtime() as engine:
        sessions = Sessions(lab, engine, limit, idle_timeout)
        reaper = asyncio.create_task(sessions.reap())
        try:
            async with run_site(control_app(sessions), web.UnixSite, private_socket, socket_mode=0o600):
                async with run_site(public_app(sessions), web.UnixSite, public_socket, socket_mode=0o660):
                    if public_group is not None:
                        os.chown(public_socket, -1, public_group)
                    await asyncio.Event().wait()
        finally:
            reaper.cancel()
            with suppress(asyncio.CancelledError):
                await reaper
            await sessions.close()
