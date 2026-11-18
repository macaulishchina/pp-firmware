"""Private, loopback-only PP Lab workbench and shared browser automation."""
import argparse
import base64
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
from urllib.parse import unquote, urlsplit
from zipfile import BadZipFile, ZipFile

import publish

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent
WEB = Path(__file__).with_name("sim")
ENGINE = ROOT / "runtime/passportsim"
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?")
RUN = re.compile(r"\d{8}T\d{6}-[a-z0-9_]{8}")
DIGEST = re.compile(r"[0-9a-f]{64}")
ARTIFACT = re.compile(r"(?:serial\.txt|step-[0-9]{2}\.(?:png|txt))")
ENGINE_ASSET = re.compile(r"/engine/([a-f0-9]{64})-([a-f0-9]{64})/(worker\.js|pemu_wasm\.wasm)")
RELEASE_PARTS = {"bootloader.bin", "partition-table.bin", "pa_terminal.bin"}
FLASH_BYTES = 8 * 1024 * 1024
MAX_ELF = 32 * 1024 * 1024
MAX_EVIDENCE = 2 * 1024 * 1024
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

    def catalog(self):
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

    def records(self):
        return [
            {"id": folder.name, **{key: rec[key] for key in ("version", "scenario", "at", "status")}}
            for folder in sorted(self.evidence.iterdir(), reverse=True)
            if RUN.fullmatch(folder.name) and (folder / "run.json").is_file()
            for rec in [self.record(folder.name)]
        ][:30]

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


class Handler(BaseHTTPRequestHandler):
    server_version = "PP-Lab"

    def log_message(self, *args):
        pass

    def reply(self, data, kind, status=200, **headers):
        chunks = (data,) if isinstance(data, bytes) else data
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(sum(map(len, chunks))))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(chunk)

    def json(self, item, status=200):
        self.reply(json.dumps(item, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

    def allowed_host(self):
        return re.fullmatch(r"(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?", self.headers.get("Host", ""))

    def read_file(self, path, expected=None):
        kind = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.suffix == ".wasm":
            kind = "application/wasm"
        data = path.read_bytes()
        if expected is not None and sha(data) != expected:
            raise ValueError("PassportSim was updated during boot. Start the run again.")
        self.reply(data, kind)

    def handle_route(self):
        lab = self.server.lab
        path = urlsplit(self.path).path
        if path in {"/", "/lab.js", "/engine.js", "/lab.css"}:
            return self.read_file(WEB / (path[1:] or "index.html"))
        if asset := ENGINE_ASSET.fullmatch(path):
            worker, wasm, name = asset.groups()
            return self.read_file(ENGINE / name, worker if name == "worker.js" else wasm)
        if path == "/catalog":
            return self.json(lab.catalog())
        if path == "/runs":
            return self.json(lab.records())
        if path.startswith("/images/") and path.count("/") == 2:
            meta, flash, elf = lab.image(unquote(path.split("/", 2)[2]))
            return self.reply((flash, elf), "application/octet-stream", **{"X-PP-Image": json.dumps(meta)})
        if path.startswith("/runs/"):
            parts = path[6:].split("/")
            record = lab.record(parts[0])
            if len(parts) == 1:
                return self.json(record)
            if len(parts) == 2 and ARTIFACT.fullmatch(parts[1]):
                return self.read_file(lab.evidence / parts[0] / parts[1])
        self.json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_GET(self):
        if not self.allowed_host():
            return self.json({"error": "Use the local PP Lab URL"}, HTTPStatus.FORBIDDEN)
        try:
            self.handle_route()
        except FileNotFoundError:
            self.json({"error": "Firmware, simulator or run artifact is missing"}, HTTPStatus.NOT_FOUND)
        except (BadZipFile, KeyError, TypeError, ValueError) as error:
            self.json({"error": str(error)}, HTTPStatus.UNPROCESSABLE_ENTITY)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        host = self.headers.get("Host", "")
        if (
            not self.allowed_host() or self.headers.get("Origin") != f"http://{host}"
            or self.path != "/runs" or self.headers.get_content_type() != "application/json"
        ):
            return self.json({"error": "Only the local workbench can save runs"}, HTTPStatus.FORBIDDEN)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_EVIDENCE:
                raise ValueError("Run record exceeds its size limit")
            self.connection.settimeout(10)
            self.json(self.server.lab.save(json.loads(self.rfile.read(size))), HTTPStatus.CREATED)
        except (KeyError, ValueError, TypeError, AttributeError, TimeoutError) as error:
            self.json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except (BrokenPipeError, ConnectionResetError):
            pass


def server_for(lab, port):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.lab = lab
    return server


@contextmanager
def temporary_server(lab):
    with server_for(lab, 0) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def browser_run(lab, image, scenario, fault=False, old=None):
    python = lab.pa / ".venv/bin/python"
    script = WEB / "headless.py"
    # Reuse the very same browser actions and evidence as the workbench.
    with temporary_server(lab) as address:
        config = {"image": image, "scenario": scenario, "fault": fault, "expected": old}
        command = [python, script, address, json.dumps(config, ensure_ascii=False), lab.evidence]
        result = subprocess.run(command, timeout=180, check=False)
    return result.returncode


def configure(parser):
    commands = parser.add_subparsers(dest="sim_command", required=True)
    serve = commands.add_parser("serve", help="Open the private browser workbench")
    serve.add_argument("--port", type=int, default=9451)
    commands.add_parser("catalog", help="List firmware and scenario IDs")
    attach = commands.add_parser("attach-elf", help="Register matching symbols for a published version")
    attach.add_argument("--version", required=True)
    attach.add_argument("elf", type=Path)
    run = commands.add_parser("run", help="Run the browser workbench in headless Chromium")
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


def execute(args, build: Callable[[], str | None]):
    lab = SimLab(args.state_dir.resolve(), args.pa_root.resolve())
    command = args.sim_command
    if command == "serve":
        with server_for(lab, args.port) as server:
            print(f"PP Lab · http://127.0.0.1:{server.server_port}/", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        return 0
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
        return browser_run(lab, record["image"], record["scenario"], args.fault, required)
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
    return browser_run(lab, image, args.case, args.fault)
