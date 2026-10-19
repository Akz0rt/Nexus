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

/**
 * Punishment templates («Флуд → мут 10 мин + варн»): what «Наказать…» offers first.
 * A step is { kind: 'warn' } | { kind: 'mute', duration } | { kind: 'kick' }
 *   | { kind: 'ban', duration, deleteDays }. Edited by administrators, per server.
 */
const DEFAULT_PUNISH_TEMPLATES = [
    { id: 'flood', name: 'Флуд', reason: 'Флуд', steps: [{ kind: 'mute', duration: '10m' }, { kind: 'warn' }] },
    { id: 'insults', name: 'Оскорбления', reason: 'Оскорбления', steps: [{ kind: 'mute', duration: '1h' }, { kind: 'warn' }] },
    { id: 'ads', name: 'Реклама', reason: 'Реклама', steps: [{ kind: 'ban', duration: '7d', deleteDays: 1 }] },
    { id: 'scam', name: 'Скам-ссылки', reason: 'Скам', steps: [{ kind: 'ban', duration: 'forever', deleteDays: 7 }] }
];
const MAX_TEMPLATES = 12;
const STEP_KINDS = ['warn', 'mute', 'kick', 'ban'];

/**
 * Check steps from the app: known kinds and presets, each kind once, kick and ban
 * not together. Returned in the order they run: warn, mute, kick, ban.
 * @returns {object[]|null} null when invalid
 */
function cleanSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > STEP_KINDS.length) return null;
    const out = [];
    for (const step of steps) {
        const kind = step?.kind;
        if (!STEP_KINDS.includes(kind) || out.some(s => s.kind === kind)) return null;
        if (kind === 'mute') {
            if (!Object.hasOwn(MUTE_DURATIONS, step.duration)) return null;
            out.push({ kind, duration: step.duration });
        } else if (kind === 'ban') {
            const deleteDays = Number(step.deleteDays ?? 0);
            if (!Object.hasOwn(BAN_DURATIONS, step.duration) || !BAN_DELETE_DAYS.includes(deleteDays)) return null;
            out.push({ kind, duration: step.duration, deleteDays });
        } else {
            out.push({ kind });
        }
    }
    if (out.some(s => s.kind === 'kick') && out.some(s => s.kind === 'ban')) return null;
    return out.sort((a, b) => STEP_KINDS.indexOf(a.kind) - STEP_KINDS.indexOf(b.kind));
}

/** «мут 10 мин + варн», «бан навсегда, удалить за 7 дн.» — for notes and the panel */
function describeSteps(steps) {
    const SHORT_MUTE = { '10m': '10 мин', '1h': '1 ч', '6h': '6 ч', '1d': '1 день', '7d': '7 дней' };
    const order = { mute: 0, ban: 1, kick: 2, warn: 3 }; // what people read first
    return [...steps].sort((a, b) => order[a.kind] - order[b.kind]).map(step => {
        if (step.kind === 'mute') return `мут ${SHORT_MUTE[step.duration] || step.duration}`;
        if (step.kind === 'ban') {
            const span = step.duration === 'forever' ? 'навсегда' : BAN_DURATIONS[step.duration]?.label.replace('дней', 'дн.') || step.duration;
            const wipe = step.deleteDays ? `, удалить за ${step.deleteDays === 1 ? '24 ч' : `${step.deleteDays} дн.`}` : '';
            return `бан ${span}${wipe}`;
        }
        return step.kind === 'kick' ? 'кик' : 'варн';
    }).join(' + ');
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
    DEFAULT_PUNISH_TEMPLATES,
    MAX_TEMPLATES,
    cleanSteps,
    describeSteps,
    escalationFor,
    formatDuration
};
