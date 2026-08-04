# Codex Quota

Ubuntu GNOME 顶栏小组件，通过官方 Codex App Server 显示 ChatGPT Codex
额度窗口、剩余百分比和重置倒计时。

## 环境

- Ubuntu 24.04 / GNOME Shell 46
- 已安装并登录 Codex CLI
- 登录 shell 中可以执行 `codex`

本扩展读取 `account/rateLimits/read`，不会启动对话或消耗模型推理额度。

## 安装

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

首次安装后如果顶栏没有立即出现：

- X11：按 `Alt+F2`，输入 `r`，按回车。
- Wayland：注销并重新登录。

点击顶栏的 `Codex 75%` 可以查看所有额度窗口、重置倒计时，并手动刷新。
顶栏百分比取所有返回窗口中最紧张的一个。

## 测试

```bash
gjs -m tests/test-quota.js
```

检查扩展日志：

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## 卸载

```bash
./uninstall.sh
```

卸载脚本会先禁用扩展，再把扩展目录移入桌面回收站。

## 限制

- 当前版本面向 ChatGPT 账号登录的 Codex；API-key-only 认证使用另一套计费体系。
- WebSocket App Server 仍是实验功能，因此扩展使用本地、受支持的 stdio 传输。
- 当前元数据仅声明支持 GNOME Shell 46。
