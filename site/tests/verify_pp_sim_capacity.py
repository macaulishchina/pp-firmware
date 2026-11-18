"""Exercise the full-capacity UI against a dedicated one-slot PassportSim service."""
import argparse
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def check(url):
    with sync_playwright() as driver:
        browser = driver.chromium.launch()
        first, second, third = [
            browser.new_page(locale="zh-CN", ignore_https_errors=True) for _ in range(3)
        ]
        for page in (first, second, third):
            page.goto(url)
            expect(page.get_by_role("button", name="新建会话")).to_be_enabled(timeout=15000)

        def create(page):
            page.get_by_role("button", name="新建会话").click()

        def end(page):
            page.once("dialog", lambda prompt: prompt.accept())
            page.get_by_role("button", name="结束会话").click()

        def wait_button(page):
            return page.get_by_role("button", name="等待空位")

        create(first)
        first.wait_for_url("**/?session=*", timeout=45000)
        expect(first.get_by_role("button", name="结束会话")).to_be_enabled(timeout=15000)
        create(second)
        expect(wait_button(second)).to_be_visible(timeout=15000)
        wait_button(second).click()
        expect(second.locator(".pp-session-bar output")).to_contain_text("第 1 位")
        second.get_by_role("button", name="取消等待").click()
        expect(second.locator(".pp-session-bar output")).to_have_text("已取消等待")
        assert not urlsplit(second.url).query
        wait_button(second).click()
        expect(second.locator(".pp-session-bar output")).to_contain_text("第 1 位")
        end(first)
        second.wait_for_url("**/?session=*", timeout=45000)
        expect(second.get_by_role("button", name="结束会话")).to_be_enabled(timeout=15000)

        create(third)
        replace = third.get_by_role("button", name="顶掉最久未活动的实例")
        expect(replace).to_be_visible(timeout=15000)
        third.once("dialog", lambda prompt: prompt.dismiss())
        replace.click()
        assert not urlsplit(third.url).query
        third.once("dialog", lambda prompt: prompt.accept())
        replace.click()
        expect(second.locator(".pp-session-bar output")).to_contain_text("被新建会话顶掉", timeout=15000)
        third.wait_for_url("**/?session=*", timeout=45000)
        expect(third.get_by_role("button", name="结束会话")).to_be_enabled(timeout=15000)
        end(third)
        expect(third.locator(".pp-session-bar output")).to_have_text("会话已结束")
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    check(parser.parse_args().url)
    print("PassportSim queue, cancellation, preemption confirmation and old-session notification passed")
