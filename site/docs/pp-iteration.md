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
