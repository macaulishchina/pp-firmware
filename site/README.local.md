# PP 固件中心（Dell 本地部署）

外网入口：**https://47.109.34.254:9443/**（FRP TCP 转发）。局域网入口：**https://110.0.0.82:9443/**。这是本地自用的静态固件展示、选择、下载和 USB 安装网站。
PA-Terminal 公开目录默认提供正式版 0.2.1，也可选择之前的 0.2.1-preview.33，
另保留 PPDemo 0.2.0 英文版和 PPDemo-Zh 0.2.0 中文版。
0.2 系列使用协议 2，支持中文语音、独立会话、任务消息和有界 Flash 缓存；
预览版用于安装体验和问题反馈，不代表已完成全部真机及长期稳定性验收。
固件站本身不运行 Agent。PP 业务直接连接 PA 的 HTTP/WS 8047，HTTPS 9443 只用于固件分发。
没有管理员上传后台、在线编译或 OTA；网站部署或添加固件不重启 PA。

基于 ESP Launchpad 上游提交 `804b308c28fe3e136e9c2b850c8534da374fa9e8`，保留 Apache-2.0
许可证。底层串口、esptool 连接及刷写复用上游，当前依赖版本由 package-lock.json 固定。
项目仓库为 `git@github.com:macaulishchina/pp-firmware.git`（`origin`），本机 Git 根目录是 `pp-firmware/`。
`upstream` 保留 ESP Launchpad 官方仓库作为来源；项目修改推送至个人仓库。

## 目录和唯一配置来源

- `config/pp.toml`：唯一展示清单；本地发布命令生成，Nginx 直接读取，更新无需重编前端。
- `config/readmes/`：发布用的公开使用说明。
- `../candidates/`：私有构建候选及调试证据，不对外服务。
- `../releases/<app>/<version>/`：发布机本地提供的镜像、说明和刷写包，各版本的发布内容固定。Git 保存展示清单和发布说明；新部署主机需从经校验的候选包通过发布工具恢复对应版本。
- `deploy/`：Docker Compose、Nginx；`dist/` 是生成的前端。
- `../private/`：证书及验证记录，不进入 Git 或公开目录。CA 私钥不挂入网站容器。

- `../upstream/`：FoloToy 官方固件参考和 PassportSim 源码，由根仓库的 Git 子模块管理。
- `../toolchain/`：ESP-IDF 5.5.3。
- `../runtime/passportsim/`：从 PassportSim 源码构建的网页和 WASM，挂载到 `/pp-sim/`。

## 构建和部署

在 `site/` 中执行。需要 Node >=20.19、npm、Docker Compose，以及 Python 3.11+（发布工具仅使用标准库）。

```sh
npm ci
npm run build
printf 'SITE_TLS_DIR=%s\n' "$HOME/.local/share/site-tls/live" > deploy/.env
mkdir -p ../runtime/passportsim ../runtime/passportsim-service
docker compose -p pp-firmware -f deploy/compose.yaml run --rm --no-deps website -t
docker compose -p pp-firmware -f deploy/compose.yaml up -d
```

镜像已固定 digest；新机器缺少镜像时，先 `docker pull` compose.yaml 中的完整镜像地址。
容器以 uid/gid 101 运行，文件系统和挂载只读，丢弃 capabilities。当前 Dell 的 Snap Docker
环境中，额外设置 no-new-privileges 会导致 nginx exec 被拒；已单独验证启动组合，未修改
宿主全局安全配置。TLS 私钥需让 gid 101 可读；当前操作者属于该组。

仅前端修改时，执行 `npm run build` 后刷新页面。修改容器挂载时用 Compose 重建站点容器。

Compose 通过 `deploy/.env` 或 shell 中的 `SITE_TLS_DIR` 只读挂载主机证书目录。Dell 使用
`~/.local/share/site-tls/live` 的绝对路径。目录包含 `cert.pem`、`key.pem` 和公开 CA `ca.pem`。
首次没有可复用的站点证书时，可在运行 Compose 之前执行 `bash tools/create_tls.sh` 创建。
容器以 GID 101 读取目录和服务器私钥，CA 签名私钥保存在同级 `issuer/` 目录。
自定义目录时，通过 `--release-profile` 选用包含对应 `ca_file` 的固件构建配置。

续期时执行 `bash tools/create_tls.sh --renew`，然后在 `site/` 执行
`docker compose -p pp-firmware -f deploy/compose.yaml exec website nginx -s reload`。
同主机上的 GoldenNest 网关也 reload，PA 重启服务以载入证书。
使用 `curl --cacert ~/.local/share/site-tls/live/ca.pem https://110.0.0.82:9443/healthz` 核对。

`/pp-sim/` 读取 `../runtime/passportsim/`。首次安装可从已初始化的
`../upstream/passportsim/` 构建。该子模块锁定上游提交，先在干净的子模块上应用本站维护的补丁：

```sh
git -C ../upstream/passportsim am "$PWD/../upstream/patches/passportsim/"*.patch
```

已经应用的源码可以直接构建。补丁包含 PA-Terminal 所需的虚拟 Wi-Fi、TCP 和按键适配。
它将模拟器快照格式升为 29。格式 28 的快照仍由旧引擎使用，新引擎需从固件重新开会话。

在子模块根目录使用固定 Rust 工具链执行
`cargo build --locked -p pemu-wasm --lib --target wasm32-unknown-unknown --profile wasm-release`，
在 `web/` 中使用 `.bun-version` 指定的 Bun 运行 `bun install --frozen-lockfile` 和 `bun run build`。
将 `web/dist/`、构建出的 `pemu_wasm.wasm` 及随附许可证安装到该运行目录。
内置 FoloToy 演示使用 PassportSim 发布包里的 `official.pebundle` 和配套许可。

安装依赖后，在 `site/` 执行 `python3 tools/pp_sim_web.py --bun /path/to/bun`，将会话入口叠加到
上游构建。源码在本站仓库内；浏览器本地模式由原版网页直接运行。共享运行时复用 PersonalAgent
的 Playwright 与 aiohttp 环境，只需安装 Chromium 和运行时依赖，无需模型授权。

在默认 Dell 项目路径下，将 `deploy/pp-sim-sessions.service` 安装到 `~/.config/systemd/user/`，
执行 `systemctl --user daemon-reload` 与 `systemctl --user enable --now pp-sim-sessions.service`。
Nginx 通过用户服务创建的 Unix socket 代理 API。公网与局域网仍走站点原有 HTTPS 端口，
本机 CLI 使用独立私有 socket。容器使用的 GID 101 需要能连接公开 socket。
实例配额与链接域名在 `config/passportsim.toml` 中配置。详情见 [开发与验收闭环](docs/pp-iteration.md)。


固件目录按“选择固件 → USB 安装 → 配网与配对”组织。连接／断开集中在安装区；
配网说明是独立静态页，不读写串口，安装中也可查看。
新版 PA-Terminal 由设备热点完成初始 Wi-Fi 设置。PA 地址和公开 CA 在构建时写入，
取自 `config/pa-terminal-build.toml`。需要换实例时修改发布配置后构建一个新的固件版本。
联网后在 PA 后台绑定，后续设备配置由 PA 后台管理。
PPDemo 系列直接按设备菜单使用。网站的浏览器刷写需要可信 HTTPS，普通 PP 业务 HTTP/WS 不需要 CA。

开发和验收使用 PassportSim 运行实际固件，命令和真机验收说明见 [PP 开发与验收闭环](docs/pp-iteration.md)。

## Windows 信任本地 CA

Dell 的固件站、GoldenNest 和 PA 引用同一份主机站点证书。证书涵盖公网 `47.109.34.254`
及局域网 `110.0.0.82`，签发 CA 仍为 GoldenNest Local CA。

电脑若已经信任 GoldenNest Local CA，无需再次导入。否则 Windows 浏览器需要信任公开 CA：

1. 从固件站的 `/certs/pp-firmware-ca.crt` 下载公开 CA 到自己的 Windows。
2. 导入“当前用户 → 受信任的根证书颁发机构”。可双击证书安装，或在 PowerShell 执行：

```powershell
Import-Certificate -FilePath "$env:USERPROFILE\Downloads\pp-firmware-ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

3. 用 Chrome 或 Edge 重新打开网址，确认没有证书警告，再连接 PP。

## 保留设备数据升级

固件中心在 USB 写入前读取设备分区表并核对校验和。每个已有数据分区的名称、类型、子类型、地址、大小和标志都必须保留。允许缩小应用分区以增加独立缓存。分区重叠、数据分区移动、分区表损坏或无法读取时，安装会在擦写前停止。只有验证整片闪存为空时，才按空设备初始化。镜像完全相同时跳过写入。

PA-Terminal 候选包与正式包也可以在连接 USB 的电脑上安装。使用 Node.js 20.19+ 和安装了 `esptool==4.13.0` 的 Python，从本仓库的 `site/` 运行。预检会让设备进入下载模式再重启。

```sh
python tools/install_firmware.py firmware.zip --port COM5 --check-only
python tools/install_firmware.py firmware.zip --port COM5
```

Linux 将 `COM5` 换成设备串口。网页、上述 CLI 和 PA-Terminal 发布检查共用分区规则。对确需移动已有数据的版本，先提供专用迁移和校验，再更新升级策略。已有数据分区内部的记录格式变更由对应固件模块负责迁移。直接调用底层烧录工具会绕过安装保护。

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
# 以下 TypeScript 主机测试使用 Node 22.18+
node --test tests/{firmware,upgrade}.test.mjs
python3 tests/test_install_firmware.py
python3 tests/test_publish.py
npm run build
# 浏览器验收使用已经安装 Playwright 的现有开发环境，不给网站增加运行时 Python 依赖：
/home/macaulish/workspace/PersonalAgent/.venv/bin/python tools/verify_site.py
```

preview.33 的 pp-data-v2 安装器识别原 3.5 MiB 临时区与 512 KiB 历史区组合。先复制并校验完整历史区，再写分区表；设备首次挂载时扩容。中途断开后再次安装会重新比对副本。尚无临时区的旧设备请先通过本地 USB 安装器安装私有保留的 preview.32 过渡包，再从公开目录升级。新布局禁止直接回刷会覆盖历史的旧布局。
