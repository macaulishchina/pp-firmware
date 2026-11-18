"""Configuration of the acceptance evidence inputs."""
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import pp_lab


class AcceptanceInputsTest(unittest.TestCase):
    def test_pin_manifest_and_board_source_each_invalidate_integration_evidence(self):
        with TemporaryDirectory() as directory:
            pa = Path(directory) / "pa"
            site = Path(directory) / "site"
            lab = SimpleNamespace(pa=pa, version="0.2.1-preview.7",
                                  release_profile=site / "config/build.toml", release_ca=None)
            inputs = (
                pp_lab.FIRMWARE / "bsp.sha256.json",
                pp_lab.FIRMWARE / "components/bsp/src/bsp_audio.c",
            )
            for name in inputs:
                path = pa / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original")

            with patch.object(pp_lab, "SITE", site), patch.object(
                pp_lab, "repo_files", side_effect=lambda root: list(inputs) if root == pa else []
            ):
                original = pp_lab.Lab.signatures(lab)["integration"]
                for name in inputs:
                    with self.subTest(path=name):
                        path = pa / name
                        path.write_text("changed")
                        self.assertNotEqual(pp_lab.Lab.signatures(lab)["integration"], original)
                        path.write_text("original")
