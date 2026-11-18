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

固件验收台使用部署在 `runtime/passportsim/` 的 PassportSim Worker 和 WASM。浏览器和命令行
执行同一套场景。每次都从空 NVS 启动，根据虚拟时间发送按键和 USB 串口命令，断言真实固件的
LVGL 界面及串口回复。构建、测试和证据均在 Dell 上完成。

```sh
# 从 site/ 启动浏览器验收台。Dell 已运行时直接转发 9451。
python3 tools/pp_lab.py sim serve

# 选择已发布版本，或以一次候选构建的运行编号选择私有候选。
python3 tools/pp_lab.py sim run --version 0.2.1-preview.6 --case offline-settings
python3 tools/pp_lab.py sim run --candidate CANDIDATE_RUN --case offline-settings

# 检查失败步骤、预期与实际、截图文件名，以及串口输出。
python3 tools/pp_lab.py sim inspect SIM_RUN
python3 tools/pp_lab.py sim inspect SIM_RUN --serial
python3 tools/pp_lab.py sim replay SIM_RUN
```

浏览器打开 `http://127.0.0.1:9451/` 后可以选版本、运行场景，也可以手动启动、按键、发送
`pp.status` 和保存截图。浏览器远程连接 Dell 时，在 VS Code 将 Dell 的 9451 转发到本机
9451。验收台和调试文件仅通过这个本地入口访问。9443 的验收进度提供入口链接。

使用 `?image=release:0.2.1-preview.6&case=offline-settings` 预选版本和场景，
或使用 `?run=SIM_RUN` 打开一条记录。运行摘要包含编号和证据目录。
详细证据位于 `../private/pp-lab/sim/runs/SIM_RUN/`，包含步骤、固件与模拟器哈希、
关键截图、控件树和串口。复跑会核对 Flash、应用、ELF、模拟器和场景的指纹。
`--fault` 或页面中的「注入断言失败」用于验收失败证据，复跑时默认执行原场景。
旧版固件缺少调试符号时，通过
`python3 tools/pp_lab.py sim attach-elf --version VERSION /path/to/pa_terminal.elf`
登记同次构建的 ELF。工具会核对应用描述里的 ELF 哈希。

### 修复后的完整迭代

```sh
# 在 PersonalAgent 中修复固件后，构建、私有预发布、虚拟安装并执行 16 步场景。
python3 tools/pp_lab.py sim iterate --case offline-maintenance
# 同一产物再次验证，直接复跑已有记录。
python3 tools/pp_lab.py sim replay SIM_RUN
```

`iterate` 复用 ESP-IDF 的增量构建和现有发布器。每次候选使用自己的私有发布目录，
模拟器从生成的安装 ZIP 校验各分片并启动固件。场景覆盖网络诊断、离线重载提示、
维护确认取消、长按回主页和串口状态。用例位于 `tools/sim/scenes.json`，失败时查看实际
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
