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
