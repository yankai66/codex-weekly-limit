import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    buildUsageRange,
    extractUserTokenFromChrome,
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
assertEqual(formatTokenCount(1830000), '1.8M', 'formats M');
assertEqual(formatTokenCount(183000), '183K', 'formats K');
assertEqual(formatTokenCount(1200), '1.2K', 'formats K small');
assertEqual(formatTokenCount(0), '0', 'formats zero');
assertEqual(formatTokenCount(null), '--', 'formats missing');
assertEqual(formatCost(0.11), '¥0.11', 'formats cost');
assertEqual(formatCost(null), '--', 'formats missing cost');

assertEqual(
    formatDeepseekLabel(
        {totalBalance: 95.2946},
        {requests: 52, tokens: 183000, cost: 0.11}),
    '¥95.3 · ¥0.11 · 183K',
    'formats full label');

assertEqual(
    formatDeepseekLabel(null, null),
    '-- · -- · --',
    'formats missing label');

// ---- extractUserTokenFromChrome ----
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

print('deepseek tests: ok');
