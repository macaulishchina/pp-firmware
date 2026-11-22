#!/usr/bin/env python3
"""Build and validate PP firmware from the Dell development workspace."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
from zipfile import ZipFile

import pp_sim

SITE = Path(__file__).resolve().parents[1]
PLUGIN = Path("src/assistant_runtime/plugins/ai_passport")
FIRMWARE = PLUGIN / "firmware"
TERMINAL = FIRMWARE / "apps/pa_terminal"
STAGES = {
    "unit": "单元与镜像打包检查",
    "integration": "PA 协议和合成语音集成",
    "candidate": "ESP-IDF 候选构建",
    "device": "Windows 远程串口",
}
QUICK = ("unit", "integration")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?")


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def atomic_json(path, value, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".status-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def repo_files(root):
    raw = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=root)
    return [Path(os.fsdecode(name)) for name in set(raw.split(b"\0")) if name]


def digest(root, paths):
    sha = hashlib.sha256()
    for name in sorted(set(paths)):
        sha.update(str(name).encode() + b"\0")
        path = root / name
        sha.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing")
    return sha.hexdigest()


def is_under(path, prefix):
    return path.is_relative_to(prefix)


def evidence_signature(*values):
    return hashlib.sha256("\0".join(values).encode()).hexdigest()


class Lab:
    def __init__(self, args):
        self.args = args
        self.pa = args.pa_root.resolve()
        self.python = self.pa / ".venv/bin/python"
        self.app = self.pa / TERMINAL
        self.state = args.state_dir.resolve()
        profile = args.release_profile.resolve()
        release = tomllib.loads(profile.read_text())
        self.release_url = release["server_url"]
        ca_file = release.get("ca_file")
        self.release_ca = (profile.parent / Path(ca_file).expanduser()).resolve() if ca_file else None
        self.release_profile = profile
        self.version = (self.app / "version.txt").read_text().strip()
        if not VERSION.fullmatch(self.version):
            raise ValueError("Unexpected firmware version")
        device = self.state / "device.json"
        fields = ("ssh_host", "ssh_port", "ssh_key", "known_hosts")
        if args.ssh_host:
            atomic_json(device, {field: str(value) for field in fields
                                 if (value := getattr(args, field)) is not None}, 0o600)
        else:
            settings = read_json(device, {})
            for field in fields:
                if field in settings and getattr(args, field) is None:
                    setattr(args, field, settings[field])
        self.record_file = self.state / "record.json"
        self.record = read_json(self.record_file, {"stages": {}})
        for name in STAGES:
            stage = self.record["stages"].get(name, {})
            if stage.get("status") == "running":
                stage.update(status="interrupted", hint="上次运行中断，可单独复跑。")
        self.inputs = self.signatures()

    def signatures(self):
        pa_files = repo_files(self.pa)
        # Both the release archive and its link check depend on bundled manuals.
        firmware = digest(self.pa, [p for p in pa_files if
            (is_under(p, FIRMWARE) and p.suffix != ".md")
            or is_under(p, PLUGIN / "docs") or is_under(p, FIRMWARE / "docs")
            or p in (TERMINAL / "README.md", FIRMWARE / "README.md")])
        integration_host = digest(self.pa, [p for p in pa_files
                                             if str(p).startswith("src/assistant_runtime/") and not is_under(p, FIRMWARE)
                                             or str(p).startswith("tests/test_passport_")
                                             or p in (Path("tests/test_ai_passport.py"),
                                                      Path("tests/test_terminal_delivery.py"),
                                                      Path("scripts/check_passport_hardware.py"))])
        # The integration suite checks the pinned BSP files as well as the Python runtime.
        integration = evidence_signature(firmware, integration_host)
        unit = evidence_signature(firmware, digest(SITE, [
            Path("tests/test_pp_lab.py"), Path("tools/pp_lab.py"),
            Path("tools/install_firmware.py"), Path("tools/upgrade_plan.mjs"), Path("tools/publish.py"),
            Path("src/lib/pp/upgrade.mjs"), Path("tests/test_install_firmware.py"), Path("tests/test_publish.py"),
        ]))
        release_paths = [self.release_profile]
        if self.release_ca:
            release_paths.append(self.release_ca)
        return {"unit": unit, "integration": integration,
                "candidate": evidence_signature(firmware, digest(SITE, release_paths)),
                "device": evidence_signature(self.version, firmware, digest(SITE, [Path("tools/pp_device_status.ps1")]))}

    def log(self, run, name, argv, cwd=SITE, timeout=90, env=None):
        with (run / f"{name}.log").open("ab") as output:
            output.write(("\n> " + " ".join(map(str, argv[:4])) + "\n").encode())
            output.flush()
            process = subprocess.Popen(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, env=env,
                                       start_new_session=True)
            try:
                status = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                raise RuntimeError(f"{name} timed out") from None
            if status:
                raise RuntimeError(f"{name} exited {status}")

    def probe(self, run):
        ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes"]
        if self.args.ssh_port:
            ssh += ["-p", str(self.args.ssh_port)]
        if self.args.ssh_key:
            ssh += ["-o", "IdentitiesOnly=yes", "-i", str(self.args.ssh_key)]
        if self.args.known_hosts:
            ssh += ["-o", f"UserKnownHostsFile={self.args.known_hosts}"]
        script = (SITE / "tools/pp_device_status.ps1").read_text()
        encoded = base64.b64encode(script.encode("utf-16le")).decode()
        args = [*ssh, "--", self.args.ssh_host, "powershell.exe", "-NoLogo", "-NoProfile",
                "-NonInteractive", "-EncodedCommand", encoded]
        try:
            result = subprocess.run(args, capture_output=True, timeout=22)
            (run / "device.log").write_bytes(result.stdout + b"\n" + result.stderr)
        except subprocess.TimeoutExpired:
            return "waiting", "远程诊断超时。请保持 Windows 和反向 SSH 在线。", None
        if result.returncode:
            hint = {3: "串口未就绪。请唤醒 PP，检查 USB 数据线。",
                    4: "串口已打开，未收到状态。请确认设备停在正常运行界面。",
                    5: "串口打开失败。请关闭正在使用串口的刷写或监视窗口。"}.get(
                        result.returncode, "无法登录烧录台。请保持 Windows 和反向 SSH 在线。")
            return "waiting", hint, None
        raw = json.loads(result.stdout)
        version = raw.get("version", "")
        if raw.get("app") != "PA-Terminal" or not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError("Unrecognized PP device status")
        detail = {"version": version, "paConnected": raw.get("connected") is True,
                  "cacheReady": raw.get("cache_ready") is True}
        elf_digest = raw.get("elf_sha256")
        if isinstance(elf_digest, str) and re.fullmatch(r"[0-9a-fA-F]{64}", elf_digest):
            detail["elfSha256"] = elf_digest.lower()
        if type(raw.get("wake_cause")) is int:
            detail["wakeCause"] = raw["wake_cause"]
        candidate = self.record["stages"].get("candidate", {})
        candidate_hash = (candidate.get("detail") or {}).get("elfSha256")
        hint = "已读到设备状态"
        if version != self.version:
            hint += "，设备固件与当前候选版本不同"
        elif not detail.get("elfSha256") or not candidate_hash or candidate.get("input") != self.inputs["candidate"]:
            hint += "，缺少当前构建指纹，无法确认是否为同一镜像"
        elif detail["elfSha256"] != candidate_hash:
            hint += "，版本名相同但构建指纹不同"
        else:
            hint += "，构建指纹和当前候选一致"
        if not detail["paConnected"]:
            hint += "，采样时未连 PA"
        return "pass", hint + "。", detail

    def check(self, name, run):
        if name == "device":
            if not self.args.ssh_host:
                return "waiting", "等待配置 Windows SSH 入口。", None
            return self.probe(run)
        if name == "unit":
            sdk = self.args.sdk_root / "esp-idf-v5.5.3/components/json/cJSON/cJSON.c"
            if not sdk.is_file():
                raise FileNotFoundError(f"Pinned cJSON source missing: {sdk}")
            host = self.state / "host-build"
            self.log(run, name, ["bash", "-c",
                     'source "$1" && cmake -S "$2" -B "$3" "-DPP_CJSON_SOURCE=$4"'
                     ' && cmake --build "$3" --parallel 3 && ctest --test-dir "$3" --output-on-failure',
                     "pp-lab", self.args.sdk_root / "activate.sh", self.pa / FIRMWARE / "tests", host, sdk])
            self.log(run, name, [self.python, "-m", "unittest", "discover", "-s",
                                 self.pa / FIRMWARE / "tests", "-p", "test_*.py"])
            self.log(run, name, [self.python, "-m", "unittest", "discover", "-s",
                                 "tests", "-p", "test_pp_lab.py"])
            for test in ("test_install_firmware.py", "test_publish.py"):
                self.log(run, name, [self.python, SITE / "tests" / test])
        elif name == "integration":
            self.log(run, name, [self.python, "-m", "unittest", "test_ai_passport", "test_passport_protocol",
                                 "test_passport_settings", "test_passport_hardware", "test_terminal_delivery"],
                     cwd=self.pa, timeout=180, env={**os.environ, "PYTHONPATH": "src:tests"})
        elif name == "candidate":
            build_flags = [f"-DPP_PA_URL={self.release_url}",
                           f"-DPP_PA_CA_FILE={self.release_ca or ''}"]
            self.log(run, name, ["bash", "-c", 'source "$1" && shift && idf.py "$@" build', "pp-lab",
                                 self.args.sdk_root / "activate.sh", *build_flags], cwd=self.app, timeout=300)
            image = (self.app / "build/pa_terminal.bin").read_bytes()
            if self.release_url.encode() + b"\0" not in image:
                raise ValueError("Built image does not contain the release PA URL")
            if self.release_ca and self.release_ca.read_bytes().rstrip() not in image:
                raise ValueError("Built image does not contain the release CA certificate")
            archive = run / f"pa-terminal-{self.version}.zip"
            self.log(run, name, [self.python, self.pa / FIRMWARE / "tools/package_firmware.py",
                                 "--build", self.app / "build", "--output", archive])
            with ZipFile(archive) as package:
                _, app_hash, flash = pp_sim.read_flash(package, self.version)
                elf = pp_sim.pack(package, "debug/pa_terminal.elf", pp_sim.MAX_ELF)
            return "pass", "已构建候选并生成私有刷写包。", {
                "elfSha256": pp_sim.verify_elf(flash, elf),
                "appSha256": app_hash,
            }
        return "pass", {
            "unit": "固件 C、镜像打包和验收工具检查通过。",
            "integration": "合成识别和播报走通真实 PA/Pi，覆盖配对、会话、任务及图片。",
        }[name], None

    def status(self):
        stages = {}
        for name, title in STAGES.items():
            raw = self.record["stages"].get(name, {})
            status = raw.get("status", "pending")
            if raw and raw.get("input") != self.inputs[name]:
                status = "stale"
            stages[name] = {"title": title, "status": status, "at": raw.get("at"),
                            "duration": raw.get("duration"), "run": raw.get("run"),
                            "hint": "相关源码已变化，请重跑此项。" if status == "stale" else raw.get("hint", ""),
                            "detail": raw.get("detail") if status != "stale" else None}
        return {"firmware": self.version, "stages": stages}

    def save_record(self):
        atomic_json(self.record_file, self.record, 0o600)

    def run(self, names):
        run = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S-"),
                                   dir=self.state / "runs"))
        for name in names:
            self.record["stages"][name] = {"status": "running", "input": self.inputs[name],
                                           "run": run.name, "at": utc()}
        self.save_record()

        def work(name):
            start = time.monotonic()
            try:
                status, hint, detail = self.check(name, run)
            except (OSError, ValueError, RuntimeError) as exc:
                with (run / f"{name}.log").open("a") as log:
                    print(f"{type(exc).__name__}: {exc}", file=log)
                status, hint, detail = "fail", "检查未通过。开发者可按运行编号打开本机日志。", None
            return {"status": status, "hint": hint, "detail": detail, "input": self.inputs[name],
                    "at": utc(), "run": run.name, "duration": round(time.monotonic() - start, 1)}

        with ThreadPoolExecutor(max_workers=3) as pool:
            future_names = {pool.submit(work, name): name for name in names}
            for future in as_completed(future_names):
                name = future_names[future]
                result = future.result()
                self.record["stages"][name] = result
                print(f"{name}: {result['status']} ({result['duration']}s) {result['hint']}", flush=True)
                self.save_record()
        self.inputs = self.signatures()
        print(f"Evidence: {run}")
        return int(any(self.record["stages"][name]["status"] == "fail"
                       or self.record["stages"][name]["input"] != self.inputs[name] for name in names))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pa-root", type=Path, default=SITE.parent.parent / "PersonalAgent")
    parser.add_argument("--sdk-root", type=Path, default=SITE.parent / "toolchain")
    parser.add_argument("--state-dir", type=Path, default=SITE.parent / "private/pp-lab")
    parser.add_argument("--release-profile", type=Path, default=SITE / "config/pa-terminal-build.toml")
    parser.add_argument("--ssh-host", default=os.getenv("PP_LAB_SSH_HOST"))
    parser.add_argument("--ssh-port", type=int, default=os.getenv("PP_LAB_SSH_PORT"))
    parser.add_argument("--ssh-key", type=Path, default=os.getenv("PP_LAB_SSH_KEY"))
    parser.add_argument("--known-hosts", type=Path, default=os.getenv("PP_LAB_KNOWN_HOSTS"))
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run quick checks by default or choose stages")
    run.add_argument("stages", nargs="*", metavar="STAGE")
    commands.add_parser("status", help="Show current acceptance stages and stale evidence")
    pp_sim.configure(commands.add_parser("sim", help="Exercise real PP firmware in PassportSim"))
    args = parser.parse_args()
    os.umask(0o077)
    if any(args.state_dir.resolve().is_relative_to(directory) for directory in (
        SITE / "public", SITE / "dist", SITE.parent / "runtime", SITE.parent / "releases",
    )):
        parser.error("Private evidence must stay outside the website directories.")
    args.state_dir.mkdir(parents=True, exist_ok=True)
    (args.state_dir / "runs").mkdir(exist_ok=True)
    if args.command == "sim":
        def build_candidate():
            with (args.state_dir / "lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                lab = Lab(args)
                if lab.run(["candidate"]):
                    return None
                return lab.record["stages"]["candidate"]["run"]

        return pp_sim.execute(args, build_candidate)
    with (args.state_dir / "lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(2, "Another PP lab operation is running.\n")
        lab = Lab(args)
        if args.command == "run":
            names = list(dict.fromkeys(args.stages or QUICK))
            if any(name not in STAGES for name in names):
                parser.error("Stage must be one of " + ", ".join(STAGES))
            return lab.run(names)
        lab.save_record()
        print(json.dumps(lab.status(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(error, file=sys.stderr)
        raise SystemExit(2) from None
