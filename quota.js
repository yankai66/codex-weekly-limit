export function normalizeRateLimits(payload) {
    if (!payload || typeof payload !== 'object')
        return [];

    const groups = payload.rateLimitsByLimitId &&
        typeof payload.rateLimitsByLimitId === 'object'
        ? Object.values(payload.rateLimitsByLimitId)
        : payload.rateLimits
            ? [payload.rateLimits]
            : [];

    const windows = [];
    for (const group of groups) {
        if (!group || typeof group !== 'object')
            continue;

        for (const kind of ['primary', 'secondary']) {
            const window = group[kind];
            if (!window || typeof window.usedPercent !== 'number')
                continue;

            windows.push({
                limitId: group.limitId ?? 'codex',
                limitName: group.limitName ?? null,
                kind,
                usedPercent: clamp(window.usedPercent, 0, 100),
                remainingPercent: clamp(100 - window.usedPercent, 0, 100),
                windowDurationMins: numberOrNull(window.windowDurationMins),
                resetsAt: numberOrNull(window.resetsAt),
                planType: group.planType ?? null,
                reachedType: group.rateLimitReachedType ?? null,
            });
        }
    }

    return windows.sort((a, b) => {
        if (a.limitId !== b.limitId)
            return a.limitId.localeCompare(b.limitId);
        return (a.windowDurationMins ?? 0) - (b.windowDurationMins ?? 0);
    });
}

export function mostConstrainedWindow(windows) {
    if (!Array.isArray(windows) || windows.length === 0)
        return null;

    return windows.reduce((lowest, current) =>
        current.remainingPercent < lowest.remainingPercent ? current : lowest);
}

export function formatPercent(value) {
    if (!Number.isFinite(value))
        return '--';
    return `${Math.round(clamp(value, 0, 100))}%`;
}

export function formatWindow(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0)
        return '额度窗口';
    if (minutes < 60)
        return `${Math.round(minutes)} 分钟窗口`;
    if (minutes < 24 * 60) {
        const hours = minutes / 60;
        return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时窗口`;
    }
    const days = minutes / (24 * 60);
    return `${Number.isInteger(days) ? days : days.toFixed(1)} 天窗口`;
}

export function formatResetTime(resetsAt, nowSeconds = Date.now() / 1000) {
    if (!Number.isFinite(resetsAt))
        return '重置时间未知';

    const remaining = Math.max(0, Math.round(resetsAt - nowSeconds));
    if (remaining === 0)
        return '即将重置';

    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);

    if (days > 0)
        return `${days}天 ${hours}小时后重置`;
    if (hours > 0 && minutes > 0)
        return `${hours}小时 ${minutes}分后重置`;
    if (hours > 0)
        return `${hours}小时后重置`;
    return `${Math.max(1, minutes)}分钟后重置`;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
