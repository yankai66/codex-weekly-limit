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

## DeepSeek 用量

顶栏右侧新增 DeepSeek 标签，展示余额、今日 token 用量、今日费用、今日调用次数。

数据来自 platform.deepseek.com 的内部接口，使用网页登录态 token
（`userToken`）鉴权，不会消耗任何模型额度。

获取 token：

1. 用 Chrome 打开 https://platform.deepseek.com 并登录。
2. 按 F12 打开开发者工具 → Console。
3. 输入 `localStorage.getItem('userToken')` 回车，复制返回的 JSON 中的
   `value` 字段（以 `ey` 开头的一长串）。
4. 打开扩展设置（右键顶栏 DeepSeek 标签 → DeepSeek 设置），粘贴 token。

扩展也会自动尝试从 Chrome 的 localStorage 读取 token；若读取不到，
请手动粘贴。token 失效后顶栏显示 `DeepSeek !`，需重新获取。

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

# 免责声明

本项目是由社区开发者独立开发的开源工具，与 OpenAI 官方无任何关联，也未获得 OpenAI 的官方授权、认可或支持。

本项目用于辅助用户查看和管理 Codex 使用情况，相关数据来源于可用接口或公开信息。由于服务策略、接口行为以及系统更新等因素影响，本项目展示的数据可能存在延迟或与实际情况不完全一致，开发者不保证数据的绝对准确性和实时性。

本项目按「现状」提供，不提供任何形式的明示或暗示保证。使用者应自行承担使用本项目所产生的风险，包括但不限于账号管理、服务额度变化、接口调整以及其他相关问题。

用户在使用本项目时，应遵守 OpenAI 相关服务条款以及适用的法律法规。开发者不对因使用本项目导致的任何直接或间接损失承担责任。

使用本项目即表示您已阅读、理解并同意以上免责声明。
