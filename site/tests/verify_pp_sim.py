"""Browser acceptance for the deployed PassportSim session UI."""
import argparse
import sys
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


def check(url, version):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        pages = [
            browser.new_page(locale="zh-CN", ignore_https_errors=True, viewport={"width": 1440, "height": 1050})
            for _ in range(3)
        ]
        first, second, local = pages
        issues = []
        for page in pages:
            page.on("pageerror", lambda error: (issues.append(str(error)), print(error.stack or error, file=sys.stderr, flush=True)))
            page.set_default_timeout(35000)

        local.goto(url)
        local.wait_for_function("Boolean(window.passportEmu)", timeout=12000)
        expect(local.get_by_role("button", name="新建会话")).to_be_enabled(timeout=12000)
        assert local.evaluate("!document.documentElement.classList.contains('pp-remote')")

        first.goto(url)
        first.get_by_label("固件版本").select_option(f"release:{version}")
        first.get_by_role("button", name="新建会话").click()
        first.wait_for_url("**/?session=*")
        shared_url = first.url
        assert len(parse_qs(urlsplit(shared_url).query)["session"][0]) == 48
        second.goto(shared_url)
        for page in (first, second):
            expect(page.locator(".pp-session-bar output")).to_contain_text(version, timeout=15000)
            page.wait_for_function(
                """async () => (await window.passportEmu.call('ui', {})).json.text.includes('设备连接')""",
                timeout=15000,
            )
            page.wait_for_function(
                """() => document.querySelector('canvas.glass').getContext('2d').getImageData(0, 0, 240, 320)
                    .data.some((value) => value > 0)""", timeout=10000,
            )
        first.keyboard.press("Enter")
        second.wait_for_function(
            """async () => (await window.passportEmu.call('ui', {})).json.text.includes('label "设置"')""",
            timeout=15000,
        )
        second.locator('[data-mode-switch="advanced"]').click()
        serial = second.locator(".console-input")
        serial.fill("pp.status")
        serial.press("Enter")
        first.wait_for_function(
            """async () => (await window.passportEmu.call('serial', {op: 'read'})).text.includes('"app":"PA-Terminal"')""",
            timeout=12000,
        )
        first.close()
        second.reload()
        expect(second.locator(".pp-session-bar output")).to_contain_text(version)
        state = second.evaluate("() => window.passportEmu.call('ui', {})")
        assert 'label "设置"' in state["json"]["text"]
        expect(local.locator(".pp-session-bar output")).to_have_text("")
        second.on("dialog", lambda dialog: dialog.accept())
        second.get_by_role("button", name="结束会话").click()
        expect(second.locator(".pp-session-bar output")).to_contain_text("会话已结束")
        second.reload()
        expect(second.locator(".pp-session-bar output")).to_contain_text("会话不存在或已结束")
        assert not issues, issues
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--version", default="0.2.1-preview.6")
    args = parser.parse_args()
    check(args.url, args.version)
    print("PassportSim stock and shared browser modes passed")
