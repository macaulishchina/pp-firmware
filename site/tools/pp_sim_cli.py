"""CLI worker for the isolated and shared PassportSim runtimes."""
import asyncio
import base64
from contextlib import asynccontextmanager
import json
from pathlib import Path
import signal
import sys
from time import monotonic
from urllib.parse import urlencode

from aiohttp import ClientSession, ClientTimeout, UnixConnector, WSMsgType

import pp_scenario
from pp_sessions import serve
from pp_sim import SimLab
from pp_sim_runtime import runtime


def show(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


@asynccontextmanager
async def control(lab):
    path = lab.state / "sim/control/control.sock"
    connector = UnixConnector(path=str(path))
    async with ClientSession(connector=connector, timeout=ClientTimeout(total=50)) as client:

        async def request(method, route, **data):
            async with client.request(method, f"http://localhost{route}", json=data or None) as response:
                payload = await response.json()
                if response.status >= 400:
                    raise ValueError(payload.get("error", f"控制接口 HTTP {response.status}"))
                return payload

        async def create(*, wait_for_slot=False, replace_oldest=False, **data):
            if not wait_for_slot:
                return await request("POST", "/sessions", replace_oldest=replace_oldest, **data)
            async with client.ws_connect("http://localhost/wait", heartbeat=15) as socket:
                await socket.send_json(data)
                async for message in socket:
                    if message.type != WSMsgType.TEXT:
                        break
                    event = message.json()
                    if event["type"] == "queue":
                        print(f'正在等待空位 · 第 {event["position"]} 位', file=sys.stderr, flush=True)
                    elif event["type"] == "created":
                        return {"session": event["session"]}
                    elif event["type"] == "error":
                        raise ValueError(event["message"])
                raise ValueError("等待连接已断开")

        yield request, create


def joined(base, ident):
    return base + "?" + urlencode({"session": ident})


async def run(lab, options):
    image, scenario = options["image"], options["scenario"]
    fault, expected = options["fault"], options["expected"]
    spec = lab.scenarios[scenario]
    url = None
    if options["share"]:
        async with control(lab) as (request, create):
            created = await create(image=image, scenario=scenario, expected=expected, fault=fault,
                                   wait=options["wait"], wait_for_slot=options["wait_for_slot"],
                                   replace_oldest=options["replace_oldest"])
            ident = created["session"]
            url = joined(options["public_base"], ident)
            print(f"PassportSim: {url}", file=sys.stderr, flush=True)
            while True:
                result = (await request("GET", f"/sessions/{ident}"))["result"]
                if result is not None:
                    if "error" in result:
                        raise ValueError(result["error"])
                    record = result["record"]
                    break
                await asyncio.sleep(0.25)
    else:
        started = monotonic()
        meta = {}
        async with runtime() as engine:
            try:
                meta, flash, elf = lab.image(image)
                machine = await engine.boot(meta, flash, elf)
            except Exception as exc:
                _, version = lab.locate(image)
                record = lab.save({
                    "image": image, "scenario": scenario, "version": version, "fault": fault,
                    **{key: meta.get(key) for key in ("sha256", "flashSha256", "elfSha256", "simulator", "worker")},
                    "scenarioSha256": spec["sha256"], "initial": "erased-nvs", "seed": 0,
                    "status": "fail", "error": str(exc), "steps": [], "serial": "",
                    "wallMs": round((monotonic() - started) * 1000),
                })
            else:
                try:
                    record = await pp_scenario.run(lab, machine, image, scenario, spec, fault=fault, expected=expected)
                finally:
                    await machine.close()
    summary = {key: record[key] for key in ("id", "image", "scenario", "status", "error", "wallMs")}
    summary["steps"] = len(record["steps"])
    summary["evidence"] = str(lab.evidence / record["id"])
    if url:
        summary["url"] = url
    show(summary)
    return int(record["status"] != "pass")


async def session(lab, options):
    operation = options["operation"]
    async with control(lab) as (request, create):
        if operation == "new":
            image = f'release:{options["version"]}' if "version" in options else f'candidate:{options["candidate"]}'
            created = await create(image=image, wait_for_slot=options["wait_for_slot"],
                                   replace_oldest=options["replace_oldest"])
            show({**created, "url": joined(options["public_base"], created["session"])})
            return
        route = f'/sessions/{options["session_id"]}'
        if operation == "end":
            await request("DELETE", route)
        elif operation == "press":
            show(await request("POST", route, cmd="input", args={
                "button": options["key"], "duration": options["ms"] + "ms",
            }))
        elif operation == "send":
            show(await request("POST", route, cmd="serial", args={"op": "write", "text": options["line"]}))
        else:
            state = (await request("GET", route))["state"]
            if operation == "serial":
                print(state.get("serial", ""), end="")
            elif operation == "screen":
                if not state.get("image"):
                    raise ValueError("该会话暂无设备画面")
                Path(options["output"]).write_bytes(base64.b64decode(state["image"].split(",", 1)[1]))
            else:
                show({key: value for key, value in state.items() if key not in {"image", "serial"}})


async def main(action, state, pa, options):
    lab = SimLab(Path(state), Path(pa))
    if action == "run":
        return await run(lab, options)
    if action == "session":
        await session(lab, options)
        return 0
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await serve(lab, options["max_sessions"], Path(options["socket"]),
                    lab.state / "sim/control/control.sock", options["group"],
                    idle_timeout=options["idle_timeout"])
    except asyncio.CancelledError:
        return 0
    return 0


if __name__ == "__main__":
    command, state_dir, pa_dir, config = sys.argv[1:]
    try:
        raise SystemExit(asyncio.run(main(command, state_dir, pa_dir, json.loads(config))))
    except (OSError, ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
