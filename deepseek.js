import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

const CURRENCY_FALLBACK = 'CNY';

export function buildUsageRange(rangeDays = 1) {
    const now = new Date();
    const startSec = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    return {
        startSec,
        endSec: startSec + rangeDays * 86400,
    };
}

export function normalizeSummary(bizData) {
    if (!bizData || typeof bizData !== 'object')
        return {
            totalBalance: null,
            grantedBalance: null,
            toppedUpBalance: null,
            totalCost: null,
            currency: CURRENCY_FALLBACK,
        };

    const normal = Array.isArray(bizData.normal_wallets) ? bizData.normal_wallets[0] : null;
    const bonus = Array.isArray(bizData.bonus_wallets) ? bizData.bonus_wallets[0] : null;
    const costs = Array.isArray(bizData.total_costs) ? bizData.total_costs[0] : null;

    return {
        totalBalance: numberFromString(normal?.balance),
        grantedBalance: numberFromString(bonus?.balance),
        toppedUpBalance: numberFromString(normal?.topped_up_balance),
        totalCost: numberFromString(costs?.amount),
        currency: normal?.currency ?? bonus?.currency ?? CURRENCY_FALLBACK,
    };
}

export function normalizeUsage(bizData) {
    if (!bizData || !Array.isArray(bizData.series))
        return [];

    const byModel = new Map();
    for (const series of bizData.series) {
        if (!series || typeof series !== 'object')
            continue;
        const model = series.model ?? 'unknown';
        let entry = byModel.get(model);
        if (!entry) {
            entry = {model, requests: 0, tokens: 0};
            byModel.set(model, entry);
        }
        for (const bucket of series.buckets ?? []) {
            const usage = bucket.usage ?? {};
            entry.requests += usage.REQUEST ?? 0;
            entry.tokens +=
                (usage.PROMPT_CACHE_HIT_TOKEN ?? 0) +
                (usage.PROMPT_CACHE_MISS_TOKEN ?? 0) +
                (usage.RESPONSE_TOKEN ?? 0);
        }
    }
    return [...byModel.values()];
}

export function normalizeCost(bizData) {
    if (!bizData || !Array.isArray(bizData.data))
        return [];

    const byModel = new Map();
    for (const currencyGroup of bizData.data) {
        for (const series of currencyGroup?.series ?? []) {
            if (!series || typeof series !== 'object')
                continue;
            const model = series.model ?? 'unknown';
            let entry = byModel.get(model);
            if (!entry) {
                entry = {model, cost: 0};
                byModel.set(model, entry);
            }
            for (const bucket of series.buckets ?? []) {
                entry.cost += numberFromString(bucket?.cost) ?? 0;
            }
        }
    }
    return [...byModel.values()];
}

export function summarizeToday(usageBizData, costBizData) {
    const usage = normalizeUsage(usageBizData);
    const costByModel = normalizeCost(costBizData);
    return {
        requests: usage.reduce((sum, u) => sum + u.requests, 0),
        tokens: usage.reduce((sum, u) => sum + u.tokens, 0),
        cost: costByModel.reduce((sum, c) => sum + c.cost, 0),
        usage,
        costByModel,
    };
}

export function formatTokenCount(count) {
    if (!Number.isFinite(count) || count < 0)
        return '--';
    if (count >= 100_000_000)
        return `${(count / 100_000_000).toFixed(1)}亿t`;
    if (count >= 10_000)
        return `${(count / 10_000).toFixed(1)}万t`;
    return `${Math.round(count)}t`;
}

export function formatCost(cost) {
    if (!Number.isFinite(cost))
        return '--';
    return `¥${cost.toFixed(2)}`;
}

export function formatDeepseekLabel(summary, today) {
    if (!summary || !today)
        return 'DeepSeek --';
    const balance = summary.totalBalance;
    const parts = [
        balance !== null && Number.isFinite(balance) ? `¥${balance.toFixed(1)}` : '--',
        Number.isInteger(today.requests) ? `${today.requests}次` : '--',
        formatTokenCount(today.tokens),
        formatCost(today.cost),
    ];
    return parts.join(' · ');
}

function numberFromString(value) {
    if (value === null || value === undefined)
        return null;
    const num = Number.parseFloat(value);
    return Number.isFinite(num) ? num : null;
}

const TOKEN_MARKER = '_https://platform.deepseek.com\x00\x01userToken';
const TOKEN_PATTERN = /\{"value":"([^"]+)"\s*,\s*"__version":"0"\}/;

export function extractUserTokenFromChrome(root = null) {
    const chromeRoot = root ?? `${GLib.get_home_dir()}/.config/google-chrome`;
    const rootFile = Gio.File.new_for_path(chromeRoot);
    if (!rootFile.query_exists(null))
        return null;

    try {
        const enumerator = rootFile.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const lsDir = `${chromeRoot}/${info.get_name()}/Local Storage/leveldb`;
            const token = scanLevelDbDir(lsDir);
            if (token) {
                enumerator.close(null);
                return token;
            }
        }
        enumerator.close(null);
    } catch (error) {
        console.debug(`DeepSeek: chrome scan failed: ${error.message}`);
    }
    return null;
}

function scanLevelDbDir(leveldbDir) {
    const dir = Gio.File.new_for_path(leveldbDir);
    if (!dir.query_exists(null))
        return null;

    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            if (!name.endsWith('.ldb') && !name.endsWith('.log'))
                continue;
            const token = scanLevelDbFile(`${leveldbDir}/${name}`);
            if (token) {
                enumerator.close(null);
                return token;
            }
        }
        enumerator.close(null);
    } catch (error) {
        console.debug(`DeepSeek: leveldb scan failed: ${error.message}`);
    }
    return null;
}

function scanLevelDbFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [, contents] = file.load_contents(null);
        const text = new TextDecoder().decode(contents);
        const index = text.indexOf(TOKEN_MARKER);
        if (index < 0)
            return null;
        const window = text.slice(index, index + 4000);
        const match = TOKEN_PATTERN.exec(window);
        return match ? match[1] : null;
    } catch (error) {
        console.debug(`DeepSeek: leveldb file read failed: ${error.message}`);
        return null;
    }
}

const API_BASE = 'https://platform.deepseek.com';
const CLIENT_HEADERS = {
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0',
    'x-client-locale': 'zh-CN',
    'x-client-timezone-offset': '480',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Referer': 'https://platform.deepseek.com/usage',
    'Origin': 'https://platform.deepseek.com',
};

export class TokenInvalidError extends Error {
    constructor(message = 'DeepSeek token 已失效') {
        super(message);
        this.name = 'TokenInvalidError';
    }
}

export function createSession() {
    const session = new Soup.Session();
    session.timeout = 15;
    return session;
}

export function parseEnvelope(text, statusCode) {
    if (statusCode === 401 || statusCode === 403)
        throw new TokenInvalidError();

    let envelope;
    try {
        envelope = JSON.parse(text);
    } catch (error) {
        throw new Error(`DeepSeek 响应解析失败: ${error.message}`);
    }

    if (statusCode !== 200)
        throw new Error(`DeepSeek HTTP ${statusCode}`);

    if (envelope?.data?.biz_code === 1) {
        const msg = envelope.data.biz_msg ?? '';
        if (/INVALID_TOKEN|TOKEN/i.test(msg))
            throw new TokenInvalidError();
        throw new Error(`DeepSeek 接口错误: ${msg}`);
    }
    return envelope?.data?.biz_data ?? null;
}

export function fetchJson(session, url, token, query = {}) {
    return new Promise((resolve, reject) => {
        const target = `${url}${queryToString(query)}`;
        const message = Soup.Message.new('GET', target);
        for (const [name, value] of Object.entries(CLIENT_HEADERS))
            message.request_headers.append(name, value);
        message.request_headers.append('Authorization', `Bearer ${token}`);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            let text;
            try {
                const bytes = sess.send_and_read_finish(res);
                text = String.fromCharCode(...bytes.toArray());
            } catch (error) {
                reject(new Error(`DeepSeek 网络错误: ${error.message}`));
                return;
            }
            try {
                resolve(parseEnvelope(text, message.status_code));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function fetchDeepseekData(session, token, range, baseUrl = API_BASE) {
    const query = {start: range.startSec, end: range.endSec, tz: 0};
    const [summary, usage, cost] = await Promise.all([
        fetchJson(session, `${baseUrl}/api/v0/users/get_user_summary`, token, {}),
        fetchJson(session, `${baseUrl}/api/v0/usage/by_api_key/amount`, token, query),
        fetchJson(session, `${baseUrl}/api/v0/usage/by_api_key/cost`, token, query),
    ]);
    return {summary, usage, cost};
}

export function queryToString(query) {
    const keys = Object.keys(query);
    if (keys.length === 0)
        return '';
    const params = keys
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
        .join('&');
    return `?${params}`;
}
