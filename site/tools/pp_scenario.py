"""Deterministic PP Lab scenes on any PassportSim instance."""
import json
import re
from time import monotonic


def labels(tree):
    found = []
    for label in re.findall(r'\blabel ("(?:[^"\\]|\\.)*")', tree):
        try:
            found.append(json.loads(label))
        except json.JSONDecodeError:
            found.append(label[1:-1])
    return found


def check(action, wanted, actual, reply):
    missing = [label for label in wanted if label not in actual]
    text = "\n".join(actual)
    if missing:
        raise ValueError("界面缺少「" + "」「".join(missing) + "」")
    for key, source, problem in (
        ("contains", text, "界面内容缺少"), ("absent", text, "界面出现"),
        ("serialContains", reply, "串口缺少"),
    ):
        wrong = [part for part in action.get(key, []) if (part in source) == (key == "absent")]
        if wrong:
            raise ValueError(problem + "「" + "」「".join(wrong) + "」")


async def run(lab, machine, image, scenario, spec, *, fault=False, expected=None, changed=None):
    start = monotonic()
    steps = []
    error = None
    tree = serial = ""
    meta = machine.meta
    if expected and any({**meta, "scenarioSha256": spec["sha256"]}.get(key) != value
                        for key, value in expected.items()):
        error = "复跑所需的镜像、模拟器或场景已变化"
    else:
        for index, action in enumerate(spec["steps"]):
            began = monotonic()
            last = index == len(spec["steps"]) - 1
            want = action["expect"] + (["PP Lab 注入的失败断言"] if last and fault else [])
            step = {"name": action["name"], "expected": want, "actual": []}
            for key in ("key", "contains", "absent", "serialContains"):
                if key in action:
                    step[key] = action[key]
            if "serial" in action:
                step["command"] = action["serial"]
            try:
                if "key" in action:
                    step["ms"] = action.get("ms", 210)
                    await machine.invoke("press", action["key"], step["ms"])
                reply = await machine.invoke("send", action["serial"]) if "serial" in action else ""
                if index == 0:
                    for _ in range(6):
                        actual = labels((await machine.invoke("ui")).get("text", ""))
                        if all(label in actual for label in action["expect"]):
                            break
                        await machine.invoke("advance", 250)
                tree = (await machine.invoke("ui")).get("text", "")
                serial = await machine.invoke("serial")
                step["actual"] = labels(tree)
                check(action, want, step["actual"], reply)
            except Exception as exc:
                error = str(exc)
            if index == 0 or last or action.get("capture") or error:
                step["tree"] = tree
                try:
                    step["screen"] = await machine.invoke("screen")
                except Exception as exc:
                    step["captureError"] = str(exc)
                    error = error or f"无法保留 LCD 截图（{exc}）"
            step.update(status="fail" if error else "pass", wallMs=round((monotonic() - began) * 1000))
            if error:
                step["error"] = error
            steps.append(step)
            if changed:
                await changed(f'{spec["title"]} · {index + 1}/{len(spec["steps"])} · {step["name"]}')
            if error:
                break
    return lab.save({
        "image": image, "scenario": scenario, "fault": fault,
        **{key: meta[key] for key in ("version", "sha256", "flashSha256", "elfSha256", "simulator", "worker")},
        "scenarioSha256": spec["sha256"], "initial": "erased-nvs", "seed": 0,
        "status": "fail" if error else "pass", "error": error,
        "bootMs": machine.boot_ms, "steps": steps, "serial": serial,
        "wallMs": machine.boot_ms + round((monotonic() - start) * 1000),
    })
