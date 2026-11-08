# PP 固件中心（Dell 本地部署）

外网入口：**https://47.109.34.254:9443/**（FRP TCP 转发）。局域网入口：**https://110.0.0.82:9443/**。这是本地自用的静态固件展示、选择、下载和 USB 安装网站。
已上架 PA-Terminal 0.2.1-preview.1 预览版、0.2.0 日常使用版及历史版本，
另保留 PPDemo 0.2.0 英文版和 PPDemo-Zh 0.2.0 中文版。
0.2 系列使用协议 2，支持中文语音、独立会话、任务消息和有界 Flash 缓存；
预览版用于安装体验和问题反馈，不代表已完成全部真机及长期稳定性验收。
固件站本身不运行 Agent。PP 业务直接连接 PA 的 HTTP/WS 8047，HTTPS 9443 只用于固件分发。
没有管理员上传后台、在线编译或 OTA；网站部署或添加固件不重启 PA。

基于 ESP Launchpad 上游提交 `804b308c28fe3e136e9c2b850c8534da374fa9e8`，保留 Apache-2.0
许可证。底层串口、esptool 连接及刷写复用上游，当前依赖版本由 package-lock.json 固定。
项目仓库：`git@github.com:macaulishchina/pp-firmware.git`（`origin`）。
`upstream` 保留 ESP Launchpad 官方仓库作为来源；项目修改推送至个人仓库。

## 目录和唯一配置来源

- `config/pp.toml`：唯一展示清单；本地发布命令生成，Nginx 直接读取，更新无需重编前端。
- `config/readmes/`：发布用的公开使用说明。
- `../candidates/`：私有构建候选及调试证据，不对外服务。
- `../releases/<app>/<version>/`：不可变的公开镜像、说明、清单和公开刷写包。
- `deploy/`：Docker Compose、Nginx；`dist/` 是生成的前端。
- `../private/`：证书及验证记录，不进入 Git 或公开目录。CA 私钥不挂入网站容器。

## 构建和部署

需要 Node >=20.19、npm、Docker Compose，以及 Python 3.11+（发布工具仅使用标准库）。

```sh
npm ci
npm run build
bash tools/create_tls.sh
docker compose -p pp-firmware -f deploy/compose.yaml run --rm --no-deps website -t
docker compose -p pp-firmware -f deploy/compose.yaml up -d
```

镜像已固定 digest；新机器缺少镜像时，先 `docker pull` compose.yaml 中的完整镜像地址。
容器以 uid/gid 101 运行，文件系统和挂载只读，丢弃 capabilities。当前 Dell 的 Snap Docker
环境中，额外设置 no-new-privileges 会导致 nginx exec 被拒；已单独验证启动组合，未修改
宿主全局安全配置。TLS 私钥需让 gid 101 可读；当前操作者属于该组。

仅前端修改：`npm run build` 后刷新页面即可。部署配置或证书变化才重建该站点容器。
首次或证书更新后，使用 `curl --cacert ../private/tls/ca.crt https://110.0.0.82:9443/healthz` 核对。

固件目录按“选择固件 → USB 安装 → 配网与配对”组织。连接／断开集中在安装区；
配网说明是独立静态页，不读写串口，安装中也可查看。
PA-Terminal 0.2.0 由设备热点完成初始 Wi-Fi 与 PA 地址设置，联网后显示八位配对码，
在 PA 后台绑定；后续配置由 PA 后台云控。没有 USB 配网或配对文件导入。
PPDemo 系列直接按设备菜单使用。网站的浏览器刷写需要可信 HTTPS，普通 PP 业务 HTTP/WS 不需要 CA。

## PP 交互演示

独立页面：`/pp-demo/`，源码位于 `public/pp-demo/`。固定维护为可复用的 PC 演示底座，
不做移动端适配；开发约定见 [PP 演示底座](docs/pp-demo-framework.md)。用于确认屏幕布局、按键、
引导／排队、短播报／长文本、澄清、任务消息和异常恢复体验，全部为浏览器模拟。
不申请麦克风或串口、不连接 PA、不发起模型或语音调用；音量与播报仅模拟呈现。
只在浏览器保存演示用的输入模式、音量和保持在线偏好，不保存对话或凭据。
硬件外观图来自 FoloToy AI Passport，随页保留 MIT 许可。

验证：

```sh
node --test tests/passport-demo.test.mjs
/home/macaulish/workspace/dell-voice-assistant/.venv/bin/python tests/verify_passport_demo.py
```

演示源码直接挂载到网站 `/pp-demo/`，该路径不缓存。修改 `public/pp-demo/` 后刷新即可，
不用构建、复制到 dist、运行验收或重启服务。标准前端构建仍包含静态演示，便于普通打包。
日常需求讨论优先直接预览，只有明确要求时才进行测试、提交或发布整理。

## Windows 信任本地 CA

2026-11-07 起本站复制使用 GoldenNest 的服务器证书和公开 CA，证书涵盖公网
`47.109.34.254` 与局域网 `110.0.0.82`，有效期至 2036-02-10。
证书来自 `/home/macaulish/workspace/GoldenNest/ssl/{cert.pem,key.pem,ca.pem}`，分别复制至
`../private/tls/{server.crt,server-key.pem,ca.crt}`。只复制服务器私钥，不复制 CA 签名私钥，
不修改 GoldenNest 服务。副本不会自动同步；GoldenNest 续期后应重新复制这三个文件并重建本站容器。

电脑若已经信任 GoldenNest Local CA，无需再次导入。否则 Windows 浏览器需要信任公开 CA：

1. 将 `../private/tls/ca.crt` 下载到自己的 Windows；只导出证书，不导出任何私钥。
2. 导入“当前用户 → 受信任的根证书颁发机构”。可双击证书安装，或在 PowerShell 执行：

```powershell
Import-Certificate -FilePath "$env:USERPROFILE\Downloads\pp-firmware-ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

3. 用 Chrome 或 Edge 重新打开网址，确认没有证书警告，再连接 PP。

证书仅供自己的电脑信任。`tools/create_tls.sh` 默认检查并保留已有证书；当前使用导入证书，
不能用本站原有 CA 私钥重签，`--renew` 会明确拒绝不匹配的签名私钥。续期由 GoldenNest 管理，
本站复制更新。若将来恢复独立 CA，需由操作者明确配置相匹配的 CA 与签名密钥。

## 添加／发布固件

候选清单格式沿用固件打包工具的 manifest.json，必须包含真实镜像大小和 SHA256。
首期发布器接受 PP 的 ESP32-C3 / 8 MB / bootloader+partition+factory 三段布局，不发布 NVS。

```sh
python3 tools/publish.py \
  ../candidates/ppdemo/0.2.0/8f8bd2048798958a81ebe12317b9404dae726d522d846e1c89f384f5deae1ba1 \
  --id ppdemo \
  --description 'PP 独立硬件体验与质检：屏幕、按键、录放音、电池、Wi-Fi、蓝牙、存储及休眠唤醒。已通过编译与镜像校验，真机待验收。' \
  --readme config/readmes/ppdemo.md
```

命令锁定并校验候选、暂存完整公开目录，再原子更新 TOML。已发布版本不能覆盖为另一组镜像；
同一候选重复发布幂等。若目录落盘后清单写入失败，重跑同一命令可恢复登记。
公开 ZIP 只含镜像、清单和说明，不复制候选的 ELF、MAP、本机 sdkconfig 或其他文件。

## 本地适配与已验证范围

### PA-Terminal 0.2.0 配置入口（待正式发布）

`/pp-setup.html` 改为热点配网、8047 业务地址及八位码配对说明。
旧 USB 配置脚本和表单已删除；不会收集 Wi-Fi 密码、PA 管理员授权或配对文件。
当前公开 0.1.x 镜像不等于 0.2.0 已发布；新固件完成实际硬件验收后再更新公开目录。

PA-Terminal 构建候选位于 `../candidates/pa-terminal/<版本>/<应用 SHA256>/`。
仅验证前端时用 `npx vite build --outDir ../candidates/site-preview`，不能覆盖线上 dist。
PC 验收可对隔离站点运行 `python tools/verify_site.py --url <本机预览地址>`；
串口选择被模拟为取消，不连接设备、不自动刷写。

本次已执行的发布命令（同一镜像重复执行幂等）：

```sh
python3 tools/publish.py \
  ../candidates/pa-terminal/0.1.1/274478b632ec7742a92fa68666cc33e8f6a361f21ce15baef23eb32bb7ca66bc \
  --id pa-terminal \
  --description '修复 TLS 握手内存不足；已通过 PP 真机连接、断线恢复和串口边界验证，语音体验待验收。' \
  --readme config/readmes/pa-terminal-0.1.1.md
```

### 固件站原有能力

- 默认展示本地清单，仅保留固件目录、串口日志及设置入口；无外部分析脚本。
- 发布元数据补充版本、设备、验收状态、下载和逐镜像的大小／SHA256。
- 全部下载完成并校验后才开始写入；按扇区检查重叠；不整片擦除。
- 复用 esptool-js 写入后的 MD5 验证。重启读取串口在后台运行，完成状态不等待无限日志流。
- 未连接／不兼容时禁止安装；用户确认后才写入，失败不自动重做。
- 镜像校验、发布工具、网页无设备浏览／下载／选择／取消端口、HTTPS 与私有路径隔离检查通过。
- **Windows 实机串口、真实刷写、断电恢复和 PP 硬件测试未执行。** 浏览器自动检查使用独立
  Chromium，忽略测试环境的证书错误；Windows 仍需按上文导入 CA。

```sh
node --test tests/firmware.test.mjs
python3 tests/test_publish.py
npm run build
# 浏览器验收使用已经安装 Playwright 的现有开发环境，不给网站增加运行时 Python 依赖：
/home/macaulish/workspace/dell-voice-assistant/.venv/bin/python tools/verify_site.py
```
