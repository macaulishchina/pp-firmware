"""Focused browser checks for the PP simulator. No hardware or paid services."""
import argparse
import asyncio
import json
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright, expect


async def verify(url, synthetic_report=False):
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(ignore_https_errors=True, viewport={"width": 1350, "height": 900})
        await page.add_init_script("""(() => {
            window.recordingCues = 0;
            const start = OscillatorNode.prototype.start;
            OscillatorNode.prototype.start = function (...args) {
                window.recordingCues++;
                return start.apply(this, args);
            };
        })();""")
        base = url.rsplit("/", 1)[0] + "/"
        errors, external = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: external.append(request.url) if not request.url.startswith(base) else None)
        if synthetic_report:
            await page.route("**/lab/status.json", lambda route: route.fulfill(json={
                "schema": 1, "firmware": "0.2.1-preview.1", "revision": "0123456789abcdef",
                "updated": "2026-11-09T00:00:00+00:00", "stages": {
                    "device": {"title": "Windows 远程串口", "status": "waiting", "hint": "请唤醒 PP。"}
                }, "manual": {}, "issues": [],
            }))
        await page.goto(url, wait_until="domcontentloaded")
        screen, content = page.locator("#screen"), page.locator("#screen-content")
        ok, up, down = (page.locator(f"#key-{key}") for key in ("ok", "up", "down"))

        async def phase(expected, timeout=5000):
            await expect(screen).to_have_attribute("data-phase", expected, timeout=timeout)

        double_ms = await page.evaluate(
            "async () => (await import('./core/profile.js')).PP_PROFILE.interaction.doubleMs"
        )

        async def next_ok():
            # A second OK on another page must be a new gesture, outside the double-click window.
            await page.wait_for_timeout(double_ms + 20)
            await ok.click()

        async def open_panel(name):
            await page.locator(f'[data-panel="{name}"]').click()
            await expect(page.locator(f"#panel-{name}")).to_be_visible()

        async def hold():
            await ok.hover()
            await page.mouse.down()
            await phase("recording")
            await expect(content).to_contain_text("你说的")
            await page.mouse.up()
            await phase("finalizing")

        async def home(expected="idle"):
            await up.hover()
            await page.mouse.down()
            await phase(expected)
            await page.mouse.up()

        await phase("idle")
        assert await page.locator("#display").evaluate("e => e.width === 240 && e.height === 320")
        assert await page.locator("#display").evaluate("""e => {
          const pixel = (x,y) => Array.from(e.getContext('2d').getImageData(x,y,1,1).data).join(',');
          return pixel(0,0) === '23,41,35,255' && pixel(12,29) === '52,68,60,255';
        }""")
        await expect(page.locator("#panel-conversation")).to_be_visible()
        await expect(page.locator("#panel-setup")).to_be_hidden()
        await expect(page.locator("#panel-debug")).to_be_hidden()
        # Only the owning pointer can release this simulated ADC key. Neither
        # a second pointer nor a keyboard long-UP may interrupt the recording.
        await ok.evaluate("""el => el.addEventListener('pointerdown',
            e => { el.testPointerId = e.pointerId; }, { once: true })""")
        await ok.hover()
        await page.mouse.down()
        await phase("recording")
        await ok.evaluate("""el => {
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                el.dispatchEvent(new PointerEvent(type, { pointerId: el.testPointerId + 1 }));
            }
        }""")
        await page.keyboard.down("ArrowUp")
        await page.wait_for_timeout(750)  # long-UP would otherwise navigate home
        await phase("recording")
        await page.keyboard.up("ArrowUp")
        await ok.evaluate("el => el.releasePointerCapture(el.testPointerId)")
        await page.mouse.move(0, 0)  # deliver lostpointercapture before the real release
        await phase("idle")
        await page.mouse.up()

        # A held keyboard direction excludes pointer and assistive clicks. An
        # abandoned OK gesture must not submit text when its stale keyup arrives.
        await page.keyboard.down("ArrowDown")
        await ok.hover()
        await page.mouse.down()
        assert not await ok.evaluate("el => el.classList.contains('pressed')")
        await page.mouse.up()
        await ok.evaluate("el => el.click()")
        await page.keyboard.up("ArrowDown")
        await page.keyboard.down("Space")
        await phase("recording")
        await page.evaluate("window.dispatchEvent(new Event('blur'))")
        await phase("idle")
        await page.keyboard.up("Space")
        await ok.evaluate("el => el.click()")  # assistive activation when the key is free
        await phase("menu")
        await home()

        await ok.dblclick()
        await expect(screen).to_have_attribute("data-mode", "queue")
        await phase("idle")
        await page.reload()
        await expect(screen).to_have_attribute("data-mode", "queue")
        await ok.click()
        await phase("menu")
        await expect(screen).to_have_attribute("data-menu-layout", "grid")
        await expect(screen).to_have_attribute("data-selected", "任务消息")
        await expect(content).to_contain_text("任务消息\n声音与屏幕\n网络与配对\n电源与待机\n返回主页")
        await down.click()
        await ok.click()
        await phase("sound")
        await expect(screen).to_have_attribute("data-menu-layout", "list")
        await next_ok()
        await phase("volume")
        await expect(content).to_contain_text("音量 45")
        await next_ok()
        await phase("sound")
        await down.click()
        await ok.click()
        await phase("brightness")
        await expect(content).to_contain_text("65%")
        await down.click()
        await expect(content).to_contain_text("60%")
        await home()
        await ok.click()
        await phase("menu")
        await expect(screen).to_have_attribute("data-selected", "任务消息")
        await down.click()
        await ok.click()
        await phase("sound")
        await expect(content).to_contain_text("屏幕亮度 · 65%")
        await down.click()
        await ok.click()
        await phase("brightness")
        await down.click()
        await next_ok()
        await phase("sound")
        await expect(screen).to_have_attribute("data-selected", "屏幕亮度 · 60%")
        await page.reload()
        await phase("idle")
        await ok.click()
        await phase("menu")
        await down.click()
        await ok.click()
        await phase("sound")
        await expect(content).to_contain_text("屏幕亮度 · 60%")
        await down.click()
        await ok.click()
        await phase("brightness")
        await up.click()
        await next_ok()
        await phase("sound")
        await expect(screen).to_have_attribute("data-selected", "屏幕亮度 · 65%")
        await home()

        cues_before = await page.evaluate("window.recordingCues")
        await hold()
        assert await page.evaluate("window.recordingCues") == cues_before + 2
        await phase("processing")
        await expect(content).to_contain_text("等待回复")
        active_dot = """() => {
          const ctx = document.getElementById('display').getContext('2d');
          return [88, 97, 106].findIndex(x => ctx.getImageData(x, 275, 1, 1).data[0] === 182);
        }"""
        first_dot = await page.evaluate(active_dot)
        assert first_dot >= 0
        await page.wait_for_function(f"""first => {{
          const current = ({active_dot})();
          return current >= 0 && current !== first;
        }}""", arg=first_dot, timeout=1200)
        await phase("responding")
        assert await page.evaluate(active_dot) == -1
        await expect(screen).to_have_attribute("data-playing", "true", timeout=10000)
        await up.click()
        await expect(content).to_contain_text("音量 50")
        await ok.click()
        await expect(screen).to_have_attribute("data-playing", "false")
        await phase("reply", 12000)
        await expect(content).to_contain_text("当然可以")
        await expect(screen).to_have_attribute("data-volume-feedback", "false")

        await open_panel("debug")
        await page.locator("#empty-input").click()
        await hold()
        await phase("idle")
        await expect(content).to_contain_text("未检测到内容，请重新说。")
        await page.locator("#network-toggle").click()
        await phase("offline")
        await up.click()
        await phase("history")
        await expect(content).to_contain_text("本地缓存")
        await up.click()
        await expect(content).to_contain_text("今天适合出去散步吗？")
        await page.keyboard.down("ArrowDown")
        await expect(content).to_contain_text("当然可以")
        await page.keyboard.up("ArrowDown")
        await phase("history")
        await expect(content).to_contain_text("本地缓存")
        await home("offline")
        await ok.hover()
        await page.mouse.down()
        await phase("wifi-trying")
        await page.mouse.up()
        await expect(content).not_to_contain_text("Wi-Fi")
        await expect(page.locator("#stage-status")).to_be_empty()
        wifi_brightness = """() => {
          const ctx = document.getElementById('display').getContext('2d');
          return Math.max(...ctx.getImageData(172, 8, 20, 17).data.filter((_, i) => i % 4 === 0));
        }"""
        initial_wifi = await page.evaluate(wifi_brightness)
        await page.wait_for_function(f"""initial =>
          document.getElementById('screen').dataset.phase === 'wifi-trying' &&
          ({wifi_brightness})() !== initial
        """, arg=initial_wifi, timeout=700)
        await expect(page.locator("#network-toggle")).to_have_text("断开 Wi-Fi")
        await phase("idle")

        await open_panel("conversation")
        await page.locator("#scenario-picker").select_option("image")
        await hold()
        await expect(screen).to_have_attribute("data-playing", "true", timeout=10000)
        await ok.click()
        await phase("reply", 12000)
        await down.click()
        await expect(screen).to_have_attribute("data-view", "image")
        await expect(content).to_contain_text("160 × 96 合成色卡")
        await up.click()
        await expect(screen).to_have_attribute("data-view", "reply")
        await up.click()
        await phase("history")
        await expect(content).to_contain_text("显示一张测试图片")
        await up.click()
        await expect(content).to_contain_text("当然可以")
        await down.hover()
        await page.mouse.down()
        await expect(content).to_contain_text("这是一张合成色卡")
        await page.mouse.up()
        await expect(screen).to_have_attribute("data-view", "reply")
        await expect(content).to_contain_text("这是一张合成色卡")

        await page.locator("#scenario-picker").select_option("long-input")
        await ok.hover()
        await page.mouse.down()
        await phase("recording")
        # The real button is held while the workbench injects its limit condition.
        await page.locator("#record-limit").evaluate("e => e.click()")
        await page.mouse.up()
        await phase("input-review")
        await expect(content).to_contain_text("丢弃本次输入\n发送已识别文字\n查看完整转写")
        await up.click()
        await ok.click()
        await phase("input-review-text")
        await down.click()
        await expect(content).not_to_contain_text("我想安排一个轻松一点的周末")
        await ok.click()
        await phase("input-review")
        await next_ok()
        await expect(content).to_contain_text("已丢弃，未执行")

        await page.locator("#scenario-picker").select_option("task")
        await hold()
        await expect(page.locator("#task-complete")).to_be_visible(timeout=12000)
        await page.locator("#task-complete").click()
        if await screen.get_attribute("data-playing") == "true":
            await ok.click()
            await page.wait_for_timeout(320)
        await ok.click()
        await phase("menu")
        await ok.click()
        await phase("notices")
        await next_ok()
        await phase("notice")
        await expect(content).to_contain_text("任务报告 · 电影推荐已整理好")
        await ok.click()
        await phase("notices")
        await home()

        async def select_from_start(index):
            for _ in range(index):
                await down.click()
            await next_ok()

        async def open_connectivity():
            await next_ok()
            await phase("menu")
            await expect(screen).to_have_attribute("data-selected", "任务消息")
            await select_from_start(2)
            await phase("connectivity")

        async def open_maintenance():
            await open_connectivity()
            await select_from_start(3)
            await phase("maintenance")

        await open_panel("setup")
        await page.locator("#setup-first").click()
        await phase("hotspot")
        await expect(content).to_contain_text("http://192.168.4.1")
        await ok.dblclick()
        await phase("menu")
        await expect(screen).to_have_attribute("data-selected", "任务消息")
        await select_from_start(2)
        await phase("connectivity")
        await next_ok()
        await phase("status")
        await expect(content).to_contain_text("信号 未连接")
        await next_ok()
        await phase("connectivity")
        await next_ok()
        await phase("status")
        await home("hotspot")
        await expect(page.locator("#setup-wifi")).to_be_visible()
        await expect(page.locator("#setup-pair")).to_be_hidden()
        await expect(page.locator("#setup-wifi input[type=url], #setup-wifi textarea")).to_have_count(0)
        await page.locator("#setup-fail").check()
        await page.locator("#setup-connect").click()
        await phase("unreachable")

        await open_connectivity()
        await expect(content).not_to_contain_text("恢复出厂设置")
        await select_from_start(2)
        await phase("device-reset")
        await expect(content).to_contain_text("设置 Wi-Fi？")
        await next_ok()
        await phase("connectivity")
        await home("unreachable")
        await open_connectivity()
        await select_from_start(2)
        await down.click()
        await next_ok()
        await phase("hotspot")
        await page.locator("#setup-fail").uncheck()
        await page.locator("#setup-connect").click()
        await phase("pairing")
        await expect(page.locator("#setup-wifi")).to_be_hidden()
        await expect(page.locator("#setup-pair")).to_be_visible()
        code = (await content.text_content()).splitlines()[1]
        assert len(code) == 8 and code.isdecimal()
        await page.locator("#setup-code").fill(code)
        await page.locator("#setup-bind").click()
        await phase("idle")
        await next_ok()
        await phase("menu")
        await select_from_start(3)
        await phase("power")
        await expect(content).to_contain_text("熄屏保持 Wi-Fi · 开")
        await select_from_start(2)
        await phase("sleeping")
        await open_panel("debug")
        await expect(page.locator("#network-toggle")).to_have_text("断开 Wi-Fi")
        await expect(page.locator("#pa-state")).to_have_value("offline")
        await ok.click()
        await phase("idle")
        await expect(page.locator("#pa-state")).to_have_value("online")
        await open_panel("setup")
        await expect(page.locator("#cloud-settings")).to_be_visible()
        assert not await page.locator("#cloud-settings").evaluate("e => e.open")
        await page.locator("#cloud-settings > summary").click()
        await page.locator("#setup-revoke").click()
        await phase("revoked")
        await down.click()
        await phase("device-reset")
        await ok.click()
        await phase("revoked")
        await open_connectivity()
        await select_from_start(1)
        await phase("revoked")
        await open_maintenance()
        await expect(content).to_contain_text("同步 PA 设置")
        await expect(content).to_contain_text("从 PA 获取设备设置")
        await expect(content).to_contain_text("更换 PA 配对")
        await expect(content).to_contain_text("恢复出厂设置")
        await select_from_start(2)
        await phase("about")
        firmware = await page.evaluate("async () => (await (await fetch('lab/parity.json')).json()).version")
        for label in ("关于设备", "FoloToy AI Passport", "芯片 ESP32-C3", "闪存 8MB", f"固件 {firmware}", "协议 2"):
            await expect(content).to_contain_text(label)
        text_before = await content.text_content()
        await down.click()
        await up.click()
        assert await content.text_content() == text_before
        await next_ok()
        await phase("maintenance")
        await expect(screen).to_have_attribute("data-selected", "关于设备")
        await up.click()
        await next_ok()
        await phase("device-reset")
        await expect(content).to_contain_text("保留 Wi-Fi")
        await next_ok()  # Cancel returns to the same row.
        await phase("maintenance")
        await expect(screen).to_have_attribute("data-selected", "更换 PA 配对")
        await next_ok()
        await down.click()
        await next_ok()
        await phase("pairing")
        code = (await content.text_content()).splitlines()[1]
        await open_connectivity()
        await page.locator("#setup-code").fill(code)
        await page.locator("#setup-bind").click()
        await phase("connectivity")  # Successful handshake preserves the local page.
        await home()

        standby_ms = await page.evaluate(
            "async () => (await import('./core/profile.js')).PP_PROFILE.interaction.standbyHoldMs"
        )
        await next_ok()
        await phase("menu")
        await up.hover()
        await page.mouse.down()
        await phase("idle")
        await expect(content).not_to_contain_text("继续长按将休眠")
        await page.wait_for_timeout(standby_ms + 50)
        await phase("idle")
        await page.mouse.up()
        await phase("idle")

        await page.keyboard.down("ArrowUp")
        await page.wait_for_timeout(850)
        await page.keyboard.up("ArrowUp")
        await phase("idle")
        await page.keyboard.down("ArrowUp")
        await expect(content).to_contain_text("继续长按将休眠")
        await page.keyboard.up("ArrowUp")
        await expect(content).not_to_contain_text("继续长按将休眠")
        await phase("idle")

        await page.keyboard.down("ArrowUp")
        await expect(content).to_contain_text("继续长按将休眠")
        await page.evaluate("window.dispatchEvent(new Event('blur'))")
        await page.keyboard.up("ArrowUp")
        await page.wait_for_timeout(standby_ms)
        await phase("idle")

        await up.hover()
        await page.mouse.down()
        await expect(content).to_contain_text("继续长按将休眠")
        await phase("sleeping")
        await page.mouse.up()
        await phase("sleeping")
        await open_panel("debug")
        await expect(page.locator("#network-toggle")).to_have_text("断开 Wi-Fi")
        await expect(page.locator("#pa-state")).to_have_value("offline")
        await up.click()
        await phase("idle")
        await expect(page.locator("#pa-state")).to_have_value("online")
        status = page.locator("#panel-debug").get_by_text("设备状态", exact=True)
        slider = page.locator("#battery-level")
        if not await slider.is_visible():
            await status.click()
        display = page.locator("#display")

        async def battery_pixel(x, y):
            return await display.evaluate("""(canvas, [x, y]) =>
                [...canvas.getContext('2d').getImageData(x,y,1,1).data].slice(0,3)""", [x, y])

        await slider.fill("100")
        assert await battery_pixel(220, 10) == [220, 232, 218]
        assert await battery_pixel(226, 15) == [113, 132, 121]
        assert await battery_pixel(225, 15) == [23, 41, 35]
        # Read the actual rendered digits between the rounded ends of the battery.
        assert await display.evaluate("""canvas => {
            const { data, width, height } = canvas.getContext('2d').getImageData(203, 9, 19, 13);
            const rows = Array.from({ length: height }, (_, y) => y).filter(y =>
                Array.from({ length: width }, (_, x) => x).some(x => data[4 * (y * width + x)] < 130));
            return rows.length === 9 && rows[0] === 2 && rows.at(-1) === 10;
        }""")
        await slider.fill("50")
        assert await battery_pixel(211, 10) == [220, 232, 218]
        assert await battery_pixel(212, 10) == [70, 89, 79]
        await slider.fill("12")
        assert await battery_pixel(201, 15) == [237, 129, 122]
        await slider.fill("0")
        assert await battery_pixel(201, 15) == [70, 89, 79]
        await slider.fill("85")
        await open_panel("lab")
        await expect(page.locator("#lab-meta")).to_contain_text("0.2.1-preview.1" if synthetic_report else "·")
        await expect(page.locator("#lab-cases")).to_contain_text("真实收音与播报")
        await page.locator("#lab-case").select_option("voice-playback")
        await page.locator("#lab-note").fill("测试反馈：松开后仍显示收音")
        async with page.expect_download() as result:
            await page.locator("#lab-export").click()
        download = await result.value
        payload = json.loads((await download.path()).read_text())
        assert payload["case"] == "voice-playback" and payload["result"] == "issue"
        assert payload["note"] == "测试反馈：松开后仍显示收音"
        if synthetic_report:
            assert payload["revision"] == "0123456789abcdef"
        assert not errors, errors
        assert not external, external
        await browser.close()
        print("PP browser flows passed: native screen, controls, speech, history, image, review, pairing, feedback export")


async def main(url=None):
    if url:
        await verify(url)
        return
    app = web.Application()
    app.router.add_static("/", Path(__file__).resolve().parents[1] / "public")
    async with TestServer(app) as server:
        await verify(str(server.make_url("/pp-demo/index.html")), synthetic_report=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    asyncio.run(main(parser.parse_args().url))
