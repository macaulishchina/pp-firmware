"""Install a PP release or candidate on the workstation connected to its USB port."""
import argparse
from io import BytesIO
import hashlib
import json
from pathlib import Path
import re
import shutil
from subprocess import run
from types import SimpleNamespace
from zipfile import ZipFile

PLANNER = Path(__file__).with_name("upgrade_plan.mjs")
FLASH_BYTES = 8 * 1024 * 1024
TABLE = 0x8000
TABLE_BYTES = 0xc00
IMAGE_LIMITS = {
    0: ("bootloader.bin", TABLE),
    TABLE: ("partition-table.bin", TABLE_BYTES),
    0x10000: ("pa_terminal.bin", FLASH_BYTES - 0x10000),
}


def load_package(package):
    with ZipFile(package) as archive:
        def read(name, limit):
            if archive.namelist().count(name) != 1 or not 0 < archive.getinfo(name).file_size <= limit:
                raise ValueError(f"镜像包内容异常: {name}")
            return archive.read(name)

        manifest = json.loads(read("manifest.json", 64 * 1024))
        if manifest["target"] != "esp32c3" or manifest["application"] != "PA-Terminal":
            raise ValueError("请选择 ESP32-C3 PA-Terminal 固件包")
        policy = manifest.get("upgrade_policy", "pp-data-v1")
        if policy not in ("pp-data-v1", "pp-data-v2"):
            raise ValueError("此固件要求更新安装器")
        images = {}
        for row in manifest["flash_files"]:
            address = int(row["offset"], 0)
            name = row["file"]
            if address not in IMAGE_LIMITS or name != IMAGE_LIMITS[address][0] or address in images:
                raise ValueError("未知或重复的镜像地址")
            data = read(name, IMAGE_LIMITS[address][1])
            if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
                raise ValueError(f"大小或 SHA256 校验失败: {name}")
            images[address] = data
        if images.keys() != IMAGE_LIMITS.keys():
            raise ValueError("固件包缺少必要镜像")
    return images, policy


def check_layout(node, current, images, blank, policy="pp-data-v1"):
    request = {"current": current.hex(), "target": images[TABLE].hex(), "blankChip": blank, "policy": policy,
               "parts": [{"address": addr, "size": len(data)} for addr, data in images.items()]}
    check = run([node, str(PLANNER)], input=json.dumps(request), capture_output=True, encoding="utf-8")
    if check.returncode:
        raise ValueError(check.stderr.strip() or "分区检查失败")

    return json.loads(check.stdout)

def plan_install(node, device, images, policy="pp-data-v1"):
    current = device.read_flash(TABLE, TABLE_BYTES)
    blank = (current == b"\xff" * TABLE_BYTES and
             device.flash_md5sum(0, FLASH_BYTES) == hashlib.md5(b"\xff" * FLASH_BYTES).hexdigest())
    move = check_layout(node, current, images, blank, policy)
    changed = {}
    for addr, data in sorted(images.items()):
        actual = device.flash_md5sum(addr, len(data)).lower()
        if not re.fullmatch("[a-f0-9]{32}", actual):
            raise ValueError("设备镜像校验值无效")
        if hashlib.md5(data).hexdigest() != actual:
            changed[addr] = data
    copy = {}
    if move:
        source, destination, size = move["source"], move["destination"], move["size"]
        data = device.read_flash(source, size)
        expected = hashlib.md5(data).hexdigest()
        if len(data) != size or device.flash_md5sum(source, size).lower() != expected:
            raise ValueError("历史缓存读取校验失败")
        if device.flash_md5sum(destination, size).lower() != expected:
            copy[destination] = data
    return changed, copy


def install(package, port, check_only):
    import esptool
    from esptool.cmds import detect_flash_size, write_flash

    if esptool.__version__ != "4.13.0":
        raise ValueError("请使用 esptool==4.13.0")
    node = shutil.which("node")
    if not node:
        raise ValueError("请安装 Node.js 20 或更新版本，用于执行分区保护规则")
    images, policy = load_package(package)
    # Validate the target before opening the serial port.
    check_layout(node, images[TABLE], images, False, policy)
    with esptool.detect_chip(port=port) as rom:
        if (rom.CHIP_NAME != "ESP32-C3" or rom.secure_download_mode or rom.get_secure_boot_enabled()
                or rom.get_flash_encryption_enabled()):
            raise ValueError("设备不适用普通 PP 固件安装")
        device = rom if rom.IS_STUB else rom.run_stub()
        writing = False
        try:
            device.change_baud(460800)
            if detect_flash_size(device) != "8MB":
                raise ValueError("设备闪存容量与 PP 不符")
            device.flash_set_parameters(FLASH_BYTES)
            changes, copy = plan_install(node, device, images, policy)
            if copy:
                print("需要复制并校验旧历史缓存，再更新分区表。")
            print("需要写入: " + (", ".join(map(hex, changes)) or "无，固件已一致"))
            if check_only or not changes:
                return
            device.WRITE_FLASH_ATTEMPTS = 1
            for group in (copy, changes):
                if not group:
                    continue
                parts = []
                for addr, data in group.items():
                    image = BytesIO(data)
                    image.name = f"{addr:x}.bin"
                    parts.append((addr, image))
                options = SimpleNamespace(addr_filename=parts, compress=True, no_compress=False,
                                          no_stub=False, erase_all=False, force=False, encrypt=False,
                                          encrypt_files=None, flash_mode="keep", flash_freq="keep",
                                          flash_size="keep", no_progress=False)
                writing = True
                write_flash(device, options)
                for addr, data in group.items():
                    if device.flash_md5sum(addr, len(data)).lower() != hashlib.md5(data).hexdigest():
                        raise ValueError("设备写入校验失败，安装已停止")
                writing = False
        finally:
            if not writing:
                device.hard_reset()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--port", required=True)
    parser.add_argument("--check-only", action="store_true", help="USB 预检后复位，不写闪存")
    args = parser.parse_args()
    try:
        install(args.package, args.port, args.check_only)
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")
