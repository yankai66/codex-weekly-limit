# DeepSeek 调用信息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Codex 额度 GNOME Shell 扩展中新增一个 DeepSeek 顶栏标签，展示余额、今日 token/费用/次数，并支持从 Chrome localStorage 自动读取或设置界面粘贴 userToken。

**Architecture:** 新增 `deepseek.js` 纯逻辑/网络模块（Soup3 + Gio），`prefs.js` 设置窗口，GSettings schema 存 token，`extension.js` 新增独立 `DeepSeekIndicator` 与现有 Codex 指示器并列。顶栏显示紧凑格式，下拉菜单展示按模型明细。

**Tech Stack:** GNOME Shell 46 / gjs 1.80, GJS ES modules (`import ... from 'gi://...'`), Soup3, Gio, GSettings schema.

## Global Constraints

- 已安装 GJS 1.80.2、Soup-3.0 typelib、GNOME Shell 46。
- ES module 语法：`import Soup from 'gi://Soup'`；不支持 `imports.gi`。
- 网络请求必须带浏览器指纹头，否则 WAF 返回 429（已验证）。
- 用量接口时间参数必须对齐 UTC 零点（天粒度），否则返回 `biz_code:1, biz_msg:"INVALID_PARAM"`。
- 响应包装：`{code:0, data:{biz_code, biz_msg, biz_data}}`；`biz_data` 为实际数据。
- 顶部标签文本：`¥95.0 · 52次 · 18万t · ¥0.11`；缺数据用 `--`；无 token 显示 `DeepSeek --`；token 失效显示 `DeepSeek !`。
- 刷新周期 60 秒（与 Codex 一致），手动刷新按钮。
- 所有菜单文本用中文，与现有扩展一致。
- 遵循 TDD：先写失败测试，再实现，再验证，频繁 commit。
- 运行测试：`gjs -m tests/test-deepseek.js`；现有 `tests/test-quota.js` 必须保持通过。

---

### Task 1: `deepseek.js` 纯函数 + 单元测试（不含网络）

**Files:**
- Create: `deepseek.js`
- Test: `tests/test-deepseek.js`

**Interfaces:**
- Consumes: 无（纯标准库 GLib）。
- Produces:
  - `buildUsageRange(rangeDays = 1)` → `{startSec, endSec}`（UTC 零点对齐，`endSec = startSec + rangeDays*86400`）
  - `normalizeSummary(bizData)` → `{totalBalance, grantedBalance, toppedUpBalance, totalCost, currency}`（数字，缺省 `null`/`0`）
  - `normalizeUsage(bizData)` → `[{model, requests, tokens}]`
  - `normalizeCost(bizData)` → `[{model, cost}]`
  - `summarizeToday(usageBizData, costBizData)` → `{requests, tokens, cost, usage, costByModel}`
  - `formatTokenCount(count)` → `'18万t'` / `'1200t'` / `'--'`
  - `formatCost(cost)` → `'¥0.11'` / `'--'`
  - `formatDeepseekLabel(summary, today)` → `'¥95.0 · 52次 · 18万t · ¥0.11'`

- [ ] **Step 1: 写失败测试**

`tests/test-deepseek.js`：

```js
import {
    buildUsageRange,
    formatCost,
    formatDeepseekLabel,
    formatTokenCount,
    normalizeCost,
    normalizeSummary,
    normalizeUsage,
    summarizeToday,
} from '../deepseek.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertDeepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message}: expected ${b}, got ${a}`);
}

// ---- buildUsageRange ----
const range = buildUsageRange(1);
assertEqual(Number.isInteger(range.startSec), true, 'startSec is integer');
assertEqual(range.endSec - range.startSec, 86400, 'one-day range length');
assertEqual(range.startSec % 86400, 0, 'startSec aligned to UTC midnight');

// ---- normalizeSummary ----
const summary = normalizeSummary({
    normal_wallets: [{currency: 'CNY', balance: '95.29464952'}],
    bonus_wallets: [{currency: 'CNY', balance: '3.50'}],
    total_costs: [{currency: 'CNY', amount: '24.64773716'}],
});
assertEqual(summary.totalBalance, 95.29464952, 'parses total balance');
assertEqual(summary.grantedBalance, 3.5, 'parses granted balance');
assertEqual(summary.totalCost, 24.64773716, 'parses total cost');
assertEqual(summary.currency, 'CNY', 'currency fallback');

assertDeepEqual(normalizeSummary(null), {
    totalBalance: null,
    grantedBalance: null,
    toppedUpBalance: null,
    totalCost: null,
    currency: 'CNY',
}, 'null summary falls back');

// ---- normalizeUsage ----
const usageData = {
    series: [
        {model: 'deepseek-v4-flash', buckets: [
            {usage: {REQUEST: 52, PROMPT_CACHE_HIT_TOKEN: 1627136, PROMPT_CACHE_MISS_TOKEN: 39289, RESPONSE_TOKEN: 19091}},
            {usage: {REQUEST: 5, PROMPT_CACHE_HIT_TOKEN: 100, PROMPT_CACHE_MISS_TOKEN: 200, RESPONSE_TOKEN: 300}},
        ]},
        {model: 'deepseek-v4-pro', buckets: [
            {usage: {REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 10, PROMPT_CACHE_MISS_TOKEN: 20, RESPONSE_TOKEN: 30}},
        ]},
    ],
};
const usage = normalizeUsage(usageData);
assertEqual(usage.length, 2, 'normalizes both models');
const flash = usage.find(u => u.model === 'deepseek-v4-flash');
assertEqual(flash.requests, 57, 'sums requests');
assertEqual(flash.tokens, 1627136 + 39289 + 19091 + 100 + 200 + 300, 'sums tokens');

assertDeepEqual(normalizeUsage(null), [], 'null usage -> empty');

// ---- normalizeCost ----
const costData = {
    data: [
        {currency: 'CNY', series: [
            {model: 'deepseek-v4-flash', buckets: [{cost: '0.1119766'}, {cost: '0.05'}]},
            {model: 'deepseek-v4-pro', buckets: [{cost: '1.1077994'}]},
        ]},
    ],
};
const cost = normalizeCost(costData);
const flashCost = cost.find(c => c.model === 'deepseek-v4-flash');
assertEqual(flashCost.cost, 0.1619766, 'sums costs');
assertEqual(cost.length, 2, 'normalizes cost models');

assertDeepEqual(normalizeCost(null), [], 'null cost -> empty');

// ---- summarizeToday ----
const today = summarizeToday(usageData, costData);
assertEqual(today.requests, 60, 'today total requests');
assertEqual(today.tokens, 1627136 + 39289 + 19091 + 100 + 200 + 300 + 10 + 20 + 30, 'today total tokens');
assertEqual(today.cost, 1.269776, 'today total cost (close)');
assertEqual(today.usage.length, 2, 'today usage per model');
assertEqual(today.costByModel.length, 2, 'today cost per model');

// ---- format helpers ----
assertEqual(formatTokenCount(183000), '18.3万t', 'formats wan');
assertEqual(formatTokenCount(1200), '1200t', 'formats plain');
assertEqual(formatTokenCount(0), '0t', 'formats zero');
assertEqual(formatTokenCount(null), '--', 'formats missing');
assertEqual(formatCost(0.11), '¥0.11', 'formats cost');
assertEqual(formatCost(null), '--', 'formats missing cost');

assertEqual(
    formatDeepseekLabel(
        {totalBalance: 95.2946},
        {requests: 52, tokens: 183000, cost: 0.11}),
    '¥95.3 · 52次 · 18.3万t · ¥0.11',
    'formats full label');

assertEqual(
    formatDeepseekLabel(null, null),
    'DeepSeek --',
    'formats missing label');

print('deepseek tests: ok');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `gjs -m tests/test-deepseek.js`
Expected: 报错 `Error: Cannot find module 'deepseek.js'` 或类似 import 失败。

- [ ] **Step 3: 实现 `deepseek.js` 纯函数**

```js
import GLib from 'gi://GLib';

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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `gjs -m tests/test-deepseek.js`
Expected: `deepseek tests: ok`

- [ ] **Step 5: 运行现有测试确认不回归**

Run: `gjs -m tests/test-quota.js`
Expected: `quota tests: ok`

- [ ] **Step 6: Commit**

```bash
git add deepseek.js tests/test-deepseek.js
git commit -m "feat: add deepseek pure functions and tests"
```

---

### Task 2: `deepseek.js` Chrome localStorage 扫描

**Files:**
- Modify: `deepseek.js`（追加）
- Test: `tests/test-deepseek.js`（追加）

**Interfaces:**
- Consumes: `GLib.get_home_dir()`（来自 gjs）。
- Produces: `extractUserTokenFromChrome(root = null)` → `string | null`。
  - `root` 缺省为 `$HOME/.config/google-chrome`；为便于测试可传入临时目录。
  - 扫描 `root/<profile>/Local Storage/leveldb/*.ldb|*.log`。
  - 查找 `_https://platform.deepseek.com\x00\x01userToken` 标记。
  - 提取 `{"value":"<token>","__version":"0"}` 中的 token。

- [ ] **Step 1: 写失败测试**

在 `tests/test-deepseek.js` 末尾追加：

```js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {extractUserTokenFromChrome} from '../deepseek.js';

const tmp = GLib.get_tmp_dir();
const profile = `${tmp}/ds-chrome-test-${Date.now()}`;
const leveldbDir = `${profile}/Default/Local Storage/leveldb`;
GLib.mkdir_with_parents(leveldbDir, 0o755);
const marker = '_https://platform.deepseek.com\x00\x01userToken\x01\x98e\x00\x00';
const value = '{"value":"test-token-abc123","__version":"0"}';
Gio.File.new_for_path(`${leveldbDir}/000001.log`).replace_contents(
    `\x01,${marker}${value}`,
    null, false, Gio.FileCreateFlags.NONE, null);

const token = extractUserTokenFromChrome(profile);
assertEqual(token, 'test-token-abc123', 'extracts token from leveldb sample');

const missing = extractUserTokenFromChrome('/nonexistent-path-xyz');
assertEqual(missing, null, 'returns null when root missing');

GLib.remove(profile + '/Default/Local Storage/leveldb/000001.log');
GLib.rmdir(profile + '/Default/Local Storage/leveldb');
GLib.rmdir(profile + '/Default/Local Storage');
GLib.rmdir(profile + '/Default');
GLib.rmdir(profile);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `gjs -m tests/test-deepseek.js`
Expected: `Error: extractUserTokenFromChrome is not a function`

- [ ] **Step 3: 实现扫描函数**

在 `deepseek.js` 末尾追加：

```js
import Gio from 'gi://Gio';

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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `gjs -m tests/test-deepseek.js`
Expected: `deepseek tests: ok`

- [ ] **Step 5: 在真实 Chrome 目录验证**

Run: 临时验证脚本（不提交）：
```bash
gjs -c 2>/dev/null || true
```
预期：若 Chrome 当前无 token 返回 null；若用户已登录则返回真实 token。此项为软验证，不强制。

- [ ] **Step 6: Commit**

```bash
git add deepseek.js tests/test-deepseek.js
git commit -m "feat: add chrome localStorage token extraction"
```

---

### Task 3: `deepseek.js` Soup3 网络层

**Files:**
- Modify: `deepseek.js`（追加）
- Test: `tests/test-deepseek-net.js`（新建，测试纯函数 `parseEnvelope` 和 `queryToString`，不依赖外网）

**Interfaces:**
- Consumes: `buildUsageRange`（Task 1）。
- Produces:
  - `class TokenInvalidError extends Error`（含 `name = 'TokenInvalidError'`）
  - `parseEnvelope(text, statusCode)` → `object`（解包后的 `data.biz_data`；401/403 或 `biz_code:1` 且含 TOKEN 抛 `TokenInvalidError`；其他非 200 抛普通 `Error`）
  - `createSession()` → `Soup.Session`（timeout 15s）
  - `fetchJson(session, url, token, query = {})` → `Promise<object>`（网络薄包装，调用 `parseEnvelope`）
  - `fetchDeepseekData(session, token, range, baseUrl = API_BASE)` → `Promise<{summary, usage, cost}>`（`Promise.all` 并发）
  - `queryToString(query)` → `'?a=1&b=2'`（非导出，供 `parseEnvelope` 测试间接覆盖）

> 说明：Soup3 只支持 HTTP/HTTPS，不支持 `file://`，因此网络 IO 本身不做自动测试；把响应解析抽为纯函数 `parseEnvelope(text, statusCode)` 单测覆盖，网络薄层 `fetchJson` 只做「拼 URL → 发请求 → 读 body → 调 parseEnvelope」。真实 API 冒烟测试在 Step 5 人工完成。

- [ ] **Step 1: 写失败测试**

`tests/test-deepseek-net.js`：

```js
import {parseEnvelope, queryToString} from '../deepseek.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertRejectsTokenInvalid(fn, message) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof Error && thrown.name === 'TokenInvalidError'))
        throw new Error(`${message}: expected TokenInvalidError, got ${thrown?.name ?? 'no error'}`);
}

// ---- parseEnvelope: 正常解包 ----
const summaryBody = JSON.stringify({code: 0, data: {biz_code: 0, biz_data: {
    normal_wallets: [{currency: 'CNY', balance: '10.5'}],
    total_costs: [{currency: 'CNY', amount: '1.2'}],
}}});
const parsed = parseEnvelope(summaryBody, 200);
assertEqual(parsed.normal_wallets[0].balance, '10.5', 'unwraps biz_data');
assertEqual(parsed.total_costs[0].amount, '1.2', 'keeps nested fields');

// ---- parseEnvelope: token 失效（HTTP 401）----
assertRejectsTokenInvalid(
    () => parseEnvelope('{"error":"unauthorized"}', 401),
    '401 -> TokenInvalidError');

// ---- parseEnvelope: biz_code=1 且含 TOKEN 字样 ----
assertRejectsTokenInvalid(
    () => parseEnvelope(JSON.stringify({code: 0, data: {biz_code: 1, biz_msg: 'INVALID_TOKEN'}}), 200),
    'biz INVALID_TOKEN -> TokenInvalidError');

// ---- parseEnvelope: 其他业务错误 ----
let bizErr = null;
try {
    parseEnvelope(JSON.stringify({code: 0, data: {biz_code: 1, biz_msg: 'INVALID_PARAM'}}), 200);
} catch (error) {
    bizErr = error;
}
assertEqual(bizErr instanceof Error && bizErr.name !== 'TokenInvalidError', true, 'other biz error -> plain Error');

// ---- parseEnvelope: 非 200 ----
let httpErr = null;
try {
    parseEnvelope('blocked', 429);
} catch (error) {
    httpErr = error;
}
assertEqual(httpErr instanceof Error, true, '429 -> plain Error');

// ---- parseEnvelope: 无效 JSON ----
let jsonErr = null;
try {
    parseEnvelope('not json', 200);
} catch (error) {
    jsonErr = error;
}
assertEqual(jsonErr instanceof Error, true, 'bad JSON -> Error');

// ---- queryToString ----
assertEqual(queryToString({}), '', 'empty query -> empty');
assertEqual(queryToString({a: 1, b: 'x y'}), '?a=1&b=x%20y', 'encodes query');

print('deepseek net tests: ok');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `gjs -m tests/test-deepseek-net.js`
Expected: `Error: parseEnvelope is not a function`

- [ ] **Step 3: 实现网络层**

在 `deepseek.js` 追加：

```js
import Soup from 'gi://Soup';

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

function queryToString(query) {
    const keys = Object.keys(query);
    if (keys.length === 0)
        return '';
    const params = keys
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
        .join('&');
    return `?${params}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `gjs -m tests/test-deepseek-net.js`
Expected: `deepseek net tests: ok`

- [ ] **Step 5: 真实环境冒烟测试（不提交）**

Run: 用一个临时脚本 + 用户提供的 token 手工验证：
```bash
gjs -m /tmp/test-soup3.mjs   # 之前验证过的脚本，改换成 fetchJson 调用
```
Expected: STATUS 200、biz_code 0、返回余额。此项为人工软验证，验证 `fetchJson` 网络路径正确。

- [ ] **Step 6: Commit**

```bash
git add deepseek.js tests/test-deepseek-net.js
git commit -m "feat: add deepseek soup3 network layer"
```

---

### Task 4: GSettings schema + prefs.js 设置窗口

**Files:**
- Create: `schemas/org.gnome.shell.extensions.codex-quota.gschema.xml`
- Create: `prefs.js`
- Modify: `metadata.json`
- Test: 无自动测试（GJS 扩展 prefs 不易单测）；用 `glib-compile-schemas` 验证 schema 语法。

**Interfaces:**
- Consumes: `extractUserTokenFromChrome`（Task 2）。
- Produces: GSettings key `deepseek-token`（string，默认 `''`）。prefs 窗口提供 token 粘贴框 + 「从 Chrome 读取」按钮。

- [ ] **Step 1: 写 schema**

`schemas/org.gnome.shell.extensions.codex-quota.gschema.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.codex-quota" path="/org/gnome/shell/extensions/codex-quota/">
    <key name="deepseek-token" type="s">
      <default>''</default>
      <summary>DeepSeek platform user token</summary>
      <description>登录 platform.deepseek.com 后从浏览器 localStorage 的 userToken 字段复制的会话 token。</description>
    </key>
  </schema>
</schemalist>
```

- [ ] **Step 2: 编译验证 schema**

Run: `glib-compile-schemas --strict schemas/`
Expected: 无错误输出。

- [ ] **Step 3: 更新 metadata.json**

```json
{
  "uuid": "codex-quota@local",
  "name": "Codex Quota",
  "description": "Show Codex rate-limit capacity and DeepSeek usage in the GNOME top bar.",
  "version": 2,
  "shell-version": ["46"],
  "settings-schema": "org.gnome.shell.extensions.codex-quota"
}
```

- [ ] **Step 4: 写 prefs.js**

```js
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
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
```

- [ ] **Step 5: 语法验证**

Run: `gjs -c "$(cat prefs.js)" 2>&1 | head -5`
Expected: 无 JS 语法错误（gjs -c 对 module 语法可能报 import 错误，此时改为 `node --check prefs.js`）。

Run: `node --check prefs.js`
Expected: 无输出（语法 OK）。

- [ ] **Step 6: 清理编译产物并提交**

```bash
rm -rf schemas/gschemas.compiled
git add schemas/org.gnome.shell.extensions.codex-quota.gschema.xml prefs.js metadata.json
git commit -m "feat: add deepseek token gsettings schema and prefs window"
```

---

### Task 5: `extension.js` DeepSeek 指示器

**Files:**
- Modify: `extension.js`
- Modify: `stylesheet.css`
- Test: 无自动测试（GNOME Shell 集成）；人工验证 + `node --check` 语法检查。

**Interfaces:**
- Consumes:
  - `createSession`, `fetchDeepseekData`, `TokenInvalidError`（Task 3）
  - `buildUsageRange`, `normalizeSummary`, `summarizeToday`, `formatDeepseekLabel`, `formatCost`, `formatTokenCount`, `formatWindow`-style（Task 1）
  - `extractUserTokenFromChrome`（Task 2）
  - GSettings schema `deepseek-token`（Task 4）
- Produces: 无（集成进扩展 UI）。

- [ ] **Step 1: 在 extension.js 顶部加 import**

在现有 import 块后追加：

```js
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
```

- [ ] **Step 2: 新增 DeepSeekIndicator 类**

在 `CodexQuotaIndicator` 类定义之后、`export default class CodexQuotaExtension` 之前插入：

```js
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
        this._label = new St.Label({
            text: 'DeepSeek --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codex-quota-panel-label',
        });
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
            : 'DeepSeek !';
        if (message)
            this._statusItem.label.text = message;
        this._applyTokenWarning(true);
    }

    _applyTokenWarning(critical) {
        this._label.remove_style_class_name('codex-quota-critical');
        if (critical)
            this._label.add_style_class_name('codex-quota-critical');
    }

    destroy() {
        this._enabled = false;
        if (this._refreshSource)
            GLib.source_remove(this._refreshSource);
        this._refreshSource = 0;
        super.destroy();
    }
});
```

- [ ] **Step 3: 修改扩展入口挂载指示器**

替换 `enable()` 方法：

```js
enable() {
    this._settings = this.getSettings();
    this._indicator = new CodexQuotaIndicator();
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    this._deepseekIndicator = new DeepSeekIndicator(this._settings);
    Main.panel.addToStatusArea(`${this.uuid}-deepseek`, this._deepseekIndicator, 1, 'right');
}

disable() {
    this._indicator?.destroy();
    this._indicator = null;
    this._deepseekIndicator?.destroy();
    this._deepseekIndicator = null;
}
```

- [ ] **Step 4: stylesheet.css 加 DeepSeek 样式**

追加：

```css
.deepseek-quota-panel-box {
  spacing: 5px;
}
```

（`codex-quota-critical` 已存在，复用即可。）

- [ ] **Step 5: 语法检查**

Run: `node --check extension.js`
Expected: 无输出。

- [ ] **Step 6: 人工验证（安装后）**

1. `./install.sh`（先完成 Task 6 再执行完整安装）。
2. 顶栏应出现 `DeepSeek --`。
3. 设置界面粘贴 token 后，60s 内刷新显示 `¥95.3 · N次 · X万t · ¥0.11`。
4. 下拉菜单显示余额/模型明细/更新时间。
5. 无 token 时显示 `DeepSeek !` + 提示。
6. 检查日志：`journalctl --user -f -o cat /usr/bin/gnome-shell`。

- [ ] **Step 7: Commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat: add deepseek indicator to panel"
```

---

### Task 6: 安装脚本、README、最终验证

**Files:**
- Modify: `install.sh`
- Modify: `uninstall.sh`（如需要清理 schemas 编译产物）
- Modify: `README.md`
- Test: `gjs -m tests/test-deepseek.js`、`gjs -m tests/test-quota.js`、`gjs -m tests/test-deepseek-net.js`

**Interfaces:**
- Consumes: 全部前序任务产出文件。

- [ ] **Step 1: 更新 install.sh 复制新文件并编译 schema**

在 `cp "$script_dir/stylesheet.css" ...` 之后追加：

```bash
cp "$script_dir/deepseek.js" "$install_dir/deepseek.js"
cp "$script_dir/prefs.js" "$install_dir/prefs.js"
cp -r "$script_dir/schemas" "$install_dir/schemas"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$install_dir/schemas"
fi
```

- [ ] **Step 2: 更新 uninstall.sh 无需特殊处理**

确认 uninstall 已整目录移入回收站（现有逻辑足够），无需修改。若需要，添加 schemas 清理说明到注释。

- [ ] **Step 3: 更新 README.md**

在「点击顶栏的 Codex 75%…」段落之后补充 DeepSeek 章节：

```markdown
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
```

- [ ] **Step 4: 全量测试**

Run:
```bash
gjs -m tests/test-quota.js
gjs -m tests/test-deepseek.js
gjs -m tests/test-deepseek-net.js
```
Expected: 三行均输出 `ok`。

- [ ] **Step 5: 完整安装验证**

Run: `./install.sh`
Expected: 安装成功，无报错；顶栏出现 DeepSeek 标签（可能需要 Alt+F2 r 重载）。

- [ ] **Step 6: Commit**

```bash
git add install.sh README.md
git commit -m "docs: add deepseek setup instructions and install support"
```

---

## Self-Review 清单

- [x] **Spec 覆盖**：spec 中「数据来源」「token 获取」「顶栏显示 4 项」「菜单明细」「60s 刷新」「token 失效显示 !」「Chrome 扫描 + 手动兜底」全部映射到 Task 1-6。
- [x] **Placeholder 扫描**：所有代码步骤含完整代码，无 TBD/TODO。
- [x] **类型一致性**：`buildUsageRange`、`normalizeSummary`、`summarizeToday`、`formatDeepseekLabel`、`createSession`、`fetchJson`、`fetchDeepseekData`、`extractUserTokenFromChrome` 在 Task 1-5 中签名一致。
