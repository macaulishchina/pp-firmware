# PP 开发与验收闭环

在 PP Sim 中运行实际固件，查看设备画面、操作按键和读取串口。运行用例、查看完整日志和修改代码都在 Dell 上完成。[打开 PP Sim](https://47.109.34.254:9443/pp-sim/)

| 阶段 | 日常动作 |
| --- | --- |
| 实现 | 修改 PA 仓库内的终端或协议。把操作步骤及预期写入 `tools/sim/scenes.json` 中受影响的场景。 |
| 自检 | 运行受影响的检查，用 PassportSim 载入候选固件并执行场景。失败时根据画面和串口复现、修复并复跑。 |
| 真机 | 构建私有候选，查看远程串口状态。需要刷写时使用候选包按现有发布或烧录流程操作，并记录对应镜像。 |
| 现场验收 | 核对真机的屏幕观感、实体按键、实际声音和功耗。反馈附固件版本、复现步骤和必要的串口日志。 |

## 开发命令

在 `pp-firmware/site/` 运行。默认使用工作区中的 `PersonalAgent/` 及其 `.venv`，
以及 `pp-firmware/toolchain/` 中的 ESP-IDF 5.5.3。
程序由 Dell 开发环境运行，固件网站容器继续读取静态文件。

```sh
python3 tools/pp_lab.py run
python3 tools/pp_lab.py run unit integration
python3 tools/pp_lab.py run candidate device
python3 tools/pp_lab.py status
```

默认运行固件 C 测试、打包及工具测试，以及真实 PA/Pi 加合成语音的集成检查。独立项最多三路并行。
需要完整候选时运行 `candidate`。`device` 读取 `pp.status` 并记录串口和 PA 连接状态。
`status` 显示检查状态和运行编号。相关源码变化时，旧结果会标为待复跑。
候选构建只产生私有刷写包。刷写和发布使用现有流程，不由测试脚本触发。

## 用 PassportSim 验证真实固件

`/pp-sim/` 是唯一的固件模拟网页。裸地址照常在浏览器里运行 PassportSim。通过「新建会话」
选择已发布且有匹配调试符号的固件。普通会话编号从 1 开始递增，结束或替换会话后也继续发号。
浏览器通过「复制链接」分享 `/pp-sim/?session=编号#key=凭据`。打开完整链接，或将它粘贴到「打开会话」，
即可让几个浏览器与 AI 操作同一实例。持有链接的人都能按键、查看屏幕和串口，也能结束普通会话。
刷新或关闭一个浏览器后，实例仍由 Dell 保存。本机 CLI 通过私有控制接口使用整数编号。

序号保存在 PP Lab 私有状态目录的 `sim/control/session-ids.sqlite3`，服务重启时继续递增。
分配后启动失败可能留下空号。迁移实例时保留该数据库。服务进程重启后，普通会话需要重新创建。

**0 号保留给 AI 开发。** 它不占普通会话配额，也不会因空闲、顶替或手动结束而关闭。
开发者加载新固件后，已打开的页面会自动切到新画面。固件启动失败时保留上一轮。
固定链接和凭据跨服务重启有效，重启后页面等待 AI 再次加载固件。
共享链接可通过本机 `python3 tools/pp_lab.py sim session link 0` 获取。

服务读取 `site/config/passportsim.toml`。默认 `max_sessions = 5`，只统计普通会话。达到上限时销毁最久未使用
的空闲实例，有浏览器连接、断开后短暂重连期内或正在运行场景的实例不参与容量回收。
`max_sessions = 0` 关闭数量限制与 LRU 回收。

当共享名额全忙时，网页可选择等待空位，或确认顶掉最久未活动的实例。等待按加入顺序，
页面断开即退出队列，分到名额后自动打开新会话。顶掉按最后一次加入或操作的时间选择；
所有网页访客和本机 CLI 都可明确选择，原成员会收到结束提示，进行中的场景会中断。
本机命令可加 `--wait-for-slot` 或 `--replace-oldest`，场景命令使用这些选项时自动进入共享模式。

`session_idle_timeout_hours = 24` 控制自动销毁的空闲时限，即使名额充足也生效。重新加入、
按键、串口写入等有效操作及本机查询会重新计时。网页挂着时的心跳和自动刷新不会续期，
正在执行的命令或验收场景会先完成。销毁后会话链接失效，已保存的验收记录仍可通过 CLI 查看。
配置重启服务后生效，重启会结束当时运行的模拟器。浏览器本地模拟与独立命令行验收不计入共享名额。

### 命令行开发流程

PassportSim Worker 与 WASM 从 `runtime/passportsim/` 读取。每次验收从空 NVS 启动，
以虚拟时间执行按键和 USB 串口命令。构建、虚拟安装、测试和证据都由 PP Lab 命令行处理。

```sh
python3 tools/pp_lab.py sim run --version 0.2.1-preview.6 --case offline-settings
python3 tools/pp_lab.py sim run --candidate CANDIDATE_RUN --case offline-settings
python3 tools/pp_lab.py sim inspect SIM_RUN
python3 tools/pp_lab.py sim inspect SIM_RUN --serial
python3 tools/pp_lab.py sim replay SIM_RUN
```

`sim run`、`sim replay`、`sim iterate` 默认使用 0 号，并在标准错误输出固定链接。
可用 `--isolated` 独立执行。显式选择 `--wait-for-slot` 或 `--replace-oldest` 时使用普通会话。
短场景可以加 `--wait-for-join`，等待浏览器接入，最多 30 秒。执行场景期间会话显示进度，
手动写入暂缓。完成后同一会话可继续操作。手动加载固件的 `sim session new` 也默认使用 0 号。

```sh
python3 tools/pp_lab.py sim session new --candidate CANDIDATE_RUN
python3 tools/pp_lab.py sim session status 0
python3 tools/pp_lab.py sim session press 0 ok
python3 tools/pp_lab.py sim session send 0 pp.status
python3 tools/pp_lab.py sim session serial 0
python3 tools/pp_lab.py sim session screen 0 screen.png
python3 tools/pp_lab.py sim session end SESSION_ID
```

详细证据位于 `../private/pp-lab/sim/runs/SIM_RUN/`，包括步骤、镜像与模拟器哈希、
关键截图、控件树和串口。复跑会核对 Flash、应用、ELF、模拟器和场景指纹。
`--fault` 注入失败断言，用于验收失败证据。复跑默认执行原场景。
`python3 tools/pp_lab.py sim attach-elf --version VERSION /path/to/pa_terminal.elf`
登记同次构建的调试符号，工具会核对应用描述里的 ELF 哈希。
设备的 `pp.status` 同时返回固件版本和 ELF SHA-256。PP Lab 只在构建指纹也吻合时确认设备使用了当前候选；历史固件缺少这一字段时只能报告其版本。

### 修复后的完整迭代

```sh
# 在 PersonalAgent 中修复固件后，构建、私有预发布、虚拟安装并运行离线维护场景。
python3 tools/pp_lab.py sim iterate --case offline-maintenance
# 同一产物再次验证，直接复跑已有记录。
python3 tools/pp_lab.py sim replay SIM_RUN
```

`iterate` 复用 ESP-IDF 的增量构建和现有发布器。每次候选使用自己的私有发布目录，
模拟器从生成的安装 ZIP 校验各分片并启动固件。场景覆盖网络诊断、离线同步提示、
配对与重置子页、出厂确认取消、返回焦点、长按回主页和串口状态。用例位于 `tools/sim/scenes.json`，失败时查看实际
界面与串口再修改固件或断言。候选通过后，通过现有发布工具登记新版本，使用固件站
的浏览器 USB 安装和真机验收流程完成交付。

仿真覆盖固件界面、按键、模拟存储和可复现的串口行为。实际热点配网、录放音、按键手感
及休眠功耗仍按真机用例验证。

初次用 `--ssh-host`、`--ssh-port`、`--ssh-key` 和 `--known-hosts` 配置已验证的 Windows 烧录台。
这四项只保存在本机私有工作目录。之后用 `run device` 复用；反向隧道窗口和 PP USB 需要保持连接。
USB 未就绪时，终端会提示唤醒 PP、检查数据线或关闭占用串口的程序。
完整日志、候选包、连接参数和验收记录存于 `../private/pp-lab/`。

状态栏改动使用 `offline-status-meter` 场景。它对照真实 LCD 像素，检查离线和切换菜单时双行横杠、右侧箭头及其相对位置。联网验收对比同一实例空闲、持续收发和停止传输后的两行读数。真机检查玉绿外环与米白内饼的辨识度、录音或播报后缓存占用的回落、热点断开以及待机唤醒后的首个采样窗口。

### 真机候选安装

保留 Wi-Fi、配对与历史的真机验证，使用固件中心或 `site/tools/install_firmware.py 候选包.zip --port 串口`。两者在同一 USB 连接中完成兼容性预检和写入。设备报告数据分区不兼容时停止，记录冲突分区并转入迁移设计。
