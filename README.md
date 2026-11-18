# PP 固件交付工作区

仓库根目录为 `pp-firmware/`。自研固件和 PA 插件源码位于同级
`PersonalAgent/src/assistant_runtime/plugins/ai_passport/`。

| 目录 | 内容 | Git 管理 |
| --- | --- | --- |
| `site/` | 9443 固件站、发布工具、PP Lab、部署配置 | 主仓库 |
| `releases/` | 已上架的镜像、下载包、清单及许可文件 | 主仓库，与网站目录同时提交 |
| `upstream/AI-Passport/` | FoloToy 官方硬件与固件参考 | Git 子模块 |
| `upstream/passportsim/` | PassportSim 模拟器源码 | Git 子模块 |
| `toolchain/` | ESP-IDF、编译器、Python 和字体工具 | 记录版本、依赖锁和启动脚本 |
| `candidates/`、`runtime/`、`private/` | 候选包、模拟器网页产物、证书、日志及验收证据 | 本机文件 |

## 克隆与更新

```sh
git clone --recurse-submodules git@github.com:macaulishchina/pp-firmware.git
cd pp-firmware
git pull --ff-only
git submodule update --init --recursive
```

主仓库记录两个子模块的确切提交。日常拉取后用 `git submodule update --init --recursive`
恢复已登记的版本。需要升级时，进入对应子模块切到 `main` 并执行 `git pull --ff-only`，
验证后回到仓库根目录，用 `git add upstream/<名称>` 登记新提交。已发布固件的更新应同时
提交 `site/config/pp.toml` 和对应的 `releases/<应用>/<版本>/`。

[固件站说明](site/README.local.md) · [PP Lab 开发与验收](site/docs/pp-iteration.md) · [工具链](toolchain/README.md)
