import {
    formatPercent,
    formatResetTime,
    formatWindow,
    mostConstrainedWindow,
    normalizeRateLimits,
} from '../quota.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const payload = {
    rateLimits: {
        limitId: 'codex',
        primary: {usedPercent: 25, windowDurationMins: 300, resetsAt: 10_000},
        secondary: {usedPercent: 70, windowDurationMins: 10_080, resetsAt: 20_000},
    },
};

const windows = normalizeRateLimits(payload);
assertEqual(windows.length, 2, 'normalizes both windows');
assertEqual(windows[0].remainingPercent, 75, 'computes primary remaining capacity');
assertEqual(windows[1].remainingPercent, 30, 'computes secondary remaining capacity');
assertEqual(mostConstrainedWindow(windows).remainingPercent, 30, 'finds tightest window');
assertEqual(formatPercent(74.6), '75%', 'rounds percent');
assertEqual(formatWindow(300), '5 小时窗口', 'formats hours');
assertEqual(formatWindow(10_080), '7 天窗口', 'formats days');
assertEqual(formatResetTime(7_300, 100), '2小时后重置', 'formats reset countdown');

const multi = normalizeRateLimits({
    rateLimitsByLimitId: {
        codex: payload.rateLimits,
        other: {
            limitId: 'other',
            primary: {usedPercent: 120, windowDurationMins: 60, resetsAt: 30_000},
        },
    },
});
assertEqual(multi.length, 3, 'normalizes multi-bucket response');
assertEqual(multi[2].remainingPercent, 0, 'clamps over-limit remaining capacity');

print('quota tests: ok');
