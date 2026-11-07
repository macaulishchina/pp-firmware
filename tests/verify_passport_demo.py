"""Browser acceptance for the isolated PP interaction study; never accesses real hardware."""
import asyncio
import json
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright, expect


async def verify():
    site = Path(__file__).resolve().parents[1]
    app = web.Application()
    app.router.add_static('/', site / 'public')
    async with TestServer(app) as server, async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1440, 'height': 1100})
        errors, outside_requests = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: outside_requests.append(r.url) if not r.url.startswith(str(server.make_url('/'))) else None)
        await page.goto(str(server.make_url('/pp-demo/')) + 'index.html')
        ok = page.locator('#key-ok')

        async def hold():
            await ok.hover()
            await page.mouse.down()
            await page.wait_for_timeout(420)
            await expect(page.locator('#screen-content')).to_contain_text('正在听')
            await page.mouse.up()
            await expect(page.locator('#screen-content')).to_contain_text('收音已结束')

        async def tap():
            await ok.click()
            await page.wait_for_timeout(340)

        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-desktop.png'), full_page=True)
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('交给我了')
        await expect(page.locator('#screen-content')).to_contain_text('嘟嘟正在说',timeout=5000)
        await ok.click()
        await expect(page.locator('#screen-content')).not_to_contain_text('嘟嘟正在说')
        await tap()
        await expect(page.locator('#screen-content')).to_contain_text('操作菜单')
        await page.keyboard.press('Escape')
        await ok.dblclick(delay=90)
        await expect(page.locator('#mode-badge')).to_have_text('排队')
        await page.reload()
        await expect(page.locator('#mode-badge')).to_have_text('排队')
        await page.locator('#recognition-failure').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('这次没听清')
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('交给我了')
        await page.locator('#network-toggle').click()
        await expect(page.locator('#screen-content')).to_contain_text('暂时离线')
        await tap()
        await expect(page.locator('#screen-content')).to_contain_text('操作菜单')
        await page.keyboard.press('Escape')
        await page.locator('#network-toggle').click()
        await expect(page.locator('#screen-content')).not_to_contain_text('暂时离线')
        await page.locator('[data-scenario=clarify]').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('你想几点提醒', timeout=5000)
        await expect(page.locator('#utterance')).to_contain_text('晚上八点')
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('已记下晚上八点', timeout=5000)
        await page.locator('[data-scenario=long]').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('嘟嘟正在说',timeout=5000)
        await page.locator('#key-down').click()
        await expect(page.locator('#page-number')).to_contain_text('2 /')
        await page.locator('[data-scenario=task]').click()
        await hold()
        await expect(page.locator('#task-complete')).to_be_enabled(timeout=5000)
        await page.locator('#task-complete').click()
        await expect(page.locator('#task-complete')).to_be_disabled()
        await ok.click()  # stop playback immediately
        await tap()  # open menu
        await page.locator('#key-down').click()
        await tap()  # task messages
        await expect(page.locator('#screen-content')).to_contain_text('电影推荐已整理好')
        await tap()  # report detail
        await expect(page.locator('#screen-content')).to_contain_text('任务报告')
        # Wake consumes one gesture; it never starts a recording.
        await page.keyboard.press('Escape')
        await tap()
        for _ in range(6): await page.locator('#key-down').click()
        await tap()
        await expect(page.locator('#screen-content')).to_contain_text('休息一下')
        await tap()
        await expect(page.locator('#screen-content')).not_to_contain_text('正在听')
        # Losing a held pointer discards input instead of committing it.
        await page.locator('[data-scenario=short]').click()
        await ok.hover(); await page.mouse.down(); await page.wait_for_timeout(350)
        await page.dispatch_event('#key-ok','pointercancel')
        await page.mouse.up()
        await expect(page.locator('#screen-content')).not_to_contain_text('正在听')
        await expect(page.locator('#screen-content')).not_to_contain_text('交给我了')
        # Extend only the scene declaration: no shell, controller or model changes.
        extra = {
            'id': 'travel', 'title': '出行清单', 'description': '独立场景声明',
            'prompt': '帮我整理明天的出行清单。', 'reply': '已整理：证件、钥匙和水杯。这是通过场景声明接入的演示。',
        }
        source = (site / 'public/pp-demo/scenarios.js').read_text() + '\nscenarios.push(' + json.dumps(extra, ensure_ascii=False) + ');'
        await page.route('**/scenarios.js', lambda route: route.fulfill(body=source, content_type='application/javascript'))
        await page.reload()
        await page.get_by_role('button', name='↗ 出行清单 独立场景声明').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('已整理：证件', timeout=5000)
        await page.unroute('**/scenarios.js')
        await page.reload()
        # PC keyboard shares the same hold/release behavior; key repeat cannot restart input.
        await page.locator('body').click(position={'x': 20, 'y': 120})
        await page.keyboard.down('Space')
        await page.wait_for_timeout(320)
        await expect(page.locator('#screen-content')).to_contain_text('正在听')
        await page.keyboard.up('Space')
        await expect(page.locator('#screen-content')).to_contain_text('收音已结束')
        await page.reload()
        for width in (1280, 1440, 1920):
            await page.set_viewport_size({'width':width,'height':1100})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        await page.set_viewport_size({'width':1440,'height':1100})
        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-desktop.png'),full_page=True)
        assert not errors, errors
        assert not outside_requests, outside_requests
        await browser.close()
        print('Browser acceptance passed: hold/release, stop, menu, persistence, failure recovery, reconnect, clarification, paging, task report, sleep/wake, pointer loss; PC widths 1280–1920; no external requests.')


if __name__ == '__main__':
    asyncio.run(verify())
