# PP 开发与验收闭环

[打开 PP 交互演示的验收进度](https://47.109.34.254:9443/pp-demo/)。
在演示页看原型、打开用例、查看检查结果，以及导出需要开发者处理的反馈。
演示页读进度并导出文件。运行命令、查看完整日志和修改代码都在 Dell 上完成。

| 阶段 | 日常动作 |
| --- | --- |
| 原型 | 在 PP 交互演示中讨论变化。新增场景用 `scenarios.js`；需要留存验收的行为在 `lab/cases.json` 记录操作和预期。 |
| 实现 | 修改 PA 仓库内的终端或协议。对照同一场景同步演示页的状态、控件和文案；原型变更可以先预览。 |
| 自检 | 运行受影响的检查。失败时从本机日志复现并修复，重跑失败项和直接受影响的检查。 |
| 真机 | 构建私有候选，查看远程串口状态。需要刷写时使用候选包按现有发布或烧录流程操作，并记录对应镜像。 |
| 现场验收 | 仅把屏幕观感、实体按键、实际声音等必须现场判断的用例留给用户。用户在演示页导出反馈文件，开发会话导入后继续。 |

## 开发命令

在 `pp-firmware/site/` 运行。默认使用工作区中的 `PersonalAgent/` 及其 `.venv`，
以及 `pp-firmware/toolchain/` 中的 ESP-IDF 5.5.3。
程序由 Dell 开发环境运行，固件网站容器继续读取静态文件。

```sh
python3 tools/pp_lab.py run
python3 tools/pp_lab.py run demo
python3 tools/pp_lab.py run unit integration
python3 tools/pp_lab.py run candidate device
python3 tools/pp_lab.py status
```

默认跑固件与 PP 交互演示的基线、C 和 JS 单元检查、打包检查、真实 PA/Pi 加合成语音的集成检查、
浏览器场景及反馈导出。独立项最多三路并行。需要完整候选时再跑 `candidate`；
`device` 只读 `pp.status`，它的通过代表串口能通信。页面会单独说明采样时的 PA 连接状态。
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
USB 未就绪时页面显示唤醒或检查数据线的操作。远程串口只能作为现场验收的一项证据。

## 固件与 PP 交互演示同步

终端组件和共享板级 C 源码、头文件纳入同一个对照指纹。布局、按键事件、网络、音频、休眠或素材变化都会让 `run sync` 提示重新核对；新拆出的终端模块自动纳入。
对照源码更新受影响的演示场景和用例后，用下面命令记录新的基线：

```sh
python3 tools/pp_lab.py sync --reason '核对了本轮变化的界面和按键操作'
python3 tools/pp_lab.py run demo
```

有字形或形象变化时自动复用既有导出脚本。基线登记代表完成了本轮对照，界面及交互仍由
浏览器和真机分层验收。进度记录源码指纹，各项检查结果独立更新。运行时发现相关源码变更，
旧结果显示“待复跑”。修改完成暂时还没准备跑检查时，可用 `status` 刷新过期标记。

## 用户反馈与修复

1. 用户从“验收进度”打开演示场景，选择结果，填写操作步骤和实际表现，导出 JSON 发给开发会话。
2. 开发者导入文件，检查本机原始备注及自动化证据。代码能够定位的部分先修复并复跑。
3. 自动证据足够时收尾。仍需要现场判断时，把要复测的动作写进问题摘要，用户可在演示页查看。
4. 用户导出对应当前版本的“真机通过”后，导入会收尾同用例处于待复测的问题。

```sh
python3 tools/pp_lab.py feedback /path/to/pp-feedback-task-image.json
python3 tools/pp_lab.py triage ISSUE_ID retest --summary '请在任务报告页连续按两次下，确认可以翻页'
python3 tools/pp_lab.py triage ISSUE_ID resolved --summary '浏览器和协议回归已覆盖，问题已修复'
```

完整日志、候选包、连接参数和用户原始反馈位于 `../private/pp-lab/`。
页面只读生成的 `public/pp-demo/lab/status.json`，显示版本、检查状态、运行编号和开发者明确录入的摘要。
原始反馈和私有日志留在 Dell。演示页的反馈导出后需要交给开发会话导入。
