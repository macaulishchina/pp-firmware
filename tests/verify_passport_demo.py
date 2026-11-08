"""Browser acceptance for the isolated PP interaction study; never accesses real hardware."""
import asyncio
import json
import re
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
        page = await browser.new_page(viewport={'width': 1440, 'height': 1100}, timezone_id='Asia/Shanghai')
        errors, outside_requests = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: outside_requests.append(r.url) if not r.url.startswith(str(server.make_url('/'))) else None)
        await page.goto(str(server.make_url('/pp-demo/')) + 'index.html')
        ok = page.locator('#key-ok')

        async def hold():
            await ok.hover()
            await page.mouse.down()
            await page.wait_for_timeout(420)
            await expect(page.locator('#screen')).to_have_attribute('data-phase','recording')
            await page.mouse.up()
            await expect(page.locator('#screen')).to_have_attribute('data-phase','finalizing')

        async def tap():
            await ok.click()
            await page.wait_for_timeout(340)

        async def choose_menu(label):
            items = page.locator('.menu-list li')
            names = await items.all_inner_texts()
            target = next(i for i, name in enumerate(names) if name.startswith(label))
            current = await items.evaluate_all("items => items.findIndex(item => item.classList.contains('selected'))")
            for _ in range((target - current) % len(names)):
                await page.locator('#key-down').click()
            await tap()

        # Header is one shared telemetry view, with independently simulated Wi-Fi and PA.
        await expect(page.locator('#signal')).to_have_attribute('data-level','3')
        await expect(page.locator('#wifi-ssid')).to_have_count(0)
        await expect(page.locator('#battery-percent')).to_have_text('85')
        long_ssid = 'Home-Apartment-Living-Room-Guest'
        await page.locator('#wifi-name').fill(long_ssid)
        await page.locator('#wifi-strength').select_option('weak')
        await expect(page.locator('#signal')).to_have_attribute('data-level','1')
        await expect(page.locator('#signal')).to_have_attribute('aria-label',f'Wi-Fi {long_ssid}，信号弱，-82 dBm')
        await page.locator('#pa-state').select_option('offline')
        await expect(page.locator('#pa-link')).to_be_visible()
        await expect(page.locator('#signal')).to_have_attribute('data-connected','true')
        await expect(page.locator('#signal')).to_have_attribute('aria-label',f'Wi-Fi {long_ssid}，信号弱，-82 dBm')
        await page.locator('#pa-state').select_option('online')
        await expect(page.locator('#pa-link')).to_be_hidden()
        await page.locator('#battery-level').evaluate("e => { e.value=12; e.dispatchEvent(new Event('input',{bubbles:true})); }")
        await expect(page.locator('#battery-percent')).to_have_text('12')
        await expect(page.locator('#battery')).to_have_attribute('data-low','true')
        await page.locator('#clock-synced').uncheck()
        await page.wait_for_timeout(300)
        await expect(page.locator('#clock')).to_have_text('--:--')
        await page.locator('#clock-synced').check()
        await expect(page.locator('#clock')).not_to_have_text('--:--')
        await tap()
        await choose_menu('设置')
        await choose_menu('网络状态')
        await expect(page.locator('#screen-content')).to_contain_text(long_ssid)
        await expect(page.locator('#screen-content')).to_contain_text('-82 dBm')
        await expect(page.locator('#screen-content')).to_contain_text('8047')
        await page.keyboard.press('Escape')
        for width in (1280,1440,1920):
            await page.set_viewport_size({'width':width,'height':1100})
            assert await page.locator('.screen-top').evaluate('''e => {
              const r=[...e.children].map(n=>n.getBoundingClientRect());
              return r.every((item,i) => !i || r[i-1].right <= item.left)
                && r.at(-1).right <= e.getBoundingClientRect().right;
            }'''), width
        await page.set_viewport_size({'width':1440,'height':1100})
        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-header-long-ssid.png'), full_page=True)
        await page.locator('#wifi-strength').select_option('off')
        await expect(page.locator('#signal')).to_have_attribute('aria-label','Wi-Fi 未连接')
        await expect(page.locator('#signal')).to_have_attribute('data-connected','false')
        await expect(page.locator('#pa-state')).to_be_disabled()
        await page.locator('#wifi-strength').select_option('strong')
        await page.locator('#wifi-name').fill('Home Wi-Fi')
        await page.locator('#battery-level').evaluate("e => { e.value=85; e.dispatchEvent(new Event('input',{bubbles:true})); }")
        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-desktop.png'), full_page=True)
        await hold()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','processing')
        await expect(page.locator('#speech-track')).to_be_visible(timeout=10000)
        await ok.click()
        await expect(page.locator('#speech-track')).to_be_hidden()
        await tap()
        await expect(page.locator('#screen-content')).to_contain_text('操作菜单')
        await page.keyboard.press('Escape')
        await page.evaluate("window.phases=[];window.phaseObserver=new MutationObserver(()=>phases.push(document.querySelector('#screen').dataset.phase));phaseObserver.observe(document.querySelector('#screen'),{attributes:true,attributeFilter:['data-phase']})")
        await ok.dblclick(delay=90)
        await expect(page.locator('#mode-badge')).to_have_attribute('data-mode','queue')
        await expect(page.locator('#mode-badge')).to_have_attribute('aria-label','当前排队，双击 OK 切换')
        mode_text = await page.locator('#mode-badge').inner_text()
        assert not any(word in mode_text for word in ('引导','排队'))
        assert 'recording' not in await page.evaluate('phases')
        await page.evaluate('phaseObserver.disconnect()')
        await page.reload()
        await expect(page.locator('#mode-badge')).to_have_attribute('data-mode','queue')
        await expect(page.locator('.screen-identity')).to_have_count(0)
        await page.locator('#recognition-failure').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('这次没听清')
        await hold()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','processing')
        await page.locator('#pa-state').select_option('offline')
        await expect(page.locator('#screen')).to_have_attribute('data-phase','offline')
        await tap()
        await expect(page.locator('#screen-content')).to_contain_text('操作菜单')
        await page.keyboard.press('Escape')
        await page.locator('#pa-state').select_option('online')
        await expect(page.locator('#screen')).not_to_have_attribute('data-phase','offline')
        await page.locator('[data-scenario=clarify]').click()
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('你想几点提醒', timeout=10000)
        await expect(page.locator('#utterance')).to_contain_text('晚上八点')
        await hold()
        await expect(page.locator('#screen-content')).to_contain_text('已记下晚上八点', timeout=10000)
        await page.locator('[data-scenario=long]').click()
        await hold()
        await expect(page.locator('#speech-track')).to_be_visible(timeout=10000)
        await expect(page.locator('#screen-content .screen-kicker')).to_have_count(0)
        await expect(page.locator('#screen-content')).not_to_contain_text('嘟嘟')
        assert await page.locator('#screen-content').evaluate('e => e.clientHeight / e.closest(".screen").clientHeight > .70')
        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-compact-reply.png'),full_page=True)
        await page.locator('#device').screenshot(path=str(site.parent / 'private' / 'pp-demo-device-reply.png'))
        await page.locator('#key-up').click()
        await expect(page.locator('#volume-toast')).to_be_visible()
        await ok.click()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','reply',timeout=30000)
        total_pages = int((await page.locator('#page-number').inner_text()).split('/')[1])
        for _ in range(total_pages - 1): await page.locator('#key-up').click()
        await page.locator('#key-down').click()
        await expect(page.locator('#page-number')).to_contain_text(re.compile(r'2\s*/'))
        await page.locator('#key-up').click()
        for index in range(total_pages):
            for width in (1280,1440,1920):
                await page.set_viewport_size({'width':width,'height':1100})
                assert await page.locator('#screen-content').evaluate('''e => {
                  const text=e.querySelector('.screen-text').getBoundingClientRect();
                  const area=e.getBoundingClientRect();
                  return text.top >= area.top && text.bottom <= area.bottom;
                }'''), (index,width)
            if index < total_pages-1: await page.locator('#key-down').click()
        await page.set_viewport_size({'width':1440,'height':1100})
        await page.locator('[data-scenario=task]').click()
        await hold()
        await expect(page.locator('#task-complete')).to_be_enabled(timeout=10000)
        await page.locator('#task-complete').click()
        await expect(page.locator('#task-complete')).to_be_disabled()
        await ok.click()  # stop playback immediately
        await tap()  # open menu
        await tap()  # task messages is the first menu entry
        await expect(page.locator('#screen-content')).to_contain_text('电影推荐已整理好')
        await tap()  # report detail
        await expect(page.locator('#screen')).to_have_attribute('data-phase','notice')
        await expect(page.locator('#screen-content')).to_contain_text('电影推荐已整理好')
        await expect(page.locator('.task-type')).to_have_text('任务报告')
        await tap()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','notices')
        await page.locator('#key-down').click(); await tap()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','menu')
        await page.locator('#key-up').hover(); await page.mouse.down(); await page.wait_for_timeout(720); await page.mouse.up()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','idle')
        await page.wait_for_timeout(200)
        await expect(page.locator('#screen')).to_have_attribute('data-phase','idle')
        # Wake consumes one gesture; it never starts a recording.
        await page.keyboard.press('Escape')
        await tap()
        await choose_menu('设置')
        await choose_menu('休眠')
        await expect(page.locator('#screen-content')).to_contain_text('休息一下')
        await tap()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','idle')
        # Losing a held pointer discards input instead of committing it.
        await page.locator('[data-scenario=short]').click()
        await ok.hover(); await page.mouse.down(); await page.wait_for_timeout(350)
        await page.dispatch_event('#key-ok','pointercancel')
        await page.mouse.up()
        await expect(page.locator('#screen-content')).not_to_contain_text('正在听')
        await expect(page.locator('#screen')).not_to_have_attribute('data-phase','processing')
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
        await expect(page.locator('#screen-content')).to_contain_text('已整理：证件', timeout=10000)
        await page.unroute('**/scenarios.js')
        await page.reload()
        # PC keyboard shares the same hold/release behavior; key repeat cannot restart input.
        await page.locator('body').click(position={'x': 20, 'y': 120})
        await page.keyboard.down('Space')
        await page.wait_for_timeout(320)
        await expect(page.locator('#screen')).to_have_attribute('data-phase','recording')
        await page.keyboard.up('Space')
        await expect(page.locator('#screen')).to_have_attribute('data-phase','finalizing')
        await page.reload()
        for width in (1280, 1440, 1920):
            await page.set_viewport_size({'width':width,'height':1100})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        await page.set_viewport_size({'width':1440,'height':1100})
        await page.screenshot(path=str(site.parent / 'private' / 'pp-demo-desktop.png'),full_page=True)
        # Bounded image delivery is part of the same conversation, never an image browser.
        await page.locator('[data-scenario=image]').click()
        await hold()
        await expect(page.locator('#speech-track')).to_be_visible(timeout=10000)
        await ok.click()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','reply',timeout=15000)
        await page.locator('#key-down').click()
        await expect(page.locator('.reply-image img')).to_be_visible()
        await expect(page.locator('.reply-image img')).to_have_attribute('src','./color-check.svg')
        # The explicit demo shortcut avoids making the software check wait a physical minute.
        await page.locator('[data-scenario=long-input]').click()
        await ok.hover(); await page.mouse.down(); await page.wait_for_timeout(350)
        await page.evaluate("document.querySelector('#record-limit').click()")
        await page.mouse.up()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','input-review')
        await expect(page.locator('.menu-list li.selected')).to_have_text('丢弃本次输入')
        await page.locator('#key-down').click(); await page.locator('#key-down').click(); await tap()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','input-review-text')
        await page.locator('#key-down').click()
        await expect(page.locator('#page-number')).to_contain_text(re.compile(r'2\s*/'))
        await tap()
        await expect(page.locator('.menu-list li.selected')).to_have_text('丢弃本次输入')
        await tap()
        await expect(page.locator('#screen')).not_to_have_attribute('data-phase','processing')
        await page.locator('[data-scenario=short]').click()
        await page.locator('#empty-input').click()
        await hold()
        await expect(page.locator('#screen')).to_have_attribute('data-phase','idle')
        await expect(page.locator('#screen-hint')).to_have_text('未检测到内容，请重新说。')
        await expect(page.locator('#screen-content .screen-text')).to_have_count(0)
        assert not errors, errors
        assert not outside_requests, outside_requests
        await browser.close()
        print('Browser acceptance passed: hold/release, stop, menu, persistence, failure recovery, reconnect, clarification, paging, task report, sleep/wake, pointer loss; PC widths 1280–1920; no external requests.')


if __name__ == '__main__':
    asyncio.run(verify())
