"""Publish verified local candidate files and rebuild the Launchpad TOML directory.

This host-side command does not flash devices, compile firmware, or certify hardware.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import tomllib
import zipfile

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent
LIMITS = {0: 0x8000, 0x8000: 0x1000, 0x10000: 0x7F0000}


def application_limit(table):
    entry = struct.Struct("<HBBII16sI")
    ranges, application = [], None
    for offset in range(0, len(table) - entry.size + 1, entry.size):
        magic, kind, subtype, start, size, name, flags = entry.unpack_from(table, offset)
        if magic in {0xFFFF, 0xEBEB}:
            break
        if magic != 0x50AA or start < 0x9000 or not size or start + size > 0x800000:
            raise ValueError("Invalid partition table")
        if any(start < end and begin < start + size for begin, end in ranges):
            raise ValueError("Overlapping partitions")
        ranges.append((start, start + size))
        if kind == 0 and subtype == 0 and start == 0x10000:
            application = size
    if application is None:
        raise ValueError("Missing factory application partition")
    return application


def validate(candidate):
    candidate = candidate.resolve()
    manifest = json.loads((candidate / "manifest.json").read_text())
    if manifest["target"] != "esp32c3":
        raise ValueError("Only the PP ESP32-C3 profile is accepted")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", manifest["version"]):
        raise ValueError("Invalid version")
    offsets = set()
    names = set()
    image_data = {}
    for item in manifest["flash_files"]:
        offset = int(item["offset"], 0)
        if offset not in LIMITS or offset in offsets:
            raise ValueError("Unexpected layout; publishing NVS/duplicate offsets is refused")
        offsets.add(offset)
        name = item["file"]
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".bin") or name in names:
            raise ValueError("Image names must be simple basenames")
        names.add(name)
        path = candidate / name
        if path.is_symlink():
            raise ValueError("Images cannot be symlinks")
        data = path.read_bytes()
        image_data[offset] = data
        if not 0 < len(data) <= LIMITS[offset] or len(data) != item["bytes"]:
            raise ValueError("Image size mismatch")
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Image SHA256 mismatch")
    if offsets != set(LIMITS):
        raise ValueError("Expected bootloader, partition table and factory application")
    if len(image_data[0x10000]) > application_limit(image_data[0x8000]):
        raise ValueError("Application would overwrite a data/cache partition")
    return manifest


def atomic_text(path, text):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".catalog-")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def update_catalog():
    entries = []
    for path in sorted((ROOT / "releases").glob("*/*/manifest.json")):
        manifest = json.loads(path.read_text())
        entries.append((path.parent.relative_to(ROOT / "releases").as_posix(), manifest))
    # Keep each application's newest release first, so a fix becomes the default
    # without modifying the immutable files of previously published versions.
    entries.sort(key=lambda item: (
        item[0].split('/', 1)[0],
        tuple(-int(part) for part in item[1]['version'].split('-', 1)[0].split('.')),
        '-' in item[1]['version'],
        item[1]['version'],
    ))
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    names = [f'{m["application"]} · {m["version"]}' for _, m in entries]
    text = 'esp_toml_version = 1.0\nfirmware_images_url = "/firmware/"\n'
    text += "supported_apps = " + quote(names) + "\n"
    for (relative, m), title in zip(entries, names, strict=True):
        base = "/firmware/" + relative + "/"
        files = sorted(m["flash_files"], key=lambda item: int(item["offset"], 0))
        text += f"\n[{quote(title)}]\n"
        for key, value in {
            "description": m["description"], "version": m["version"],
            "board": "FoloToy AI Passport", "acceptance": m["hardware_acceptance"],
            "download": base + "firmware.zip", "manifest": base + "manifest.json",
        }.items():
            text += f"{key} = {quote(value)}\n"
        text += 'chipsets = ["ESP32-C3"]\nconsole_baudrate = 115200\n'
        if m.get("release_channel"):
            text += f'channel = {quote(m["release_channel"])}\n'
        text += f'readme.text = {quote(base + "README.md")}\n'
        for key, values in {
            "parts": [base + f["file"] for f in files],
            "addresses": [f["offset"] for f in files],
            "sizes": [f["bytes"] for f in files],
            "sha256": [f["sha256"] for f in files],
        }.items():
            text += f"image.esp32-c3.{key} = {quote(values)}\n"
    tomllib.loads(text)  # Never replace the live catalog with malformed TOML.
    atomic_text(SITE / "config/pp.toml", text)


def publish(candidate, app_id, description, readme, channel=None):
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,40}", app_id):
        raise ValueError("Invalid application id")
    candidate = Path(candidate)
    manifest = validate(candidate)
    manifest = {**manifest, "description": description}
    if channel is not None:
        if channel not in {"daily", "stable", "preview"}:
            raise ValueError("Unknown release channel")
        manifest["release_channel"] = channel
    target = ROOT / "releases" / app_id / manifest["version"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        existing = json.loads((target / "manifest.json").read_text())
        if existing != manifest:
            raise ValueError("Published versions are immutable; choose a new version")
        validate(target)
    else:
        stage = Path(tempfile.mkdtemp(prefix=".staging-", dir=target.parent))
        try:
            for item in manifest["flash_files"]:
                shutil.copyfile(candidate / item["file"], stage / item["file"])
            (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            (stage / "README.md").write_text(Path(readme).read_text())
            # Only named public license files may accompany the image whitelist.
            licenses = []
            for name in ("LICENSE.folotoy", "SourceHanSansSC.LICENSE.txt", "LittleFS.LICENSE.txt"):
                source = candidate / name
                if source.is_symlink():
                    raise ValueError("Public license files cannot be symlinks")
                if source.is_file():
                    shutil.copyfile(source, stage / name)
                    licenses.append(name)
            with zipfile.ZipFile(stage / "firmware.zip", "w", zipfile.ZIP_DEFLATED) as archive:
                for name in ["manifest.json", "README.md", *licenses, *(f["file"] for f in manifest["flash_files"])]:
                    archive.write(stage / name, name)
            # mkdtemp defaults to 0700; published files must be readable by nginx.
            stage.chmod(0o755)
            for path in stage.iterdir():
                path.chmod(0o644)
            os.replace(stage, target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    update_catalog()
    print(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--readme", required=True, type=Path)
    parser.add_argument("--channel", choices=["daily", "stable", "preview"])
    args = parser.parse_args()
    lock = ROOT / "private/publish.lock"
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        publish(args.candidate, args.id, args.description, args.readme, args.channel)
