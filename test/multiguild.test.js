// Standalone test (no test framework configured): run with `node test/multiguild.test.js`
// Two servers side by side, one moderator on both: each server's birthdays, activity
// and settings stay its own; a server the user isn't on looks like one the bot isn't on;
// the live stream closes on logout or lost access and never names a hidden voice channel.

const assert = require('assert');
const { EventEmitter } = require('node:events');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '', maleRoleId: 'env-male', timezone: 'UTC' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const CosmosDBService = require('../src/services/CosmosDBService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const ActivityService = require('../src/services/ActivityService');
const VoiceActivityService = require('../src/services/VoiceActivityService');
const ActivitySyncService = require('../src/services/ActivitySyncService');
const { SseHub } = require('../src/web/v2/events');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const A = '900000000000000001';
const B = '900000000000000002';
const C = '900000000000000003'; // the moderator isn't on this one
const MOD = '100000000000000001';
const KIRA = '100000000000000002'; // a member of both servers

// Birthdays in memory, per server, the way Cosmos keeps them
const store = new Map(); // `${guildId}:${userId}` -> doc
CosmosDBService.getBirthday = async (guildId, userId) => store.get(`${guildId}:${userId}`) || null;
CosmosDBService.getAllBirthdays = async guildId => Object.fromEntries([...store]
    .filter(([key]) => key.startsWith(`${guildId}:`)).map(([key, doc]) => [key.split(':')[1], doc]));
CosmosDBService.setBirthday = async (guildId, userId, month, day) => { store.set(`${guildId}:${userId}`, { month, day, lastCongratulatedOn: store.get(`${guildId}:${userId}`)?.lastCongratulatedOn || null }); };
CosmosDBService.deleteBirthday = async (guildId, userId) => { store.delete(`${guildId}:${userId}`); };
CosmosDBService.wasCongratulatedOn = async (guildId, userId, date) => store.get(`${guildId}:${userId}`)?.lastCongratulatedOn === date;
CosmosDBService.markCongratulated = async (guildId, userId, date) => { store.get(`${guildId}:${userId}`).lastCongratulatedOn = date; };
CosmosDBService.getTodayDateString = () => '2026-10-20';

const activityAsked = [];
ActivityService.getTopUsersByPeriod = async guildId => { activityAsked.push(guildId); return [{ userId: KIRA, totalMessages: guildId === A ? 10 : 1 }]; };
ActivityService.getDailyTotals = async guildId => { activityAsked.push(guildId); return []; };
VoiceActivityService.getTopUsersByPeriod = async guildId => { activityAsked.push(guildId); return []; };
VoiceActivityService.getDailyTotals = async guildId => { activityAsked.push(guildId); return []; };
ActivitySyncService.getStatus = async guildId => ({ guildId });

const docs = {};
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, docs[guildId] || {});
GuildSettingsService.update = async (guildId, patch) => { docs[guildId] = { ...(docs[guildId] || {}), ...patch }; return docs[guildId]; };
AuditLogService.log = async entry => entry;
// Saving the timezone reschedules that server's birthday check: record it instead of a real cron job
const SchedulerService = require('../src/services/SchedulerService');
const scheduled = [];
SchedulerService.start = (guild, options) => scheduled.push({ guildId: guild.id, ...options });

function server(id) {
    const guild = makeGuild();
    guild.id = id;
    guild.iconURL = () => null;
    guild.roles.everyone = { id };
    makeMember(guild, KIRA, {});
    return guild;
}

function envDefaults() {
    // No GUILD_ID: Azure's values go to the lowest server id only, not to every server
    const resolvedA = GuildSettingsService.resolve(A, {});
    const resolvedB = GuildSettingsService.resolve(B, {});
    assert.strictEqual(resolvedA.maleRoleId, 'env-male');
    assert.strictEqual(resolvedB.maleRoleId, undefined, 'env must not leak to another server');
    assert.strictEqual(GuildSettingsService.mainGuildId(), A);
    assert.strictEqual(resolvedB.timezone, 'UTC');
    assert.strictEqual(GuildSettingsService.resolve(B, { timezone: 'Asia/Tokyo' }).timezone, 'Asia/Tokyo');
    assert.strictEqual(GuildSettingsService.resolve(B, { timezone: 'nowhere' }).timezone, 'UTC', 'a broken zone falls back');
}

async function routes(a, b) {
    PanelSessionService.get = async token => (token === 'tok' ? { userId: MOD, username: 'mod' } : null);
    const app = createApp().listen(0);
    await new Promise(resolve => app.once('listening', resolve));
    const call = async (guildId, method, path, body) => {
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/v2/guilds/${guildId}${path}`, {
            method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        // Kira's birthday on A: B doesn't see it, and can't change, delete or skip it
        await CosmosDBService.setBirthday(A, KIRA, 10, 20);
        assert.strictEqual((await call(A, 'GET', '/birthdays')).body.items.length, 1);
        assert.strictEqual((await call(B, 'GET', '/birthdays')).body.items.length, 0, 'B sees only its own list');
        assert.strictEqual((await call(B, 'DELETE', `/birthdays/${KIRA}`)).body.error, 'birthday_not_found');
        assert.strictEqual((await call(B, 'POST', `/birthdays/${KIRA}/skip`)).body.error, 'birthday_not_found');
        assert.strictEqual((await call(B, 'PUT', `/birthdays/${KIRA}`, { month: 1, day: 1 })).status, 200);
        assert.deepStrictEqual([store.get(`${A}:${KIRA}`).month, store.get(`${A}:${KIRA}`).day], [10, 20], 'A untouched');
        assert.deepStrictEqual([store.get(`${B}:${KIRA}`).month, store.get(`${B}:${KIRA}`).day], [1, 1]);
        assert.strictEqual((await call(B, 'POST', `/birthdays/${KIRA}/skip`)).status, 200);
        assert.strictEqual(store.get(`${A}:${KIRA}`).lastCongratulatedOn, null, 'skipping on B leaves A alone');
        assert.strictEqual((await call(B, 'DELETE', `/birthdays/${KIRA}`)).status, 200);
        assert.ok(store.has(`${A}:${KIRA}`), 'deleting on B leaves A alone');

        // Activity: every server reads only its own counts, and every server has them
        activityAsked.length = 0;
        const activityB = await call(B, 'GET', '/activity?period=week&mode=both');
        assert.strictEqual(activityB.body.supported, true);
        assert.ok(activityAsked.length > 0 && activityAsked.every(id => id === B), `asked for ${activityAsked}`);
        assert.strictEqual(activityB.body.top[0].messages, 1);
        assert.strictEqual(activityB.body.sync.guildId, B);

        // Settings of B don't change A
        assert.strictEqual((await call(B, 'PATCH', '/settings', { timezone: 'Asia/Tokyo' })).status, 200);
        assert.strictEqual((await call(A, 'GET', '/settings')).body.values.timezone, 'UTC');
        assert.deepStrictEqual(scheduled.map(s => [s.guildId, s.timezone]), [[B, 'Asia/Tokyo']], 'only B\'s check moved');

        // A server the moderator isn't on: the same answer as a server the bot isn't on
        const notMember = await call(C, 'GET', '/overview');
        const unknown = await call('900000000000000099', 'GET', '/overview');
        assert.deepStrictEqual([notMember.status, notMember.body], [unknown.status, unknown.body]);
        assert.strictEqual(notMember.body.error, 'guild_not_found');

        // The server list shows only servers where the moderator has panel rights
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/v2/guilds`, { headers: { Authorization: 'Bearer tok' } });
        assert.deepStrictEqual((await res.json()).guilds.map(g => g.id).sort(), [A, B]);
    } finally {
        app.closeAllConnections?.();
        app.close();
    }
}

async function liveStream() {
    const stream = () => {
        const res = new EventEmitter();
        res.frames = [];
        res.writeHead = () => {};
        res.write = chunk => res.frames.push(chunk);
        res.end = () => { res.ended = true; res.emit('close'); };
        return res;
    };
    const allowed = new Set(['tokA', 'tokB']);
    const bus = new EventEmitter();
    const hub = new SseHub({
        canSeeVoice: (guildId, userId, channelId) => !(channelId === 'hidden' && userId === 'peer'),
        authorize: async (guildId, userId, token) => allowed.has(token)
    }).attach(bus);
    const mod = stream();
    const peer = stream();
    const other = stream();
    hub.subscribe(A, mod, { id: 'mod' }, 'tokA');
    hub.subscribe(A, peer, { id: 'peer' }, 'tokB');
    hub.subscribe(B, other, { id: 'mod' }, 'tokA');
    assert.ok(!JSON.stringify(hub.presence(A)).includes('tok'), 'the token is never broadcast');

    // Someone joined a channel the peer can't see: the peer only learns the board changed
    bus.emit('voice', { guildId: A, userId: KIRA, channelId: 'hidden' });
    assert.ok(mod.frames.at(-1).includes('"channelId":"hidden"'));
    assert.strictEqual(peer.frames.at(-1), `event: voice\ndata: ${JSON.stringify({ guildId: A })}\n\n`);
    assert.ok(!other.frames.some(f => f.includes(KIRA)), 'another server never gets it');

    // Lost access (demoted, kicked, logged out elsewhere): closed at the next check
    allowed.delete('tokB');
    await hub.recheck();
    assert.strictEqual(peer.ended, true);
    assert.strictEqual(mod.ended, undefined);

    // Logout closes that session's streams on every server at once
    assert.strictEqual(hub.closeSession('tokA'), 2);
    assert.strictEqual(mod.ended, true);
    assert.strictEqual(other.ended, true);
    assert.strictEqual(hub.clients.size, 0);
    hub.stopHeartbeat();
}

(async () => {
    const a = server(A);
    const b = server(B);
    const c = server(C);
    // The moderator: Kick Members on A and B, not a member of C
    for (const guild of [a, b]) makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers || flag === PermissionFlagsBits.Administrator });
    for (const guild of [a, b, c]) {
        guild.channels.cache.set('t1', { id: 't1', name: 'text', type: ChannelType.GuildText, isTextBased: () => true });
        guild.members.me.roles = { highest: { position: 50 } };
        guild.memberCount = guild.members.cache.size;
    }
    state.client = { isReady: () => true, guilds: { cache: new Map([[A, a], [B, b], [C, c]]) } };

    envDefaults();
    await routes(a, b);
    await liveStream();
    console.log('multi-server isolation tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
