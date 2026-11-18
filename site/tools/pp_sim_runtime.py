"""Run PassportSim's pinned WASM worker in headless Chromium."""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import hashlib
import re
from time import monotonic

from aiohttp import web
from playwright.async_api import async_playwright

from pp_sim import ENGINE, WEB


@asynccontextmanager
async def run_site(app, site, *args, socket_mode=None):
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=5)
    await runner.setup()
    try:
        listener = site(runner, *args)
        await listener.start()
        if socket_mode is not None:
            args[0].chmod(socket_mode)
        yield listener
    finally:
        await runner.cleanup()


class Machine:
    def __init__(self, context, page, meta, boot_ms):
        self.context = context
        self.page = page
        self.meta = meta
        self.boot_ms = boot_ms

    async def invoke(self, method, *args):
        return await self.page.evaluate(
            "([method, args]) => globalThis.passport[method](...args)", [method, args],
        )

    async def close(self):
        await self.context.close()


class Runtime:
    def __init__(self, browser, address):
        self.browser = browser
        self.address = address

    async def boot(self, meta, flash, elf):
        started = monotonic()
        context = await self.browser.new_context(service_workers="block")
        image = flash + elf

        async def route(request):
            nonlocal image
            url = request.request.url
            if url == f"{self.address}/boot-data" and image is not None:
                content, image = image, None
                await request.fulfill(body=content, content_type="application/octet-stream")
            elif url.startswith(f"{self.address}/"):
                await request.continue_()
            else:
                await request.abort()

        try:
            page = await context.new_page()
            await context.route("**/*", route)
            await page.goto(self.address, wait_until="load")
            await page.evaluate("meta => globalThis.bootPassport(meta)", meta)
            return Machine(context, page, meta, round((monotonic() - started) * 1000))
        except BaseException:
            await context.close()
            raise


@web.middleware
async def isolation(request, handler):
    response = await handler(request)
    response.headers.update({
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
    })
    return response


def runtime_assets():
    app = web.Application(middlewares=[isolation])

    async def index(_):
        return web.Response(text='<script type="module" src="/runtime.js"></script>', content_type="text/html")

    async def script(request):
        return web.FileResponse(WEB / request.match_info["name"], headers={"Content-Type": "text/javascript"})

    async def engine(request):
        name = request.match_info["name"]
        fingerprint = request.match_info["fingerprint"]
        if not re.fullmatch(r"[a-f0-9]{64}-[a-f0-9]{64}", fingerprint):
            raise web.HTTPNotFound()
        worker_hash, wasm_hash = fingerprint.split("-")
        data = (ENGINE / name).read_bytes()
        expected = wasm_hash if name.endswith(".wasm") else worker_hash
        if hashlib.sha256(data).hexdigest() != expected:
            raise web.HTTPConflict(text="PassportSim changed during boot")
        kind = "application/wasm" if name.endswith(".wasm") else "text/javascript"
        return web.Response(body=data, content_type=kind)

    app.router.add_get("/", index)
    app.router.add_get(r"/{name:engine\.js|runtime\.js}", script)
    app.router.add_get(r"/engine/{fingerprint}/{name:worker\.js|pemu_wasm\.wasm}", engine)
    return app


@asynccontextmanager
async def runtime() -> AsyncIterator[Runtime]:
    async with run_site(runtime_assets(), web.TCPSite, "127.0.0.1", 0) as listener:
        port = listener.name.rsplit(":", 1)[1]
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch()
            try:
                yield Runtime(browser, f"http://127.0.0.1:{port}")
            finally:
                await browser.close()
