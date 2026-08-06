import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {extractUserTokenFromChrome} from './deepseek.js';

export default class CodexQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'DeepSeek',
            description: '登录 https://platform.deepseek.com 后，从浏览器开发者工具 localStorage 复制 userToken 粘贴到此处。',
        });

        const tokenRow = new Adw.EntryRow({title: 'userToken'});
        tokenRow.text = settings.get_string('deepseek-token');
        tokenRow.connect('changed', () => {
            settings.set_string('deepseek-token', tokenRow.text.trim());
        });
        group.add(tokenRow);

        const chromeButton = new Gtk.Button({label: '从 Chrome 自动读取', halign: Gtk.Align.START, margin_top: 8});
        chromeButton.connect('clicked', () => {
            const token = extractUserTokenFromChrome();
            if (token) {
                tokenRow.text = token;
                settings.set_string('deepseek-token', token);
            } else {
                chromeButton.label = '未在 Chrome 中找到 token';
            }
        });
        group.add(chromeButton);

        page.add(group);

        const refreshGroup = new Adw.PreferencesGroup({
            title: '刷新间隔',
            description: '自动刷新数据的时间间隔（秒），最小 10 秒。',
        });

        const codexSpin = new Adw.SpinRow({
            title: 'Codex 刷新间隔',
            subtitle: 'Codex 额度自动刷新间隔',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 3600, step_increment: 10,
                value: settings.get_int('codex-refresh-seconds'),
            }),
        });
        codexSpin.connect('notify::value', () => {
            settings.set_int('codex-refresh-seconds', Math.round(codexSpin.value));
        });
        refreshGroup.add(codexSpin);

        const deepseekSpin = new Adw.SpinRow({
            title: 'DeepSeek 刷新间隔',
            subtitle: 'DeepSeek 用量自动刷新间隔',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 3600, step_increment: 10,
                value: settings.get_int('deepseek-refresh-seconds'),
            }),
        });
        deepseekSpin.connect('notify::value', () => {
            settings.set_int('deepseek-refresh-seconds', Math.round(deepseekSpin.value));
        });
        refreshGroup.add(deepseekSpin);

        page.add(refreshGroup);
        window.add(page);
    }
}
