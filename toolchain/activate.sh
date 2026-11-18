# Source this file in bash or zsh; changes affect this terminal only.
if [ -n "${ZSH_VERSION:-}" ]; then
    pp_sdk_activate="${(%):-%x}"
else
    pp_sdk_activate="${BASH_SOURCE[0]}"
fi
IDF_TOOLS_PATH="$(cd -- "$(dirname -- "$pp_sdk_activate")" && pwd -P)" || return 1
export IDF_TOOLS_PATH
unset pp_sdk_activate
export IDF_PATH="$IDF_TOOLS_PATH/esp-idf-v5.5.3"
export IDF_PYTHON_ENV_PATH="$IDF_TOOLS_PATH/python_env/idf5.5_py3.12_env"
export PATH="$IDF_PYTHON_ENV_PATH/bin:$PATH"
. "$IDF_PATH/export.sh"
