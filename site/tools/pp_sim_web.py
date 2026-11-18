"""Build the PP session client beside an existing PassportSim Web distribution."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory

from pp_sim import ENGINE, ROOT, WEB


def install(destination, bun):
    upstream = ROOT / "upstream/passportsim"
    source = WEB / "web"
    expected = (upstream / ".bun-version").read_text().strip()
    if subprocess.check_output([bun, "--version"], text=True).strip() != expected:
        raise ValueError(f"PassportSim requires Bun {expected}")
    for name in ("main.js", "worker.js", "styles.css", "pemu_wasm.wasm"):
        if not (destination / name).is_file():
            raise ValueError(f"Build the upstream Web distribution first: missing {name}")
    html = (upstream / "web/public/index.html").read_text()
    html, found = re.subn(r'src="\./main\.js"', 'src="./pp-entry.js"', html)
    if found != 1:
        raise ValueError("PassportSim's Web entry changed")
    html = html.replace("</head>", '  <link rel="stylesheet" href="./pp-session.css">\n  </head>', 1)
    with TemporaryDirectory(prefix=".pp-web-", dir=destination) as temp:
        pending = Path(temp)
        subprocess.run([
            bun, "build", source / "entry.ts", "--target=browser", "--production", "--minify",
            "--splitting", "--outdir", pending, "--entry-naming=pp-entry.js",
            "--chunk-naming=pp-session-[hash].js",
        ], check=True)
        shutil.copyfile(source / "session.css", pending / "pp-session.css")
        (pending / "index.html").write_text(html)
        files = [*sorted(pending.glob("pp-session-*.js")), pending / "pp-entry.js",
                 pending / "pp-session.css", pending / "index.html"]
        for file in files:
            file.chmod(0o644)
            os.replace(file, destination / file.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ENGINE)
    parser.add_argument("--bun", default="bun")
    args = parser.parse_args()
    install(args.directory.resolve(), args.bun)
