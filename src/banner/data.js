const CosmosDBService = require('../services/CosmosDBService');
const EventService = require('../modules/events/EventService');
const { getLeaders } = require('./leaders');
const { person } = require('./avatars');

const DAY_MS = 24 * 60 * 60 * 1000;
// The panel's preview asks again on every slider move: the counts stay a minute
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    return value;
}

function dayKey(ts, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/** «СЕГОДНЯ · 21:00», «ЗАВТРА · 21:00», «24 ОКТ. · 21:00» in the server's timezone */
function eventWhen(startsAt, timeZone, now = Date.now()) {
    const ts = Date.parse(startsAt);
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
    const day = dayKey(ts, timeZone);
    if (ts <= now) return `ИДЁТ · С ${time}`;
    if (day === dayKey(now, timeZone)) return `СЕГОДНЯ · ${time}`;
    if (day === dayKey(now + DAY_MS, timeZone)) return `ЗАВТРА · ${time}`;
    const date = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'short' }).format(new Date(ts));
    return `${date} · ${time}`.toUpperCase();
}

async function leaderData(guild, banner, limit, yesterdayLeaderId = null) {
    return cached(`${guild.id}:${banner.period}:${banner.calc}:${JSON.stringify(banner.exclude)}:${limit}:${yesterdayLeaderId}`,
        () => getLeaders(guild, { period: banner.period, calc: banner.calc, exclude: banner.exclude, yesterdayLeaderId, limit }));
}

/**
 * What the card shows for a mode on this server right now, or null when there is
 * nothing to show (no activity, no birthday, no upcoming event).
 * @param {import('discord.js').Guild} guild
 * @param {object} settings - GuildSettingsService.get() result
 * @param {'leader'|'podium'|'birthday'|'event'} mode
 */
async function collect(guild, settings, mode, { now = Date.now(), yesterdayLeaderId = null } = {}) {
    const banner = settings.banner;
    if (mode === 'leader') {
        const [top] = await leaderData(guild, banner, 1, yesterdayLeaderId);
        if (!top) return null;
        return {
            // No status line for now (it would need the Presence intent)
            user: await person(top.member),
            messages: top.messages, minutes: top.minutes, calc: banner.calc, period: banner.period
        };
    }
    if (mode === 'podium') {
        const top = await leaderData(guild, banner, 3, yesterdayLeaderId);
        if (!top.length) return null;
        return { period: banner.period, places: await Promise.all(top.map(row => person(row.member, { score: row.score }))) };
    }
    if (mode === 'birthday') {
        const rows = await CosmosDBService.getTodaysBirthdays(guild.id, settings.timezone);
        const members = [];
        for (const { userId } of rows) {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
            if (member) members.push(member);
        }
        if (!members.length) return null;
        const channelId = settings.birthdayCongratsChannelId || settings.birthdayAnnounceChannelId;
        return {
            user: await person(members[0]),
            more: members.length - 1,
            channelName: (channelId && guild.channels.cache.get(channelId)?.name) || null
        };
    }
    if (mode === 'event') {
        const events = await EventService.list(guild.id, 'upcoming', now);
        const next = events.find(event => event.status === 'scheduled') || events[0];
        if (!next) return null;
        const going = (next.going || []).map(id => guild.members.cache.get(id)).filter(Boolean);
        return {
            title: next.title,
            startsAt: next.startsAt,
            when: eventWhen(next.startsAt, settings.timezone, now),
            host: guild.members.cache.get(next.createdBy)?.displayName || null,
            place: (next.voiceChannelId && guild.channels.cache.get(next.voiceChannelId)?.name) || null,
            attendees: await Promise.all(going.slice(0, 4).map(member => person(member))),
            count: (next.going || []).length
        };
    }
    return null;
}

/** The mockup's data: the preview shows it (marked as an example) when the server has nothing yet */
function sampleData(mode, banner) {
    const maks = { id: '7', name: 'maks_lil' };
    const vika = { id: '1', name: 'Вика' };
    const grisha = { id: '2', name: 'Гриша' };
    return {
        leader: { user: maks, messages: 1240, minutes: 380, calc: banner.calc, period: banner.period },
        podium: { period: banner.period, places: [{ ...maks, score: 8420 }, { ...vika, score: 7910 }, { ...grisha, score: 6340 }] },
        birthday: { user: vika, channelName: 'поздравления' },
        event: {
            title: 'Мафия', when: 'СЕГОДНЯ · 21:00', host: 'Kira', place: 'Мафия — лобби', count: 6,
            attendees: [{ id: '2', name: 'А' }, { id: '1', name: 'Б' }, { id: '7', name: 'В' }, { id: '3', name: 'Г' }]
        }
    }[mode];
}

module.exports = { collect, sampleData, eventWhen, dayKey };
