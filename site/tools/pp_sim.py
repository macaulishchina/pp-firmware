"""Firmware and evidence storage for PP Lab simulation commands."""
import argparse
import base64
from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
from zipfile import ZipFile

import publish

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent
WEB = Path(__file__).with_name("sim")
ENGINE = ROOT / "runtime/passportsim"
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?")
RUN = re.compile(r"\d{8}T\d{6}-[a-z0-9_]{8}")
DIGEST = re.compile(r"[0-9a-f]{64}")
RELEASE_PARTS = {"bootloader.bin", "partition-table.bin", "pa_terminal.bin"}
FLASH_BYTES = 8 * 1024 * 1024
MAX_ELF = 32 * 1024 * 1024
DEFAULT_SESSION_IDLE_HOURS = 24
PNG = b"\x89PNG\r\n\x1a\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pack(archive, name, max_size):
    item = archive.getinfo(name)
    if item.file_size > max_size or archive.namelist().count(name) != 1:
        raise ValueError(f"Unexpected archive member: {name}")
    return archive.read(item)


def read_flash(archive, version):
    manifest = json.loads(pack(archive, "manifest.json", 16384))
    if (
        not VERSION.fullmatch(manifest["version"])
        or (version and manifest["version"] != version)
        or manifest["target"] != "esp32c3"
        or manifest["application"] != "PA-Terminal"
    ):
        raise ValueError("The selected archive is not the requested PA-Terminal ESP32-C3 image")
    parts = manifest["flash_files"]
    if len(parts) != 3 or {item["file"] for item in parts} != RELEASE_PARTS:
        raise ValueError("Expected bootloader, partition table and PA-Terminal only")
    offsets = {"bootloader.bin": 0, "partition-table.bin": 0x8000, "pa_terminal.bin": 0x10000}
    flash = bytearray(b"\xff" * FLASH_BYTES)
    for item in parts:
        name = item["file"]
        offset = offsets[name]
        data = pack(archive, name, publish.LIMITS[offset])
        if int(item["offset"], 0) != offset or len(data) != item["bytes"] or sha(data) != item["sha256"]:
            raise ValueError(f"Image checksum, size or offset mismatch: {name}")
        flash[offset : offset + len(data)] = data
    if parts and any(item["bytes"] > publish.application_limit(flash[0x8000:0x9000])
                     for item in parts if item["file"] == "pa_terminal.bin"):
        raise ValueError("Application overlaps another flash partition")
    app = next(item for item in parts if item["file"] == "pa_terminal.bin")["sha256"]
    return manifest["version"], app, bytes(flash)


def verify_elf(flash, elf):
    digest = sha(elf)
    # ESP-IDF app descriptor follows the 24-byte image and 8-byte
    # segment headers. The ELF hash is 144 bytes into that descriptor.
    if elf[:4] != b"\x7fELF" or flash[0x100b0:0x100d0].hex() != digest:
        raise ValueError("Application and ELF were produced by different builds")
    return digest


def read_elf(path):
    if path.stat().st_size > MAX_ELF:
        raise ValueError("Application ELF is too large")
    return path.read_bytes()


class SimLab:
    def __init__(self, state, pa):
        self.state = state
        self.evidence = state / "sim/runs"
        self.stages = state / "sim/staged"
        self.evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.pa = pa
        self.releases = ROOT / "releases/pa-terminal"
        self.candidates = ROOT / "candidates/pa-terminal"

    @property
    def scenarios(self):
        scenarios = json.loads((WEB / "scenes.json").read_text())
        for spec in scenarios.values():
            spec["sha256"] = sha(json.dumps(spec, ensure_ascii=False, sort_keys=True).encode())
        return scenarios

    def candidate(self, run):
        if not RUN.fullmatch(run):
            raise ValueError("Invalid PP Lab candidate run ID")
        files = list((self.state / "runs" / run).glob("pa-terminal-*.zip"))
        if len(files) != 1 or not files[0].is_file():
            raise ValueError(f"No PA-Terminal candidate for run {run}")
        version = files[0].name.removeprefix("pa-terminal-").removesuffix(".zip")
        if not VERSION.fullmatch(version):
            raise ValueError("Candidate has an invalid version")
        return files[0], version

    def locate(self, image):
        source, _, key = image.partition(":")
        if source == "release" and VERSION.fullmatch(key):
            return self.releases / key / "firmware.zip", key
        if source in {"candidate", "staged"}:
            archive, version = self.candidate(key)
            if source == "staged":
                archive = self.stages / key / "releases/pa-terminal" / version / "firmware.zip"
            return archive, version
        raise ValueError("Select a release version, candidate run or staged run")

    def image(self, image):
        archive_path, version = self.locate(image)
        with ZipFile(archive_path) as archive:
            version, app, flash = read_flash(archive, version)
            if image.startswith("candidate:"):
                elf = pack(archive, "debug/pa_terminal.elf", MAX_ELF)
            elif image.startswith("staged:"):
                original, _ = self.candidate(image.split(":", 1)[1])
                with ZipFile(original) as candidate:
                    elf = pack(candidate, "debug/pa_terminal.elf", MAX_ELF)
            else:
                path = self.candidates / version / app / "debug/pa_terminal.elf"
                if not path.is_file():
                    raise ValueError(f"{version} needs the matching private ELF for application SHA256 {app}")
                elf = read_elf(path)
        elf_digest = verify_elf(flash, elf)
        flash_hash = sha(flash)
        return {
            "version": version, "sha256": app, "flashSha256": flash_hash, "elfSha256": elf_digest,
            "flashBytes": len(flash), "elfBytes": len(elf),
            "simulator": sha((ENGINE / "pemu_wasm.wasm").read_bytes()),
            "worker": sha((ENGINE / "worker.js").read_bytes()),
        }, flash, elf

    def attach_elf(self, version, path):
        archived, version = self.locate(f"release:{version}")
        with ZipFile(archived) as archive:
            _, app, flash = read_flash(archive, version)
        elf = read_elf(path)
        verify_elf(flash, elf)
        target = self.candidates / version / app / "debug/pa_terminal.elf"
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as pending:
            pending.write(elf)
            temp = Path(pending.name)
        try:
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
        return target

    def published(self):
        images = []
        for folder in sorted(self.releases.glob("*"), reverse=True):
            if not VERSION.fullmatch(folder.name) or not (folder / "firmware.zip").is_file():
                continue
            manifest = json.loads((folder / "manifest.json").read_text())
            app = next(item["sha256"] for item in manifest["flash_files"] if item["file"] == "pa_terminal.bin")
            has_elf = DIGEST.fullmatch(app) and (self.candidates / folder.name / app / "debug/pa_terminal.elf").is_file()
            images.append({"id": f"release:{folder.name}", "version": folder.name,
                           "title": f"{folder.name} · 已发布" + ("" if has_elf else " · 缺调试符号"),
                           "ready": bool(has_elf)})
        return images

    def catalog(self):
        images = self.published()
        for folder in sorted((self.state / "runs").glob("*"), reverse=True):
            try:
                _, version = self.candidate(folder.name)
            except ValueError:
                continue
            images.append({"id": f"candidate:{folder.name}", "version": version, "ready": True,
                           "title": f"{version} · 候选 {folder.name}"})
            if (self.stages / folder.name / "releases/pa-terminal" / version / "firmware.zip").is_file():
                images.append({"id": f"staged:{folder.name}", "version": version, "ready": True,
                               "title": f"{version} · 预发布 {folder.name}"})
        return {"scenarios": self.scenarios, "images": images}

    def stage(self, run):
        archive_path, version = self.candidate(run)
        stage = self.stages / run
        with tempfile.TemporaryDirectory(prefix="pp-stage-", dir=self.state) as temporary:
            candidate = Path(temporary)
            with ZipFile(archive_path) as archive:
                read_flash(archive, version)
                for name in ["manifest.json", "README.md", *RELEASE_PARTS, "LICENSE.folotoy",
                             "SourceHanSansSC.LICENSE.txt", "LittleFS.LICENSE.txt"]:
                    if name in archive.namelist():
                        (candidate / name).write_bytes(pack(archive, name, FLASH_BYTES))
            return publish.publish(
                candidate, "pa-terminal", "PP Lab 私有预发布", candidate / "README.md", "preview",
                root=stage, catalog=stage / "site/config/pp.toml",
            )

    def record(self, ident):
        if not RUN.fullmatch(ident):
            raise ValueError("Invalid simulation run ID")
        return json.loads((self.evidence / ident / "run.json").read_text())

    def save(self, result):
        scenarios = self.scenarios
        if not isinstance(result, dict) or result.get("scenario") not in scenarios:
            raise ValueError("Unknown result or scenario")
        if result.get("status") not in {"pass", "fail"} or not isinstance(result.get("steps"), list):
            raise ValueError("Invalid run status")
        spec = scenarios[result["scenario"]]
        if result.get("scenarioSha256") != spec["sha256"] or len(result["steps"]) > len(spec["steps"]):
            raise ValueError("Scenario record does not match the test definition")
        if result["status"] == "pass" and (
            len(result["steps"]) != len(spec["steps"])
            or not all(step.get("status") == "pass" for step in result["steps"])
            or not result["steps"][-1].get("screen")
            or not result.get("serial")
        ):
            raise ValueError("Passing runs require all steps, a screenshot and serial evidence")
        _, version = self.locate(result["image"])
        if result.get("version") != version:
            raise ValueError("Run version does not match the selected image")
        now = datetime.now(timezone.utc)
        path = Path(tempfile.mkdtemp(prefix=now.strftime("%Y%m%dT%H%M%S-"), dir=self.evidence))
        try:
            for number, step in enumerate(result["steps"], 1):
                if step.get("tree") is not None:
                    name = f"step-{number:02d}.txt"
                    (path / name).write_text(step["tree"])
                    step["tree"] = name
                if step.get("screen") is not None:
                    data = step["screen"]
                    prefix = "data:image/png;base64,"
                    if not data.startswith(prefix):
                        raise ValueError("Invalid screenshot")
                    png = base64.b64decode(data[len(prefix):], validate=True)
                    if not png.startswith(PNG):
                        raise ValueError("Invalid screenshot bytes")
                    name = f"step-{number:02d}.png"
                    (path / name).write_bytes(png)
                    step["screen"] = name
            (path / "serial.txt").write_text(result.pop("serial", ""))
            result.update(id=path.name, at=now.isoformat(timespec="seconds"))
            pending = path / ".run.json"
            pending.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            pending.replace(path / "run.json")
        except (OSError, ValueError, TypeError, AttributeError):
            shutil.rmtree(path)
            raise
        return result


def service_config(path):
    with path.open("rb") as handle:
        config = tomllib.load(handle)
    limit = config.get("max_sessions", 5)
    if type(limit) is not int or limit < 0:
        raise ValueError("max_sessions must be an integer greater than or equal to 0")
    idle_hours = config.get("session_idle_timeout_hours", DEFAULT_SESSION_IDLE_HOURS)
    if type(idle_hours) is not int or idle_hours <= 0:
        raise ValueError("session_idle_timeout_hours must be a positive integer")
    base = config.get("public_base", "https://47.109.34.254:9443/pp-sim/")
    if not isinstance(base, str) or not re.fullmatch(r"https://[A-Za-z0-9.:-]+/pp-sim/", base):
        raise ValueError("public_base must be an HTTPS URL ending in /pp-sim/")
    return {"max_sessions": limit, "idle_timeout": idle_hours * 3600, "public_base": base}


def worker(lab, action, config, timeout=None):
    python = lab.pa / ".venv/bin/python"
    script = Path(__file__).with_name("pp_sim_cli.py")
    command = [python, script, action, str(lab.state), str(lab.pa), json.dumps(config)]
    return subprocess.run(command, timeout=timeout, check=False).returncode


def browser_run(lab, image, scenario, args, config, expected=None):
    options = {
        **config, "image": image, "scenario": scenario, "fault": args.fault, "expected": expected,
        "share": args.share or args.wait_for_join or args.wait_for_slot or args.replace_oldest,
        "wait": args.wait_for_join, "wait_for_slot": args.wait_for_slot,
        "replace_oldest": args.replace_oldest,
    }
    timeout = None if args.wait_for_slot else 180 + (35 if args.wait_for_join else 0)
    return worker(lab, "run", options, timeout=timeout)


def capacity_options(command):
    choices = command.add_mutually_exclusive_group()
    choices.add_argument("--wait-for-slot", action="store_true", help="Wait in the shared-session queue")
    choices.add_argument("--replace-oldest", action="store_true",
                         help="Replace the least recently active instance if all slots are busy")


def configure(parser):
    commands = parser.add_subparsers(dest="sim_command", required=True)
    parser.add_argument("--config", type=Path, default=SITE / "config/passportsim.toml")
    serve = commands.add_parser("serve", help="Run shared instances for PassportSim")
    serve.add_argument("--socket", type=Path, default=ROOT / "runtime/passportsim-service/public.sock")
    serve.add_argument("--group", type=int, help="Group that can connect to the public Unix socket")
    session = commands.add_parser("session", help="Control a shared instance locally")
    operations = session.add_subparsers(dest="operation", required=True)
    new = operations.add_parser("new", help="Start a persistent shared instance")
    source = new.add_mutually_exclusive_group(required=True)
    source.add_argument("--version")
    source.add_argument("--candidate")
    capacity_options(new)
    for name in ("status", "serial", "screen", "end", "press", "send"):
        operation = operations.add_parser(name)
        operation.add_argument("session_id")
        if name == "screen":
            operation.add_argument("output", type=Path)
        elif name == "press":
            operation.add_argument("key", choices=("up", "ok", "down", "power"))
            operation.add_argument("--ms", type=int, default=210)
        elif name == "send":
            operation.add_argument("line")
    commands.add_parser("catalog", help="List firmware and scenario IDs")
    attach = commands.add_parser("attach-elf", help="Register matching symbols for a published version")
    attach.add_argument("--version", required=True)
    attach.add_argument("elf", type=Path)
    run = commands.add_parser("run", help="Run a deterministic PassportSim scenario")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--version", help="Use an immutable published PA-Terminal version")
    source.add_argument("--candidate", help="Use a PP Lab candidate run ID")
    source.add_argument("--staged", help="Install an isolated release package by candidate run ID")
    run.add_argument("--case", default="offline-settings")
    run.add_argument("--fault", action="store_true", help="Inject a failing final assertion")
    inspect = commands.add_parser("inspect", help="Read run JSON or the retained serial text")
    inspect.add_argument("id")
    inspect.add_argument("--serial", action="store_true")
    replay = commands.add_parser("replay", help="Re-run the original version and scenario")
    replay.add_argument("id")
    replay.add_argument("--fault", action="store_true")
    stage = commands.add_parser("stage", help="Publish the candidate in a private release directory")
    stage.add_argument("run")
    iterate = commands.add_parser("iterate", help="Build, publish privately, install in the emulator and test")
    iterate.add_argument("--case", default="offline-maintenance")
    iterate.add_argument("--fault", action="store_true")
    for action in (run, replay, iterate):
        capacity_options(action)
        action.add_argument("--share", action="store_true", help="Print a PassportSim session link")
        action.add_argument("--wait-for-join", action="store_true",
                            help="Share and wait up to 30 seconds for a browser to join")


def execute(args, build: Callable[[], str | None]):
    lab = SimLab(args.state_dir.resolve(), args.pa_root.resolve())
    command = args.sim_command
    config = service_config(args.config)
    if command == "serve":
        return worker(lab, "serve", {**config, "socket": str(args.socket.resolve()), "group": args.group})
    if command == "session":
        options = vars(args)
        keys = ("operation", "version", "candidate", "session_id", "output", "key", "ms", "line")
        wait_for_slot = options.get("wait_for_slot", False)
        return worker(lab, "session", {
            **config, **{key: str(options[key]) for key in keys if options.get(key) is not None},
            "wait_for_slot": wait_for_slot, "replace_oldest": options.get("replace_oldest", False),
        }, timeout=None if wait_for_slot else 60)
    if command == "catalog":
        print(json.dumps(lab.catalog(), ensure_ascii=False, indent=2))
        return 0
    if command == "attach-elf":
        print(lab.attach_elf(args.version, args.elf))
        return 0
    if command == "inspect":
        record = lab.record(args.id)
        if args.serial:
            print((lab.evidence / args.id / "serial.txt").read_text(), end="")
        else:
            print(json.dumps(record, ensure_ascii=False, indent=2))
        return 0
    if command == "replay":
        record = lab.record(args.id)
        if not record["sha256"]:
            raise ValueError("This run never verified a bootable image")
        keys = ("sha256", "flashSha256", "elfSha256", "scenarioSha256", "simulator", "worker")
        required = {key: record[key] for key in keys if record.get(key)}
        return browser_run(lab, record["image"], record["scenario"], args, config, expected=required)
    if command == "stage":
        print(lab.stage(args.run))
        return 0
    if args.case not in lab.scenarios:
        raise ValueError(f"Unknown scenario: {args.case}")
    if command == "iterate":
        run = build()
        if not run:
            return 1
        print(f"Staged: {lab.stage(run)}", flush=True)
        image = f"staged:{run}"
    elif args.version:
        image = f"release:{args.version}"
    elif args.staged:
        image = f"staged:{args.staged}"
    else:
        image = f"candidate:{args.candidate}"
    lab.locate(image)
    return browser_run(lab, image, args.case, args, config)
