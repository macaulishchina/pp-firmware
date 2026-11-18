# ESP32 稳定编译环境

该目录保存 Dell 本机共享工具链，不是固件源码仓库，不运行 PA 或后台服务。
固定 ESP-IDF 5.5.3，目前安装 ESP32-C3 所需工具；不同 SDK 版本可在本目录并存。

| 目录 | 内容 |
|---|---|
| esp-idf-v5.5.3/ | 官方 SDK 固定标签及子模块 |
| tools/ | 官方 IDF 工具管理器的编译器、调试器和 ROM 文件 |
| python_env/ | 在当前路径重新创建的 IDF 专用 Python 环境 |
| dist/ | 官方下载压缩包，供校验／重装复用 |
| logs/ | 安装及验证日志，不作为公开发布文件 |
| requirements-idf5.5-py3.12.lock.txt | 当前验证环境的 Python 包版本清单 |
| environment.json | 本机工具及 SDK 版本记录 |

## 使用

在 Bash 或 Zsh 中执行：

```sh
source /home/macaulish/workspace/pp-firmware/toolchain/activate.sh
idf.py --version
cd /home/macaulish/workspace/PersonalAgent/src/assistant_runtime/plugins/ai_passport/firmware
idf.py build
python tools/package_firmware.py
```

## 安装到新的工作区

在 `toolchain/` 中使用 Python 3.12 安装。SDK 版本与 SDK 子模块提交记录在 `environment.json`。

```sh
git clone --branch v5.5.3 --recurse-submodules https://github.com/espressif/esp-idf.git esp-idf-v5.5.3
git -C esp-idf-v5.5.3 rev-parse HEAD
export IDF_TOOLS_PATH="$PWD"
python3.12 esp-idf-v5.5.3/tools/idf_tools.py install --targets=esp32c3
python3.12 -m venv python_env/idf5.5_py3.12_env
python_env/idf5.5_py3.12_env/bin/python -m pip install -r requirements-idf5.5-py3.12.lock.txt
source activate.sh
idf.py --version
```

需要重新生成字形时，在 `font-tools/` 执行 `npm ci`。

入口复用 SDK 原生 export.sh，仅影响当前终端；不写 .bashrc／.zshrc，不影响 PA
的 .venv 或系统服务 PATH。不直接挪动 Python 虚拟环境；再次更换目录需要重新创建
Python 环境并清理固件 CMake 缓存后重新构建。

新增 SDK／更新工具为显式运维操作；不在 PA 启动时下载或自动更新。
生成的固件候选保存在 ../candidates/；正式发布目录另行管理。
