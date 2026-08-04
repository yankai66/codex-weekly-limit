#!/usr/bin/env bash
set -euo pipefail

uuid='codex-quota@local'
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

gnome-extensions disable "$uuid" 2>/dev/null || true

if command -v gio >/dev/null 2>&1; then
    gio trash "$install_dir"
    echo "已移到回收站：$install_dir"
else
    echo "请手动删除：$install_dir"
fi
