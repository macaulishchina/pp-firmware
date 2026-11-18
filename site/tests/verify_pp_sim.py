"""Browser acceptance for selecting firmware, retaining failures and replaying."""
import argparse
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


def check(url, version):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(base_url=url, viewport={"width": 1440, "height": 1100})
        page.set_default_timeout(15000)
        expect.set_options(timeout=15000)
        issues = []
        page.on("pageerror", lambda error: issues.append(str(error)))
        page.goto(url)
        image = page.get_by_label("固件版本")
        image.select_option(f"release:{version}")
        page.get_by_label("场景").select_option("offline-settings")
        page.get_by_role("button", name="启动固件", exact=True).click()
        expect(page.locator("#tree")).to_contain_text("设备连接")
        page.get_by_role("button", name="OK", exact=True).click()
        expect(page.locator("#tree")).to_contain_text('label "设置"')
        expect(page.locator("#tree")).to_contain_text("设备维护")
        page.get_by_role("button", name="发送", exact=True).click()
        expect(page.locator("#serial")).to_contain_text('"app":"PA-Terminal"')
        expect(page.get_by_role("link", name="保存截图")).to_be_visible()

        page.get_by_label("注入断言失败").check()
        page.get_by_role("button", name="运行场景").click()
        record = page.locator("#record")
        expect(record.get_by_role("heading")).to_contain_text("失败")
        expect(record).to_contain_text("PP Lab 注入的失败断言")
        fail = parse_qs(urlsplit(page.url).query)["run"][0]
        screenshot = record.get_by_role("link", name="打开截图").last
        png = page.request.get(screenshot.get_attribute("href"))
        assert png.ok and png.body().startswith(b"\x89PNG\r\n\x1a\n")
        serial = page.request.get(record.get_by_role("link", name="查看串口").get_attribute("href"))
        assert serial.ok and "app_main()" in serial.text()
        info = page.request.get(record.get_by_role("link", name="运行 JSON").get_attribute("href")).json()
        assert info["steps"][-1]["status"] == "fail"
        assert "设置" in info["steps"][-1]["actual"]

        page.reload()
        expect(record.get_by_role("heading")).to_contain_text("失败")
        record.get_by_role("button", name="按原版本复跑场景").click()
        expect(record.get_by_role("heading")).to_contain_text("通过")
        passed = parse_qs(urlsplit(page.url).query)["run"][0]
        assert passed != fail
        new = page.request.get(record.get_by_role("link", name="运行 JSON").get_attribute("href")).json()
        for key in ("sha256", "elfSha256", "flashSha256", "simulator", "worker", "scenarioSha256", "initial"):
            assert new[key] == info[key]
        assert not issues, issues
        print(f"Browser pass | retained failure {fail} | replay {passed}", flush=True)
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9451/")
    parser.add_argument("--version", default="0.2.1-preview.6")
    choices = parser.parse_args()
    check(choices.url, choices.version)
