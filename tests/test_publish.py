import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest
import zipfile

spec=importlib.util.spec_from_file_location("publisher",Path(__file__).resolve().parents[1]/"tools/publish.py")
pub=importlib.util.module_from_spec(spec)
spec.loader.exec_module(pub)

class PublishTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        pub.ROOT=self.root;pub.SITE=self.root/"site"
        (pub.SITE/"config").mkdir(parents=True)
        self.candidate=self.root/"candidate";self.candidate.mkdir()
        files=[]
        for offset,name in [(0,"bootloader.bin"),(0x8000,"partition-table.bin"),(0x10000,"app.bin")]:
            data=bytes([offset%251])*16
            (self.candidate/name).write_bytes(data)
            files.append({"offset":hex(offset),"file":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
        self.manifest={"application":"Example","version":"0.1.0","target":"esp32c3","hardware_acceptance":"pending","flash_files":files}
        (self.candidate/"manifest.json").write_text(json.dumps(self.manifest))
        self.readme=self.root/"readme.md";self.readme.write_text("Operator instructions")
    def tearDown(self): self.temp.cleanup()
    def test_atomic_publication_and_private_files_excluded(self):
        (self.candidate/"private-secret.txt").write_text("not public")
        pub.publish(self.candidate,"example","description",self.readme)
        target=self.root/"releases/example/0.1.0"
        with zipfile.ZipFile(target/"firmware.zip") as archive:
            self.assertEqual(set(archive.namelist()),{"manifest.json","README.md","bootloader.bin","partition-table.bin","app.bin"})
        config=tomllib.loads((pub.SITE/"config/pp.toml").read_text())
        self.assertEqual(config["supported_apps"],["Example · 0.1.0"])
        self.assertEqual(config["Example · 0.1.0"]["acceptance"],"pending")
        pub.publish(self.candidate,"example","description",self.readme)
        with self.assertRaisesRegex(ValueError,"immutable"):
            pub.publish(self.candidate,"example","changed",self.readme)
    def test_named_font_license_is_published_without_private_artifacts(self):
        (self.candidate/"SourceHanSansSC.LICENSE.txt").write_text("SIL OPEN FONT LICENSE")
        (self.candidate/"LICENSE.folotoy").write_text("MIT license")
        (self.candidate/"debug.elf").write_bytes(b"private")
        pub.publish(self.candidate,"example","Chinese firmware",self.readme)
        with zipfile.ZipFile(self.root/"releases/example/0.1.0/firmware.zip") as archive:
            self.assertIn("SourceHanSansSC.LICENSE.txt",archive.namelist())
            self.assertIn("LICENSE.folotoy",archive.namelist())
            self.assertNotIn("debug.elf",archive.namelist())

    def test_corrupt_candidate_never_publishes(self):
        (self.candidate/"app.bin").write_bytes(b"invalid")
        with self.assertRaises(ValueError): pub.publish(self.candidate,"example","description",self.readme)
        self.assertFalse((self.root/"releases/example/0.1.0").exists())
        self.assertFalse((pub.SITE/"config/pp.toml").exists())
    def test_latest_release_is_default_and_old_images_remain_immutable(self):
        for version in ['0.1.2', '0.1.10', '0.1.1']:
            self.manifest['version']=version
            (self.candidate/'manifest.json').write_text(json.dumps(self.manifest))
            pub.publish(self.candidate,'example','description',self.readme)
        config=tomllib.loads((pub.SITE/'config/pp.toml').read_text())
        self.assertEqual(config['supported_apps'],['Example · 0.1.10','Example · 0.1.2','Example · 0.1.1'])
        self.assertTrue((self.root/'releases/example/0.1.2/app.bin').is_file())
    def test_nvs_offset_rejected(self):
        self.manifest["flash_files"][0]["offset"]="0x9000"
        (self.candidate/"manifest.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError,"layout"): pub.validate(self.candidate)
    def test_path_and_symlink_rejected(self):
        (self.candidate/"app.bin").unlink()
        (self.candidate/"app.bin").symlink_to(self.readme)
        with self.assertRaisesRegex(ValueError,"symlink"): pub.validate(self.candidate)

if __name__=="__main__": unittest.main()
