const crypto = require('crypto');
const { PermissionFlagsBits } = require('discord.js');

/**
 * Publishing the server banner: what to show now, whether it changed, building it and
 * uploading it to Discord, then history, state and the journal.
 *
 * Automatic publishing runs every minute per server with the banner on, and acts no more
 * often than the chosen interval. «Обновить сейчас» ignores the interval and «only if the
 * leader changed», but runs at most once a minute.
 */

const MANUAL_EVERY_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Kept leaders by day: today and yesterday are all «вчерашний лидер» needs
const LEADER_DAYS_KEPT = 3;

// Why the banner was not changed, for the panel's header and the diagnostics
const REASONS = {
    disabled: 'баннер выключен в настройках',
    interval: 'ещё не прошёл интервал обновления',
    unchanged: 'ничего не изменилось',
    no_data: 'нечего показать: нет активности или ивента — оставлен текущий баннер',
    no_background: 'фон не загружен',
    boost_level: 'баннер сервера доступен со 2-го уровня буста',
    missing_permission: 'у бота нет права «Управлять сервером»',
    too_soon: '«Обновить сейчас» — не чаще раза в минуту',
    busy: 'баннер уже собирается',
    rejected: 'Discord не принял баннер',
    failed: 'не удалось собрать баннер'
};

/** What identifies the card's content: who or what is on it (numbers left out) */
function identity(mode, data) {
    if (!data) return mode;
    if (mode === 'leader' || mode === 'birthday') return `${mode}:${data.user?.id}:${data.more || 0}`;
    if (mode === 'podium') return `${mode}:${(data.places || []).map(place => place.id).join(',')}`;
    if (mode === 'event') return `${mode}:${data.title}:${data.when}`;
    return mode;
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** The person (or event) the banner is about, for the history's caption */
function caption(mode, data) {
    if (mode === 'leader' || mode === 'birthday') return data?.user?.name || null;
    if (mode === 'podium') return data?.places?.[0]?.name || null;
    if (mode === 'event') return data?.title || null;
    return null;
}

function leaderOf(mode, data) {
    if (mode === 'leader') return data?.user?.id || null;
    if (mode === 'podium') return data?.places?.[0]?.id || null;
    return null;
}

/**
 * Discord's answer to an upload → our reason. 50013 = missing permissions,
 * 50035 = invalid form (no boost level for a banner, a file Discord won't take).
 */
function discordReason(error) {
    if (error?.code === 50013) return 'missing_permission';
    if (error?.code === 50035 && /BANNER|feature|premium/i.test(String(error?.message))) return 'boost_level';
    return 'rejected';
}

function createPublisher(deps) {
    const {
        store, settings: settingsService, collect, composeBanner, thumbnail, audit, dayKey,
        log = console
    } = deps;
    const running = new Set();

    /** What the banner should show now: { mode, layout, data } or { skip } */
    async function plan(guild, settings, state, now) {
        const banner = settings.banner;
        // On someone's birthday (the server's day) the birthday person; shortly before an
        // event (and while it goes on) the event; otherwise the chosen mode — so the banner
        // switches by itself and comes back
        if (banner.autoBirthday) {
            const data = await collect(guild, settings, 'birthday', { now });
            if (data) return { mode: 'birthday', layout: banner.layouts.birthday, data, auto: 'birthday' };
        }
        if (banner.autoEventHours > 0 && banner.mode !== 'event') {
            const data = await collect(guild, settings, 'event', { now });
            if (data?.startsAt && Date.parse(data.startsAt) - now <= banner.autoEventHours * HOUR_MS) {
                return { mode: 'event', layout: banner.layouts.event, data, auto: 'event' };
            }
        }
        const mode = banner.mode;
        if (mode === 'background') return { mode, layout: null, data: null };
        const yesterday = dayKey(now - DAY_MS, settings.timezone);
        const data = await collect(guild, settings, mode, { now, yesterdayLeaderId: state.leadersByDay?.[yesterday] || null });
        if (!data) return { skip: 'no_data' };
        return { mode, layout: banner.layouts[mode], data };
    }

    async function fail(guild, code, message = null, now = Date.now()) {
        await store.updateState(guild.id, { lastAttemptAt: new Date(now).toISOString(), lastError: { code, message: message || REASONS[code], at: new Date(now).toISOString() } });
        return { ok: false, code, message: message || REASONS[code] };
    }

    /**
     * @param {import('discord.js').Guild} guild
     * @param {{ manual?: boolean, actor?: { id, tag }, now?: number }} options
     * @returns {Promise<{ ok: true, entry, downgraded? } | { ok: false, code, message, skipped? }>}
     */
    async function publish(guild, { manual = false, actor = null, now = Date.now() } = {}) {
        if (running.has(guild.id)) return { ok: false, code: 'busy', message: REASONS.busy, skipped: true };
        running.add(guild.id);
        try {
            const settings = await settingsService.get(guild.id);
            const banner = settings.banner;
            if (!manual && !banner.enabled) return { ok: false, code: 'disabled', message: REASONS.disabled, skipped: true };

            const state = await store.getState(guild.id);
            if (manual && state.lastManualAt && now - Date.parse(state.lastManualAt) < MANUAL_EVERY_MS) {
                return { ok: false, code: 'too_soon', message: REASONS.too_soon, skipped: true };
            }
            if (!manual) {
                // The interval counts from the last try, so a failing server isn't retried every minute
                const last = Math.max(Date.parse(state.lastPublishedAt || 0) || 0, Date.parse(state.lastAttemptAt || 0) || 0);
                if (now - last < banner.intervalMin * 60 * 1000) return { ok: false, code: 'interval', message: REASONS.interval, skipped: true };
            }
            if (manual) await store.updateState(guild.id, { lastManualAt: new Date(now).toISOString() });

            if (!guild.features?.includes('BANNER')) return fail(guild, 'boost_level', null, now);
            if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return fail(guild, 'missing_permission', null, now);

            const background = await store.getBackground(guild.id);
            if (!background) return fail(guild, 'no_background', null, now);

            const planned = await plan(guild, settings, state, now);
            if (planned.skip) {
                // Nothing to show: the current banner stays, not an error
                await store.updateState(guild.id, { lastAttemptAt: new Date(now).toISOString(), lastSkip: planned.skip });
                return { ok: false, code: planned.skip, message: REASONS[planned.skip], skipped: true };
            }

            const look = { mode: planned.mode, layout: planned.layout, backing: banner.backing, blur: banner.blur, dim: banner.dim, backgroundId: background.meta.backgroundId };
            const key = hash({ ...look, who: identity(planned.mode, planned.data) });
            const full = hash({ ...look, data: planned.data });
            const same = banner.onlyOnChange ? key === state.lastKey : full === state.lastHash;
            if (!manual && same) {
                await store.updateState(guild.id, { lastAttemptAt: new Date(now).toISOString(), lastSkip: 'unchanged', lastError: null });
                return { ok: false, code: 'unchanged', message: REASONS.unchanged, skipped: true };
            }

            const animated = guild.features.includes('ANIMATED_BANNER') && background.meta.animated;
            let composed;
            try {
                composed = await composeBanner({
                    spec: { mode: planned.mode, layout: planned.layout, backing: banner.backing, blur: banner.blur, dim: banner.dim, data: planned.data },
                    background: background.buffer,
                    animated,
                    stillIfTooLarge: true
                });
            } catch (error) {
                log.error(`Banner: building for ${guild.id} failed:`, error.message || error);
                return fail(guild, 'failed', `${REASONS.failed}: ${error.code || error.message}`, now);
            }

            try {
                await guild.setBanner(`data:${composed.type};base64,${composed.buffer.toString('base64')}`, manual ? `Баннер обновлён вручную${actor?.tag ? ` (${actor.tag})` : ''}` : 'Баннер Nexus');
            } catch (error) {
                log.error(`Banner: Discord refused the banner of ${guild.id}:`, error.message || error);
                const code = discordReason(error);
                return fail(guild, code, code === 'rejected' ? `${REASONS.rejected}: ${error.message}` : null, now);
            }

            const thumb = await thumbnail(composed.buffer).catch(() => null);
            const leaderId = leaderOf(planned.mode, planned.data);
            const entry = await store.addHistory(guild.id, {
                buffer: composed.buffer, type: composed.type, thumbnail: thumb,
                mode: planned.mode, layout: planned.layout, backing: banner.backing, blur: banner.blur, dim: banner.dim,
                caption: caption(planned.mode, planned.data), leaderId, manual, actorId: actor?.id || null, auto: planned.auto || null,
                downgraded: composed.downgraded || null, createdAt: new Date(now).toISOString()
            });

            const today = dayKey(now, settings.timezone);
            const leadersByDay = { ...(state.leadersByDay || {}) };
            if (leaderId && !leadersByDay[today]) leadersByDay[today] = leaderId;
            for (const day of Object.keys(leadersByDay).sort().slice(0, -LEADER_DAYS_KEPT)) delete leadersByDay[day];
            const leaderSince = leaderId && leaderId === state.current?.leaderId ? state.current.leaderSince : new Date(now).toISOString();
            await store.updateState(guild.id, {
                lastPublishedAt: new Date(now).toISOString(), lastAttemptAt: new Date(now).toISOString(),
                lastKey: key, lastHash: full, lastError: null, lastSkip: null, leadersByDay,
                current: { historyId: entry.historyId, mode: planned.mode, leaderId, leaderSince: leaderId ? leaderSince : null, downgraded: composed.downgraded || null }
            });
            await audit.log({
                guildId: guild.id, action: 'banner.published', actorId: actor?.id || null, actorTag: actor?.tag || null,
                source: manual ? 'panel' : 'bot',
                details: { mode: planned.mode, auto: planned.auto || null, caption: entry.caption, type: composed.type, bytes: composed.bytes, downgraded: composed.downgraded || null }
            }).catch(error => log.error('Banner: journal entry failed:', error.message || error));
            return { ok: true, entry, downgraded: composed.downgraded || null };
        } finally {
            running.delete(guild.id);
        }
    }

    /** Put a banner from the history back on the server */
    async function restore(guild, historyId, { actor = null, now = Date.now() } = {}) {
        const entry = await store.getHistory(guild.id, historyId);
        if (!entry) return { ok: false, code: 'not_found' };
        const buffer = await store.readFile(guild.id, entry.file);
        if (!buffer) return { ok: false, code: 'not_found' };
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return fail(guild, 'missing_permission', null, now);
        try {
            await guild.setBanner(`data:${entry.type};base64,${buffer.toString('base64')}`, `Баннер возвращён из истории${actor?.tag ? ` (${actor.tag})` : ''}`);
        } catch (error) {
            const code = discordReason(error);
            return fail(guild, code, code === 'rejected' ? `${REASONS.rejected}: ${error.message}` : null, now);
        }
        await store.updateState(guild.id, {
            lastPublishedAt: new Date(now).toISOString(), lastError: null,
            current: { historyId: entry.historyId, mode: entry.mode, leaderId: entry.leaderId || null, leaderSince: new Date(now).toISOString(), restored: true }
        });
        await audit.log({
            guildId: guild.id, action: 'banner.restored', actorId: actor?.id || null, actorTag: actor?.tag || null,
            source: 'panel', details: { historyId: entry.historyId, caption: entry.caption || null, createdAt: entry.createdAt }
        }).catch(error => log.error('Banner: journal entry failed:', error.message || error));
        return { ok: true, entry };
    }

    return { publish, restore, plan };
}

function defaultPublisher() {
    return createPublisher({
        store: require('./store'),
        settings: require('../services/GuildSettingsService'),
        collect: require('./data').collect,
        dayKey: require('./data').dayKey,
        composeBanner: require('./compose').composeBanner,
        thumbnail: require('./compose').thumbnail,
        audit: require('../services/AuditLogService')
    });
}

let instance = null;
module.exports = {
    get publisher() {
        if (!instance) instance = defaultPublisher();
        return instance;
    },
    createPublisher,
    identity,
    discordReason,
    REASONS,
    MANUAL_EVERY_MS
};
