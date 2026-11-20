"""Run the USB preflight on a byte-addressed flash, with the same Node planner as the site."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

SITE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("installer", SITE / "tools/install_firmware.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def table(factory_size, extra=(), history=(0x780000, 0x80000)):
    rows = [(1, 2, 0x9000, 0x6000, b"nvs"), (1, 1, 0xf000, 0x1000, b"phy_init"),
            (0, 0, 0x10000, factory_size, b"factory"), (1, 0x83, *history, b"pp_cache"), *extra]
    payload = b"".join(struct.pack("<HBBII16sI", 0x50aa, *row, 0) for row in rows)
    trailer = b"\xeb\xeb" + b"\xff" * 14 + hashlib.md5(payload).digest()
    return (payload + trailer).ljust(installer.TABLE_BYTES, b"\xff")


class Flash:
    def __init__(self):
        self.data = bytearray(b"\xff") * installer.FLASH_BYTES

    def read_flash(self, offset, size):
        return self.data[offset:offset+size]

    def flash_md5sum(self, offset, size):
        return hashlib.md5(self.read_flash(offset, size)).hexdigest()

    def apply(self, images):
        for offset, data in images.items():
            count = (len(data) + 4095) // 4096 * 4096
            self.data[offset:offset+count] = data.ljust(count, b"\xff")


class InstallTest(unittest.TestCase):
    def test_layout_transition_preserves_data_and_prevents_unsafe_downgrade(self):
        flash = Flash()
        node = shutil.which("node")
        old = {0: b"boot", installer.TABLE: table(0x770000), 0x10000: b"previous"}
        new = {**old, installer.TABLE: table(0x3f0000, [(1, 0x40, 0x400000, 0x380000, b"pp_stream")]), 0x10000: b"new"}
        flash.apply(installer.plan_install(node, flash, old)[0])
        flash.data[0x9000:0xf000] = b"N" * 0x6000
        flash.data[0x780000:] = b"H" * 0x80000
        changes = installer.plan_install(node, flash, new)[0]
        self.assertEqual(set(changes), {0x8000, 0x10000})
        flash.apply(changes)
        self.assertEqual(flash.data[0x9000:0xf000], b"N" * 0x6000)
        self.assertEqual(flash.data[0x780000:], b"H" * 0x80000)
        self.assertFalse(installer.plan_install(node, flash, new)[0])
        with self.assertRaisesRegex(ValueError, "pp_stream"):
            installer.plan_install(node, flash, old)[0]

    def test_resume_verified_history_copy_before_changing_table(self):
        flash = Flash()
        old = {0: b"boot", installer.TABLE: table(0x3f0000, [(1, 0x40, 0x400000, 0x380000, b"pp_stream")]),
               0x10000: b"app"}
        target = {**old, installer.TABLE: table(0x3f0000, [(1, 0x40, 0x400000, 0x300000, b"pp_stream")],
                                               history=(0x700000, 0x100000))}
        flash.apply(old)
        history = bytes(range(256)) * 2048
        flash.apply({0x780000: history})
        plan = lambda: installer.plan_install(shutil.which("node"), flash, target, "pp-data-v2")
        changes, copy = plan()
        self.assertEqual(copy, {0x700000: history})
        self.assertEqual(changes, {installer.TABLE: target[installer.TABLE]})
        flash.apply(copy)
        self.assertEqual(plan(), (changes, {}))
        self.assertEqual(flash.read_flash(installer.TABLE, installer.TABLE_BYTES), old[installer.TABLE])
        self.assertEqual(flash.read_flash(0x780000, len(history)), history)
        flash.apply(changes)
        self.assertEqual(plan(), ({}, {}))

    def test_usb_install_never_writes_after_refusal_or_replays_uncertain_writes(self):
        flash = Flash()
        rom = MagicMock(CHIP_NAME="ESP32-C3", secure_download_mode=False, IS_STUB=True)
        rom.__enter__.return_value = rom
        rom.get_secure_boot_enabled.return_value = False
        rom.get_flash_encryption_enabled.return_value = False
        rom.read_flash.side_effect = flash.read_flash
        rom.flash_md5sum.side_effect = flash.flash_md5sum
        esptool = MagicMock(__version__="4.13.0")
        esptool.detect_chip.return_value = rom
        commands = MagicMock()
        commands.detect_flash_size.return_value = "8MB"
        old = {0:b"boot", installer.TABLE:table(0x770000), 0x10000:b"app"}
        new = {**old, installer.TABLE:table(0x3f0000, [(1, 0x40, 0x400000, 0x380000, b"pp_stream")])}
        flash.apply(new)
        with patch.dict(sys.modules, {"esptool":esptool, "esptool.cmds":commands}), patch.object(
            installer, "load_package", return_value=(old, "pp-data-v1")
        ):
            with self.assertRaisesRegex(ValueError, "pp_stream"):
                installer.install("archive", "port", False)
            commands.write_flash.assert_not_called()
            flash.apply(old)
            flash.data[0x10000] ^= 1
            installer.install("archive", "port", True)
            commands.write_flash.assert_not_called()
            def interrupt(device, options):
                self.assertFalse(options.erase_all)
                self.assertEqual(device.WRITE_FLASH_ATTEMPTS, 1)
                self.assertEqual([(a, f.read()) for a, f in options.addr_filename], [(0x10000,b"app")])
                raise OSError("disconnected")
            rom.hard_reset.reset_mock()
            commands.write_flash.side_effect = interrupt
            with self.assertRaisesRegex(OSError, "disconnected"):
                installer.install("archive", "port", False)
            commands.write_flash.assert_called_once()
            rom.hard_reset.assert_not_called()

    def test_zip_refuses_unsupported_policy_wrong_hash_or_missing_part(self):
        blobs = {address: (b"test" if address != installer.TABLE else table(0x770000))
                 for address in installer.IMAGE_LIMITS}
        files = [{"offset": hex(addr), "file": installer.IMAGE_LIMITS[addr][0], "bytes": len(data),
                  "sha256": hashlib.sha256(data).hexdigest()} for addr, data in blobs.items()]
        manifest = {"target": "esp32c3", "application": "PA-Terminal", "flash_files": files}
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "firmware.zip"
            for fields, error in [({}, None), ({"upgrade_policy":"unknown"}, "安装器"),
                                  ({"flash_files":files[:-1]}, "缺少"),
                                  ({"flash_files":[{**files[0], "sha256":"0"*64}, *files[1:]]}, "SHA256")]:
                with ZipFile(package, "w") as archive:
                    archive.writestr("manifest.json", json.dumps({**manifest, **fields}))
                    for addr, data in blobs.items():
                        archive.writestr(installer.IMAGE_LIMITS[addr][0],data)
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        installer.load_package(package)[0]
                else:
                    self.assertEqual(installer.load_package(package)[0], blobs)


if __name__ == "__main__":
    unittest.main()
