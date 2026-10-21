/**
 * Server banner settings: one `banner` group per server in guild_settings.
 * The main server without one yet takes the old global BANNER_MODE / ACTIVITY_PERIOD /
 * ACTIVITY_CALC_MODE (settings/config) until it is saved for the first time.
 */

// What the banner shows; «Не менять баннер» is enabled: false
const MODES = ['leader', 'podium', 'event', 'background'];
const LAYOUT_MODES = ['leader', 'podium', 'birthday', 'event'];
const LAYOUTS = ['left', 'center', 'right'];
const PERIODS = ['1h', '2h', '24h', '7d', '30d'];
const CALCS = ['messages', 'voice', 'combined'];
const BACKINGS = ['glass', 'solid', 'none'];
const INTERVALS = [15, 30, 60];
const MAX_BLUR = 40;
const MAX_EVENT_HOURS = 24;
const MAX_EXCLUDED_USERS = 25;

const DEFAULTS = {
    // Off until turned on in the panel: a server never gets its banner changed by surprise
    enabled: false,
    mode: 'leader',
    layouts: { leader: 'left', podium: 'center', birthday: 'center', event: 'right' },
    autoBirthday: true,
    autoEventHours: 3,
    period: '24h',
    calc: 'combined',
    backing: 'glass',
    blur: 20,
    dim: 0.85,
    exclude: { bots: true, admins: false, yesterdayLeader: false, users: [] },
    intervalMin: 30,
    onlyOnChange: true,
    backgroundBlobId: null
};

// The old settings' values in the new terms
const LEGACY_PERIODS = { hour: '1h', day: '24h', week: '7d', month: '30d' };
const LEGACY_CALCS = { text: 'messages', voice: 'voice', combined: 'combined' };

/** The old global settings doc → a banner group (null if it never had banner settings) */
function fromLegacy(legacy) {
    if (!legacy || !['BANNER_MODE', 'ACTIVITY_PERIOD', 'ACTIVITY_CALC_MODE'].some(key => key in legacy)) return null;
    const mode = legacy.BANNER_MODE || 'active';
    return {
        // Stays off: the administrator turns it on once the background is uploaded.
        // «random» and «birthday» become the leader with the birthday person shown on their day
        enabled: false,
        mode: 'leader',
        autoBirthday: mode === 'birthday' || mode === 'random' ? true : DEFAULTS.autoBirthday,
        period: LEGACY_PERIODS[legacy.ACTIVITY_PERIOD] || '7d',
        calc: LEGACY_CALCS[legacy.ACTIVITY_CALC_MODE] || 'messages'
    };
}

/** The new values in the old dashboard's terms (/api/server-banner-settings) */
function toLegacy(banner) {
    const periods = { '1h': 'hour', '2h': 'hour', '24h': 'day', '7d': 'week', '30d': 'month' };
    const calcs = { messages: 'text', voice: 'voice', combined: 'combined' };
    return {
        mode: banner.enabled ? 'active' : 'none',
        period: periods[banner.period] || 'week',
        calcMode: calcs[banner.calc] || 'text'
    };
}

const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const isSnowflake = value => /^\d{17,20}$/.test(String(value || ''));

/** Saved values (or the old ones) over the defaults; anything unknown falls back */
function resolveBanner(raw, legacy = null) {
    const source = raw || fromLegacy(legacy) || {};
    const layouts = {};
    for (const mode of LAYOUT_MODES) layouts[mode] = pick(source.layouts?.[mode], LAYOUTS, DEFAULTS.layouts[mode]);
    const exclude = source.exclude || {};
    const blur = Number(source.blur);
    const dim = Number(source.dim);
    const hours = Number(source.autoEventHours);
    return {
        enabled: source.enabled === true,
        mode: pick(source.mode, MODES, DEFAULTS.mode),
        layouts,
        autoBirthday: source.autoBirthday ?? DEFAULTS.autoBirthday,
        autoEventHours: Number.isInteger(hours) && hours >= 0 && hours <= MAX_EVENT_HOURS ? hours : DEFAULTS.autoEventHours,
        period: pick(source.period, PERIODS, DEFAULTS.period),
        calc: pick(source.calc, CALCS, DEFAULTS.calc),
        backing: pick(source.backing, BACKINGS, DEFAULTS.backing),
        blur: Number.isFinite(blur) && blur >= 0 && blur <= MAX_BLUR ? blur : DEFAULTS.blur,
        dim: Number.isFinite(dim) && dim >= 0 && dim <= 1 ? dim : DEFAULTS.dim,
        exclude: {
            bots: exclude.bots ?? DEFAULTS.exclude.bots,
            admins: exclude.admins ?? DEFAULTS.exclude.admins,
            yesterdayLeader: exclude.yesterdayLeader ?? DEFAULTS.exclude.yesterdayLeader,
            users: Array.isArray(exclude.users) ? exclude.users.filter(isSnowflake) : []
        },
        intervalMin: pick(Number(source.intervalMin), INTERVALS, DEFAULTS.intervalMin),
        onlyOnChange: source.onlyOnChange ?? DEFAULTS.onlyOnChange,
        backgroundBlobId: source.backgroundBlobId || null
    };
}

function fail(field, code) {
    return { ok: false, field, code };
}

/**
 * A banner save from the panel: any subset of the fields, checked and merged into
 * what's saved. The background is set by its upload, not here.
 * @returns {{ ok: true, banner: object, fields: string[] } | { ok: false, field, code }}
 */
function sanitizeBanner(body, current) {
    const next = JSON.parse(JSON.stringify(current));
    const fields = [];
    const bool = key => {
        if (!(key in body)) return true;
        if (typeof body[key] !== 'boolean') return false;
        next[key] = body[key];
        fields.push(key);
        return true;
    };
    for (const key of ['enabled', 'autoBirthday', 'onlyOnChange']) if (!bool(key)) return fail(key, 'invalid_value');

    const choices = { mode: MODES, period: PERIODS, calc: CALCS, backing: BACKINGS };
    for (const [key, list] of Object.entries(choices)) {
        if (!(key in body)) continue;
        if (!list.includes(body[key])) return fail(key, 'invalid_value');
        next[key] = body[key];
        fields.push(key);
    }
    if ('intervalMin' in body) {
        if (!INTERVALS.includes(body.intervalMin)) return fail('intervalMin', 'invalid_value');
        next.intervalMin = body.intervalMin;
        fields.push('intervalMin');
    }
    if ('autoEventHours' in body) {
        if (!Number.isInteger(body.autoEventHours) || body.autoEventHours < 0 || body.autoEventHours > MAX_EVENT_HOURS) return fail('autoEventHours', 'invalid_value');
        next.autoEventHours = body.autoEventHours;
        fields.push('autoEventHours');
    }
    if ('blur' in body) {
        if (typeof body.blur !== 'number' || !(body.blur >= 0 && body.blur <= MAX_BLUR)) return fail('blur', 'invalid_value');
        next.blur = Math.round(body.blur);
        fields.push('blur');
    }
    if ('dim' in body) {
        if (typeof body.dim !== 'number' || !(body.dim >= 0 && body.dim <= 1)) return fail('dim', 'invalid_value');
        next.dim = Math.round(body.dim * 100) / 100;
        fields.push('dim');
    }
    if ('layouts' in body) {
        if (!body.layouts || typeof body.layouts !== 'object') return fail('layouts', 'invalid_value');
        for (const [mode, layout] of Object.entries(body.layouts)) {
            if (!LAYOUT_MODES.includes(mode) || !LAYOUTS.includes(layout)) return fail('layouts', 'invalid_value');
            next.layouts[mode] = layout;
        }
        fields.push('layouts');
    }
    if ('exclude' in body) {
        const exclude = body.exclude;
        if (!exclude || typeof exclude !== 'object') return fail('exclude', 'invalid_value');
        for (const key of ['bots', 'admins', 'yesterdayLeader']) {
            if (!(key in exclude)) continue;
            if (typeof exclude[key] !== 'boolean') return fail('exclude', 'invalid_value');
            next.exclude[key] = exclude[key];
        }
        if ('users' in exclude) {
            if (!Array.isArray(exclude.users) || !exclude.users.every(isSnowflake)) return fail('exclude', 'invalid_user');
            const users = [...new Set(exclude.users.map(String))];
            if (users.length > MAX_EXCLUDED_USERS) return fail('exclude', 'too_many_users');
            next.exclude.users = users;
        }
        fields.push('exclude');
    }

    if (fields.length === 0) return fail(null, 'nothing_to_save');
    return { ok: true, banner: next, fields };
}

module.exports = {
    MODES, LAYOUT_MODES, LAYOUTS, PERIODS, CALCS, BACKINGS, INTERVALS, MAX_BLUR, DEFAULTS,
    fromLegacy, toLegacy, resolveBanner, sanitizeBanner
};
