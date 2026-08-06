import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    formatPercent,
    formatResetTime,
    formatWindow,
    mostConstrainedWindow,
    normalizeRateLimits,
} from './quota.js';

import {
    buildUsageRange,
    createSession,
    extractUserTokenFromChrome,
    fetchDeepseekData,
    formatCost,
    formatDeepseekLabel,
    formatTokenCount,
    normalizeSummary,
    summarizeToday,
    TokenInvalidError,
} from './deepseek.js';

const DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
const REFRESH_SECONDS = 60;
const COUNTDOWN_SECONDS = 30;
const RECONNECT_SECONDS = 15;

const CodexQuotaIndicator = GObject.registerClass(
class CodexQuotaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Codex Quota');

        this._enabled = true;
        this._requestId = 10;
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._stderr = null;
        this._windows = [];
        this._lastPayload = null;
        this._lastUpdatedAt = null;
        this._refreshSource = 0;
        this._countdownSource = 0;
        this._reconnectSource = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box codex-quota-panel-box'});
        const iconPath = GLib.build_filenamev([
            Extension.lookupByURL(import.meta.url).path,
            'chatgpt-blossom.svg',
        ]);
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)}),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'Codex --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codex-quota-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._statusItem = new PopupMenu.PopupMenuItem('正在连接 Codex…', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('立即刷新');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        const dashboardItem = new PopupMenu.PopupMenuItem('打开用量面板');
        dashboardItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(DASHBOARD_URL, null);
        });
        this.menu.addMenuItem(dashboardItem);

        this._startServer();
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        this._countdownSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            COUNTDOWN_SECONDS,
            () => {
                this._render();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _applyDesktopProxy(launcher) {
        try {
            const proxy = new Gio.Settings({schema_id: 'org.gnome.system.proxy'});
            if (proxy.get_string('mode') !== 'manual')
                return;

            const setProxy = (schemaId, variable, scheme) => {
                const settings = new Gio.Settings({schema_id: schemaId});
                const host = settings.get_string('host');
                const port = settings.get_int('port');
                if (!host || port <= 0)
                    return;

                const value = `${scheme}://${host}:${port}/`;
                launcher.setenv(variable, value, true);
                launcher.setenv(variable.toLowerCase(), value, true);
            };

            setProxy('org.gnome.system.proxy.http', 'HTTP_PROXY', 'http');
            setProxy('org.gnome.system.proxy.https', 'HTTPS_PROXY', 'http');
            setProxy('org.gnome.system.proxy.socks', 'ALL_PROXY', 'socks5');

            const ignored = proxy.get_strv('ignore-hosts');
            if (ignored.length > 0) {
                const noProxy = ignored.join(',');
                launcher.setenv('NO_PROXY', noProxy, true);
                launcher.setenv('no_proxy', noProxy, true);
            }
        } catch (error) {
            console.error(`Codex Quota: failed to read desktop proxy: ${error.message}`);
        }
    }

    _startServer() {
        if (!this._enabled || this._process)
            return;

        this._setStatus('正在连接 Codex…');
        try {
            const flags = Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE;
            const launcher = new Gio.SubprocessLauncher({flags});
            this._applyDesktopProxy(launcher);
            this._process = launcher.spawnv([
                    '/bin/bash',
                    '-c',
                    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; exec codex app-server',
                ]);
            this._stdin = new Gio.DataOutputStream({
                base_stream: this._process.get_stdin_pipe(),
            });
            this._stdout = new Gio.DataInputStream({
                base_stream: this._process.get_stdout_pipe(),
            });
            this._stderr = new Gio.DataInputStream({
                base_stream: this._process.get_stderr_pipe(),
            });

            this._readStdout();
            this._readStderr();
            this._process.wait_async(null, (process, result) => {
                try {
                    process.wait_finish(result);
                } catch (error) {
                    console.debug(`Codex Quota: app-server wait failed: ${error.message}`);
                }
                if (process === this._process)
                    this._handleServerExit();
            });

            this._send({
                method: 'initialize',
                id: 1,
                params: {
                    clientInfo: {
                        name: 'codex_quota_widget',
                        title: 'Codex Quota Widget',
                        version: '0.1.0',
                    },
                },
            });
        } catch (error) {
            console.error(`Codex Quota: cannot start app-server: ${error.message}`);
            this._process = null;
            this._setError('无法启动 Codex；请确认终端中可以运行 codex');
            this._scheduleReconnect();
        }
    }

    _send(message) {
        if (!this._stdin)
            return false;

        try {
            this._stdin.put_string(`${JSON.stringify(message)}\n`, null);
            return true;
        } catch (error) {
            console.error(`Codex Quota: write failed: ${error.message}`);
            this._setError('与 Codex 的连接已断开');
            return false;
        }
    }

    _readStdout() {
        if (!this._stdout)
            return;

        const stream = this._stdout;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            if (!this._enabled || stream !== this._stdout)
                return;
            try {
                const [line] = source.read_line_finish_utf8(result);
                if (line === null)
                    return;
                this._handleMessage(JSON.parse(line));
                this._readStdout();
            } catch (error) {
                console.error(`Codex Quota: invalid app-server message: ${error.message}`);
                this._readStdout();
            }
        });
    }

    _readStderr() {
        if (!this._stderr)
            return;

        const stream = this._stderr;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            if (!this._enabled || stream !== this._stderr)
                return;
            try {
                const [line] = source.read_line_finish_utf8(result);
                if (line === null)
                    return;
                console.debug(`Codex Quota app-server: ${line}`);
                this._readStderr();
            } catch (error) {
                console.debug(`Codex Quota: stderr read failed: ${error.message}`);
            }
        });
    }

    _handleMessage(message) {
        if (message.id === 1 && message.result) {
            this._send({method: 'initialized', params: {}});
            this.refresh();
            return;
        }

        if (message.id && message.error) {
            this._setError(message.error.message ?? 'Codex 返回未知错误');
            return;
        }

        if (message.id && message.result &&
            (message.result.rateLimits || message.result.rateLimitsByLimitId)) {
            this._applyPayload(message.result);
            return;
        }

        if (message.method === 'account/rateLimits/updated')
            this._applyPayload(message.params ?? {});
    }

    refresh() {
        if (!this._stdin) {
            this._startServer();
            return;
        }
        this._requestId += 1;
        this._send({
            method: 'account/rateLimits/read',
            id: this._requestId,
        });
    }

    _applyPayload(payload) {
        this._lastPayload = payload;
        this._windows = normalizeRateLimits(payload);
        this._lastUpdatedAt = new Date();

        if (this._windows.length === 0) {
            this._setError('账号未返回 Codex 额度；请确认使用 ChatGPT 登录');
            return;
        }
        this._render();
    }

    _render() {
        if (this._windows.length === 0)
            return;

        const constrained = mostConstrainedWindow(this._windows);
        this._label.text = `Codex ${formatPercent(constrained.remainingPercent)}`;
        this._label.remove_style_class_name('codex-quota-warning');
        this._label.remove_style_class_name('codex-quota-critical');
        if (constrained.remainingPercent <= 10)
            this._label.add_style_class_name('codex-quota-critical');
        else if (constrained.remainingPercent <= 25)
            this._label.add_style_class_name('codex-quota-warning');

        const lines = this._windows.map(window => {
            const name = window.limitName || window.limitId;
            return `${name} · ${formatWindow(window.windowDurationMins)}：` +
                `${formatPercent(window.remainingPercent)} 剩余 · ` +
                formatResetTime(window.resetsAt);
        });
        const updated = this._lastUpdatedAt
            ? this._lastUpdatedAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
            : '--:--';
        this._setStatus(`${lines.join('\n')}\n更新于 ${updated}`);
    }

    _setStatus(text) {
        this._statusItem.label.text = text;
    }

    _setError(text) {
        this._label.text = 'Codex !';
        this._setStatus(text);
    }

    _handleServerExit() {
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._stderr = null;
        if (!this._enabled)
            return;
        this._setError('Codex App Server 已退出，稍后重连');
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (!this._enabled || this._reconnectSource)
            return;
        this._reconnectSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            RECONNECT_SECONDS,
            () => {
                this._reconnectSource = 0;
                this._startServer();
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        this._enabled = false;
        for (const source of [this._refreshSource, this._countdownSource, this._reconnectSource]) {
            if (source)
                GLib.source_remove(source);
        }
        this._refreshSource = 0;
        this._countdownSource = 0;
        this._reconnectSource = 0;

        if (this._process) {
            try {
                this._process.force_exit();
            } catch (error) {
                console.debug(`Codex Quota: app-server shutdown failed: ${error.message}`);
            }
        }
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._stderr = null;
        super.destroy();
    }
});

const DEEPSEEK_REFRESH_SECONDS = 60;
const DEEPSEEK_USAGE_URL = 'https://platform.deepseek.com/usage';

const DeepSeekIndicator = GObject.registerClass(
class DeepSeekIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'DeepSeek Usage');

        this._enabled = true;
        this._settings = settings;
        this._session = createSession();
        this._summary = null;
        this._today = null;
        this._lastUpdatedAt = null;
        this._tokenInvalid = false;
        this._refreshSource = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box codex-quota-panel-box'});
        const iconPath = GLib.build_filenamev([
            Extension.lookupByURL(import.meta.url).path,
            'deepseek-whale.svg',
        ]);
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)}),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '-- · -- · --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codex-quota-panel-label deepseek-quota-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._statusItem = new PopupMenu.PopupMenuItem('正在获取 DeepSeek 数据…', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('立即刷新');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        const usageItem = new PopupMenu.PopupMenuItem('打开 DeepSeek 用量面板');
        usageItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(DEEPSEEK_USAGE_URL, null);
        });
        this.menu.addMenuItem(usageItem);

        const prefsItem = new PopupMenu.PopupMenuItem('DeepSeek 设置');
        prefsItem.connect('activate', () => {
            Extension.lookupByURL(import.meta.url).openPreferences();
        });
        this.menu.addMenuItem(prefsItem);

        this.refresh();
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            DEEPSEEK_REFRESH_SECONDS,
            () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _getToken() {
        const stored = this._settings.get_string('deepseek-token').trim();
        if (stored)
            return stored;
        return extractUserTokenFromChrome();
    }

    refresh() {
        if (!this._enabled)
            return;
        const token = this._getToken();
        if (!token) {
            this._setState(null, null, '未配置 DeepSeek token，请在设置中粘贴或自动读取');
            return;
        }

        const range = buildUsageRange(1);
        fetchDeepseekData(this._session, token, range)
            .then(({summary, usage, cost}) => {
                this._tokenInvalid = false;
                this._summary = normalizeSummary(summary);
                this._today = summarizeToday(usage, cost);
                this._lastUpdatedAt = new Date();
                this._render();
            })
            .catch((error) => {
                if (error instanceof TokenInvalidError) {
                    this._tokenInvalid = true;
                    this._setState(null, null, 'DeepSeek token 已失效，请在设置中更新');
                } else {
                    this._setState(null, null, `DeepSeek 获取失败：${error.message}`);
                }
            });
    }

    _render() {
        if (!this._summary || !this._today)
            return;

        const lines = [];
        lines.push(`余额 ¥${this._summary.totalBalance?.toFixed(2) ?? '--'} · ` +
            `赠送 ${this._summary.grantedBalance !== null ? `¥${this._summary.grantedBalance.toFixed(2)}` : '--'} · ` +
            `充值 ${this._summary.toppedUpBalance !== null ? `¥${this._summary.toppedUpBalance.toFixed(2)}` : '--'} · ` +
            `总消费 ¥${this._summary.totalCost?.toFixed(2) ?? '--'}`);

        if (this._today.usage.length > 0) {
            const modelRows = this._today.usage.map(entry => {
                const cost = this._today.costByModel.find(c => c.model === entry.model)?.cost;
                return `${entry.model}：${entry.requests}次 · ${formatTokenCount(entry.tokens)} · ${formatCost(cost)}`;
            });
            lines.push(...modelRows);
        } else {
            lines.push('今日暂无调用');
        }

        const updated = this._lastUpdatedAt
            ? this._lastUpdatedAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
            : '--:--';
        lines.push(`更新于 ${updated}`);
        this._label.text = formatDeepseekLabel(this._summary, this._today);
        this._applyTokenWarning(false);
        this._statusItem.label.text = lines.join('\n');
    }

    _setState(summary, today, message) {
        this._label.text = summary && today
            ? formatDeepseekLabel(summary, today)
            : '!';
        if (message)
            this._statusItem.label.text = message;
        this._applyTokenWarning(true);
    }

    _applyTokenWarning(critical) {
        this._label.remove_style_class_name('critical');
        if (critical)
            this._label.add_style_class_name('critical');
    }

    destroy() {
        this._enabled = false;
        if (this._refreshSource)
            GLib.source_remove(this._refreshSource);
        this._refreshSource = 0;
        super.destroy();
    }
});

export default class CodexQuotaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CodexQuotaIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        this._deepseekIndicator = new DeepSeekIndicator(this._settings);
        Main.panel.addToStatusArea(`${this.uuid}-deepseek`, this._deepseekIndicator, 2, 'left');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._deepseekIndicator?.destroy();
        this._deepseekIndicator = null;
    }
}
