#!/usr/bin/env bash
set -euo pipefail

uuid='codex-quota@local'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if ! command -v codex >/dev/null 2>&1; then
    echo '错误：找不到 codex。请先确保在登录 shell 中可以运行 codex。' >&2
    exit 1
fi

mkdir -p "$install_dir"
cp "$script_dir/extension.js" "$install_dir/extension.js"
cp "$script_dir/chatgpt-blossom.svg" "$install_dir/chatgpt-blossom.svg"
cp "$script_dir/deepseek-whale.svg" "$install_dir/deepseek-whale.svg"
cp "$script_dir/metadata.json" "$install_dir/metadata.json"
cp "$script_dir/quota.js" "$install_dir/quota.js"
cp "$script_dir/stylesheet.css" "$install_dir/stylesheet.css"
cp "$script_dir/deepseek.js" "$install_dir/deepseek.js"
cp "$script_dir/prefs.js" "$install_dir/prefs.js"
cp -r "$script_dir/schemas" "$install_dir/schemas"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$install_dir/schemas"
fi

echo "已安装到：$install_dir"
echo '正在启用扩展…'
if gnome-extensions enable "$uuid"; then
    echo '扩展已启用。'
else
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$enabled" != *"'$uuid'"* ]]; then
        if [[ "$enabled" == '@as []' || "$enabled" == '[]' ]]; then
            updated="['$uuid']"
        else
            updated="${enabled%]}"
            updated="$updated, '$uuid']"
        fi
        gsettings set org.gnome.shell enabled-extensions "$updated"
    fi
    echo '扩展已加入启用列表，GNOME Shell 重载后生效。'
fi

if [[ "${XDG_SESSION_TYPE:-}" == 'x11' ]]; then
    echo '如果顶栏没有立即出现：按 Alt+F2，输入 r，然后按回车。'
else
    echo '如果顶栏没有立即出现：请注销并重新登录。'
fi
