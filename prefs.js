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
        window.add(page);
    }
}
