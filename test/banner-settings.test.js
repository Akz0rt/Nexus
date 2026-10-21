// Standalone test (no test framework configured): run with `node test/banner-settings.test.js`
// Banner settings per server, the old global settings carried over, the panel's save checks,
// the leaders' counting and exclusions, and voice time inside a rolling window.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const { resolveBanner, fromLegacy, toLegacy, sanitizeBanner, DEFAULTS } = require('../src/banner/settings');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const ActivityService = require('../src/services/ActivityService');
const VoiceActivityService = require('../src/services/VoiceActivityService');
const { windowSeconds } = require('../src/services/VoiceActivityService');
const { getLeaders } = require('../src/banner/leaders');
const config = require('../src/config');

function defaultsAndLegacy() {
    const fresh = resolveBanner(undefined);
    assert.strictEqual(fresh.enabled, false, 'a server never gets its banner changed until it is turned on');
    assert.deepStrictEqual(fresh.layouts, DEFAULTS.layouts);
    assert.strictEqual(fresh.period, '24h');
    assert.strictEqual(fresh.calc, 'combined');

    // The old bot's settings: «week» of «combined» → leader, 7 days; still off until turned on in the panel
    const legacy = resolveBanner(undefined, { BANNER_MODE: 'active', ACTIVITY_PERIOD: 'week', ACTIVITY_CALC_MODE: 'combined' });
    assert.deepStrictEqual([legacy.enabled, legacy.mode, legacy.period, legacy.calc], [false, 'leader', '7d', 'combined']);
    assert.strictEqual(resolveBanner(undefined, { BANNER_MODE: 'none' }).enabled, false);
    assert.strictEqual(resolveBanner(undefined, { ACTIVITY_PERIOD: 'month' }).period, '30d');
    assert.strictEqual(resolveBanner(undefined, { ACTIVITY_PERIOD: 'hour', ACTIVITY_CALC_MODE: 'text' }).calc, 'messages');
    assert.strictEqual(fromLegacy({ BANNER_MODE: 'birthday' }).autoBirthday, true);
    assert.strictEqual(fromLegacy({ OTHER: 1 }), null, 'no old banner settings → defaults');
    // Once saved, the old settings no longer count
    assert.strictEqual(resolveBanner({ period: '2h' }, { ACTIVITY_PERIOD: 'month' }).period, '2h');

    // Unknown values fall back
    const broken = resolveBanner({ mode: 'x', layouts: { leader: 'top' }, blur: 99, dim: 2, intervalMin: 7, exclude: { users: ['1', '123456789012345678'] } });
    assert.deepStrictEqual([broken.mode, broken.layouts.leader, broken.blur, broken.dim, broken.intervalMin], ['leader', 'left', 20, 0.85, 30]);
    assert.deepStrictEqual(broken.exclude.users, ['123456789012345678']);

    // The old dashboard reads the new values in its own terms
    assert.deepStrictEqual(toLegacy({ enabled: true, period: '24h', calc: 'messages' }), { mode: 'active', period: 'day', calcMode: 'text' });
    assert.deepStrictEqual(toLegacy({ enabled: false, period: '2h', calc: 'combined' }), { mode: 'none', period: 'hour', calcMode: 'combined' });
}

function onlyMainServerTakesLegacy() {
    const saved = config.guildId;
    config.guildId = 'main';
    try {
        const legacy = { BANNER_MODE: 'active', ACTIVITY_PERIOD: 'month' };
        assert.strictEqual(GuildSettingsService.resolve('main', null, legacy).banner.period, '30d');
        assert.strictEqual(GuildSettingsService.resolve('main', null, legacy).banner.enabled, false);
        assert.strictEqual(GuildSettingsService.resolve('other', null, legacy).banner.period, '24h', 'other servers never inherit the old settings');
        assert.strictEqual(GuildSettingsService.resolve('main', { banner: { period: '2h' } }, legacy).banner.period, '2h');
    } finally {
        config.guildId = saved;
    }
}

function panelSave() {
    const current = resolveBanner(undefined);
    const ok = sanitizeBanner({ enabled: true, layouts: { event: 'center' }, exclude: { admins: true }, blur: 12.4, period: '30d' }, current);
    assert.ok(ok.ok);
    assert.strictEqual(ok.banner.layouts.event, 'center');
    assert.strictEqual(ok.banner.layouts.leader, 'left', 'other layouts are kept');
    assert.strictEqual(ok.banner.exclude.admins, true);
    assert.strictEqual(ok.banner.exclude.bots, true, 'other exclusions are kept');
    assert.strictEqual(ok.banner.blur, 12);
    assert.deepStrictEqual(ok.fields.sort(), ['blur', 'enabled', 'exclude', 'layouts', 'period']);
    assert.strictEqual(current.layouts.event, 'right', 'the saved values are not changed in place');

    const bad = [
        [{ mode: 'birthday' }, 'mode'], [{ period: '3h' }, 'period'], [{ blur: 41 }, 'blur'], [{ dim: -0.1 }, 'dim'],
        [{ intervalMin: 5 }, 'intervalMin'], [{ layouts: { leader: 'top' } }, 'layouts'], [{ enabled: 'yes' }, 'enabled'],
        [{ exclude: { users: ['abc'] } }, 'exclude'], [{ autoEventHours: 25 }, 'autoEventHours']
    ];
    for (const [body, field] of bad) assert.strictEqual(sanitizeBanner(body, current).field, field, JSON.stringify(body));
    assert.strictEqual(sanitizeBanner({}, current).code, 'nothing_to_save');
    assert.strictEqual(sanitizeBanner({ backgroundBlobId: 'x' }, current).code, 'nothing_to_save', 'the background is set by its upload');
}

function voiceWindow() {
    const now = Date.parse('2026-10-21T13:30:00Z');
    const doc = { date: '2026-10-21', hours: { 11: 3600, 12: 3600, 13: 1800 }, durationSeconds: 9000, endedAt: now };
    // Last hour: half of 12:00–13:00 and all of 13:00–13:30
    assert.strictEqual(windowSeconds(doc, now - 3600000, now, 3600000), 1800 + 1800);
    assert.strictEqual(windowSeconds(doc, now - 2 * 3600000, now, 2 * 3600000), 1800 + 3600 + 1800);
    // A day counted before the hourly sums: only for windows of a day or more
    const old = { date: '2026-10-21', durationSeconds: 5000, endedAt: now - 600000 };
    assert.strictEqual(windowSeconds(old, now - 3600000, now, 3600000), 0, 'the old bug: a whole day counted as the last hour');
    assert.strictEqual(windowSeconds(old, now - 86400000, now, 86400000), 5000);
}

function fakeMember(id, { bot = false, admin = false } = {}) {
    return {
        id,
        displayName: `name-${id}`,
        user: { id, bot, displayAvatarURL: () => `https://cdn/${id}.png` },
        permissions: { has: flag => admin && (flag === PermissionFlagsBits.Administrator || flag === PermissionFlagsBits.KickMembers) }
    };
}

async function leaders() {
    const members = new Map([
        ['1', fakeMember('1', { bot: true })],
        ['2', fakeMember('2', { admin: true })],
        ['3', fakeMember('3')],
        ['4', fakeMember('4')],
        ['5', fakeMember('5')]
    ]);
    const guild = { id: 'g1', members: { cache: members, fetch: async () => { throw new Error('left'); } } };
    const calls = [];
    ActivityService.getTopUsersByRecentWindow = async (guildId, ms) => { calls.push(['text-window', guildId, ms]); return [
        { userId: '1', totalMessages: 900 }, { userId: '2', totalMessages: 800 }, { userId: '3', totalMessages: 100 },
        { userId: '9', totalMessages: 700 }, { userId: '4', totalMessages: 50 }, { userId: '5', totalMessages: 10 }
    ]; };
    VoiceActivityService.getTopUsersByRecentWindow = async (guildId, ms) => { calls.push(['voice-window', guildId, ms]); return [{ userId: '4', totalMinutes: 70 }]; };
    ActivityService.getTopUsersByPeriod = async (guildId, period) => { calls.push(['text-days', guildId, period]); return []; };
    VoiceActivityService.getTopUsersByPeriod = async (guildId, period) => { calls.push(['voice-days', guildId, period]); return []; };

    // Bots out by default; the admin counts unless excluded; «9» left the server
    let top = await getLeaders(guild, { period: '2h', calc: 'combined', exclude: { bots: true } });
    assert.deepStrictEqual(top.map(row => row.userId), ['2', '4', '3']);
    assert.deepStrictEqual([top[1].messages, top[1].minutes, top[1].score], [50, 70, 120]);
    assert.deepStrictEqual(calls.slice(0, 2), [['text-window', 'g1', 7200000], ['voice-window', 'g1', 7200000]]);

    top = await getLeaders(guild, { period: '2h', calc: 'messages', exclude: { bots: true, admins: true, yesterdayLeader: true, users: ['5'] }, yesterdayLeaderId: '3' });
    assert.deepStrictEqual(top.map(row => row.userId), ['4']);

    calls.length = 0;
    await getLeaders(guild, { period: '30d', calc: 'voice' });
    assert.deepStrictEqual(calls, [['voice-days', 'g1', 'month']], 'only voice is read for «Голос»');
}

(async () => {
    defaultsAndLegacy();
    onlyMainServerTakesLegacy();
    panelSave();
    voiceWindow();
    await leaders();
    console.log('banner-settings.test.js: all passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
