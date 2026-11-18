"""Invoke the same scenario and evidence path available from the browser UI."""
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def main(address, config, evidence):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        page.route(
            lambda url: urlsplit(url).scheme in {"http", "https"}
            and urlsplit(url).netloc != urlsplit(address).netloc,
            lambda route: route.abort(),
        )
        page.goto(address, wait_until="domcontentloaded")
        page.wait_for_function("Boolean(window.ppLab)", timeout=15000)
        record = page.evaluate(
            "config => window.ppLab.run(config.image, config.scenario, config)", config
        )
        summary = {key: record[key] for key in ("id", "image", "scenario", "status", "error", "wallMs")}
        summary["steps"] = len(record["steps"])
        summary["evidence"] = str(Path(evidence) / record["id"])
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        browser.close()
        return 0 if record["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]))
