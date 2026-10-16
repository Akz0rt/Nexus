const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Reason templates shared by warns, mutes, kicks and bans (editable in Settings later). */
const DEFAULT_REASONS = ['Флуд', 'Оскорбления', 'Реклама', 'Твинк', 'Скам'];

/** Mute = Discord timeout (max 28 days). */
const MUTE_DURATIONS = {
    '10m': { label: '10 минут', ms: 10 * MINUTE_MS },
    '1h': { label: '1 час', ms: HOUR_MS },
    '6h': { label: '6 часов', ms: 6 * HOUR_MS },
    '1d': { label: '1 день', ms: DAY_MS },
    '7d': { label: '7 дней', ms: 7 * DAY_MS }
};

/** null = permanent ban. */
const BAN_DURATIONS = {
    forever: { label: 'навсегда', ms: null },
    '7d': { label: '7 дней', ms: 7 * DAY_MS },
    '30d': { label: '30 дней', ms: 30 * DAY_MS }
};

/** Days of the banned user's messages to delete. */
const BAN_DELETE_DAYS = [0, 1, 7];

/** A warn expires after this long (also the Cosmos TTL of the warnings container). */
const WARN_TTL_DAYS = 30;

/**
 * Escalation by the number of active warns. A rule fires when the count
 * reaches exactly `warns`, so each step happens once.
 * action: 'timeout' (with durationMs) | 'propose_ban'
 */
const DEFAULT_ESCALATION = [
    { warns: 2, action: 'timeout', durationMs: HOUR_MS },
    { warns: 3, action: 'timeout', durationMs: DAY_MS },
    { warns: 5, action: 'propose_ban' }
];

/** Escalation rule for the given number of active warns, or null. */
function escalationFor(activeCount, rules = DEFAULT_ESCALATION) {
    return rules.find(rule => rule.warns === activeCount) || null;
}

/** "1 час", "2 дня", "45 минут" — for timeouts of any length. */
function formatDuration(ms) {
    const plural = (n, one, few, many) => {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return one;
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
        return many;
    };
    if (ms % DAY_MS === 0) {
        const n = ms / DAY_MS;
        return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
    }
    if (ms % HOUR_MS === 0) {
        const n = ms / HOUR_MS;
        return `${n} ${plural(n, 'час', 'часа', 'часов')}`;
    }
    const n = Math.max(1, Math.round(ms / MINUTE_MS));
    return `${n} ${plural(n, 'минута', 'минуты', 'минут')}`;
}

module.exports = {
    DEFAULT_REASONS,
    MUTE_DURATIONS,
    BAN_DURATIONS,
    BAN_DELETE_DAYS,
    WARN_TTL_DAYS,
    DEFAULT_ESCALATION,
    escalationFor,
    formatDuration
};
