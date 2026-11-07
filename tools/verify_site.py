"""Read-only LAN deployment checks. Never requests a real serial port or flashes."""
import asyncio
import argparse
import hashlib
import json
from pathlib import Path
import ssl
import tomllib
import urllib.error
import urllib.request
import zipfile
import io
from playwright.async_api import async_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
URL="https://110.0.0.82:9443"
context=ssl.create_default_context(cafile=str(ROOT/"private/tls/ca.crt"))
def get(path):
    with urllib.request.urlopen(URL+path,context=context,timeout=20) as response:
        return response.read(),response.headers

def http_checks():
    data,headers=get('/config/pp.toml')
    assert headers['Cache-Control']=='no-store'
    config=tomllib.loads(data.decode())
    assert 'PPDemo · 0.2.0' in config['supported_apps']
    for name in config['supported_apps']:
        app=config[name]
        assert app['acceptance']=='pending'
        for path,size,digest in zip(app['image']['esp32-c3']['parts'],app['image']['esp32-c3']['sizes'],app['image']['esp32-c3']['sha256'],strict=True):
            data,_=get(path)
            assert len(data)==size and hashlib.sha256(data).hexdigest()==digest,path
        data,_=get(app['download'])
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            required={'manifest.json','README.md',*(Path(p).name for p in app['image']['esp32-c3']['parts'])}
            assert required <= set(archive.namelist()) <= required|{'LICENSE.folotoy','SourceHanSansSC.LICENSE.txt'}
            if name.startswith(('PPDemo-Zh', 'PA-Terminal')):
                assert 'SourceHanSansSC.LICENSE.txt' in archive.namelist()
            assert archive.testzip() is None
    for path in ['/private/tls/ca-key.pem','/candidates/','/.git/config','/src/App.tsx','/firmware/../private/tls/server-key.pem']:
        try:get(path)
        except urllib.error.HTTPError as error:assert error.code==404,(path,error.code)
        else:raise AssertionError('Private source exposed: '+path)
    assert get('/certs/pp-firmware-ca.crt')[0]==(ROOT/'private/tls/ca.crt').read_bytes()
    return config['supported_apps']

async def browser_checks(default_app):
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        ctx=await browser.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1000},accept_downloads=True)
        page=await ctx.new_page()
        errors=[]; requests=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:requests.append(request.url))
        await page.goto(URL,wait_until='networkidle')
        await page.get_by_role('heading',name='固件目录',exact=True).wait_for()
        assert await page.locator('nav').get_by_role('button',name='连接设备',exact=True).count()==0
        assert await page.get_by_role('button',name='连接设备',exact=True).count()==1
        await page.get_by_role('heading',name='配置与使用',exact=False).wait_for()
        assert await page.get_by_role('button',name='打开 USB 配置',exact=True).is_enabled()
        assert await page.get_by_text(default_app,exact=True).count()>0
        assert await page.get_by_text('已发布 · 真机待验收',exact=True).count()==1
        assert await page.get_by_role('button',name='安装到 PP',exact=True).is_disabled()
        assert await page.evaluate('window.isSecureContext')
        assert not [u for u in requests if not u.startswith(URL) and not u.startswith('data:')],requests
        assert not [u for u in requests if u.endswith('.bin') or u.endswith('firmware.zip')]
        async with page.expect_download() as info:
            await page.get_by_role('link',name='下载刷写包').click()
        download=await info.value
        assert (await download.failure()) is None
        await page.get_by_role('combobox',name='选择固件').click()
        await page.get_by_role('option',name='PPDemo-Zh · 0.2.0',exact=True).click()
        await page.get_by_text('中文版',exact=False).first.wait_for()
        assert '/ppdemo-zh/' in await page.get_by_role('link',name='下载刷写包').get_attribute('href')
        assert await page.get_by_role('button',name='安装到 PP',exact=True).is_disabled()
        async with page.expect_download() as info:
            await page.get_by_role('link',name='下载刷写包').click()
        assert (await (await info.value).failure()) is None
        await page.get_by_role('tab',name='串口日志',exact=True).click()
        await page.get_by_text('Console Command Input',exact=True).wait_for()
        await page.get_by_role('tab',name='固件目录',exact=True).click()
        await page.wait_for_function("getComputedStyle(document.querySelector('.fade-in-down')).opacity === '1'")
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await page.screenshot(path=str(ROOT/'private/logs/website-desktop.png'),full_page=True)
        # A cancelled browser port selection must not request any firmware or start writing.
        await page.evaluate('''() => {
          window.serialRequests=0;
          navigator.serial.requestPort=() => {window.serialRequests++;return new Promise((resolve,reject)=>{window.cancelPort=()=>reject(new DOMException('Cancelled','NotFoundError'))})};
        }''')
        await page.get_by_role('button',name='连接设备',exact=True).first.click()
        await expect(page.get_by_role('button',name='连接设备',exact=True)).to_be_disabled()
        await expect(page.get_by_role('button',name='USB 配置',exact=True)).to_be_disabled()
        await expect(page.get_by_role('button',name='打开 USB 配置',exact=True)).to_be_disabled()
        await page.evaluate('cancelPort()')
        await expect(page.get_by_role('button',name='打开 USB 配置',exact=True)).to_be_enabled()
        assert await page.evaluate('window.serialRequests')==1
        assert await page.get_by_role('button',name='安装到 PP',exact=True).is_disabled()
        await page.get_by_role('button',name='打开 USB 配置',exact=True).click()
        await page.wait_for_url(URL+'/pp-setup.html')
        await page.get_by_role('heading',name='连接你的 PA',exact=True).wait_for()
        assert await page.locator('#device').inner_text()=='尚未连接'
        assert await page.evaluate('window.serialRequests') is None
        assert not errors,errors
        await browser.close()
        return {'catalog_without_device':'passed','download':'passed','tabs':'passed','single_connection_control':'passed','usb_configuration_entry':'passed','cancelled_port_no_write':'passed','javascript_errors':errors}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default=URL,help='Read-only site URL, including an isolated local preview')
    URL=parser.parse_args().url.rstrip('/')
    apps=http_checks()
    print(json.dumps(asyncio.run(browser_checks(apps[0])),ensure_ascii=False))
