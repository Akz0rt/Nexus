// Standalone test (no test framework configured): run with `node test/queue-routes.test.js`
// What the redesigned queue screen gets from the API: risk flags as objects, the
// invite, today's counts and the young-account threshold; «Смотрит Kira» reaching
// the live stream; the threshold saved from Settings.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const BoosterPassService = require('../src/modules/boosters/BoosterPassService');
BoosterPassService.list = async () => [];
const InviteTracker = require('../src/modules/invites/InviteTracker');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const KIRA = '100000000000000002';
const NEWBIE = '300000000000000001';
const OLD = '300000000000000002';
const INVITER = '300000000000000003';
const UNV = '400000000000000001';
const DAY = 24 * 60 * 60 * 1000;

let doc = { unverifiedRoleId: UNV, maleRoleId: '400000000000000002', femaleRoleId: '400000000000000003', verifyQueueChannelId: '500000000000000001', modules: { verification: true } };
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, doc);
GuildSettingsService.update = async (guildId, patch) => { doc = { ...doc, ...patch }; return doc; };
AuditLogService.log = async entry => entry;
QueueCardService.listPending = async () => [
    { guildId: 'g', userId: NEWBIE, status: 'pending', kickCount: 2, invite: { code: 'abc', inviterId: INVITER, vanity: false } },
    { guildId: 'g', userId: OLD, status: 'pending', kickCount: 0 }
];
QueueCardService.listHandled = async () => [{ status: 'approved' }, { status: 'approved' }, { status: 'kicked' }];

const guild = makeGuild();
guild.iconURL = () => null;
makeMember(guild, ADMIN, { position: 10, perms: flag => flag === PermissionFlagsBits.Administrator });
makeMember(guild, KIRA, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
const newbie = makeMember(guild, NEWBIE, { roleIds: [UNV] });
newbie.user.createdTimestamp = Date.now() - 2 * DAY;
makeMember(guild, OLD, { roleIds: [UNV] }).user.avatar = 'abc';
makeMember(guild, INVITER);
guild.memberCount = guild.members.cache.size;

/** Read SSE frames until one matches (or give up). */
async function waitForFrame(reader, test, timeoutMs = 3000) {
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null, done: false }), 200))]);
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        const frame = buffer.split('\n\n').find(test);
        if (frame) return frame;
    }
    return null;
}

(async () => {
    let session = { userId: ADMIN, username: 'admin' };
    PanelSessionService.get = async token => (token === 'tok' ? session : token === 'kira' ? { userId: KIRA, username: 'kira' } : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body, token = 'tok') => {
        const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    const streams = [];
    try {
        const queue = await call('GET', '/queue?tab=waiting');
        assert.strictEqual(queue.status, 200, JSON.stringify(queue.body));
        assert.deepStrictEqual(queue.body.counts, { handled: 2, rejected: 1, boosters: 0 });
        assert.strictEqual(queue.body.youngAccountDays, 7);
        assert.strictEqual(typeof queue.body.invitesTracked, 'boolean');
        const byId = Object.fromEntries(queue.body.items.map(item => [item.member.id, item]));
        assert.deepStrictEqual(byId[NEWBIE].member.flags.map(f => f.code), ['young', 'kicked', 'no_avatar']);
        assert.deepStrictEqual(byId[NEWBIE].member.flags[1], { code: 'kicked', label: 'кикали 2 раза', tone: 'danger' });
        assert.deepStrictEqual(byId[NEWBIE].invite, { code: 'abc', vanity: false, inviter: { id: INVITER, displayName: `name-${INVITER}`, avatarURL: 'https://cdn.discordapp.com/embed/avatars/0.png' } });
        assert.deepStrictEqual(byId[OLD].member.flags, [], 'an old account with an avatar is clean');
        assert.strictEqual(byId[OLD].invite, null, 'no invite known');
        // Just joined: the card has no invite yet, the tracker's memory fills in
        InviteTracker.remember(guild.id, OLD, { code: null, inviterId: null, vanity: true });
        assert.deepStrictEqual((await call('GET', '/queue?tab=waiting')).body.items.find(i => i.member.id === OLD).invite, { code: null, vanity: true, inviter: null });

        // «Смотрит Kira»: Kira opens a card, the admin's stream hears it
        const res = await fetch(`${base}/events`, { headers: { Authorization: 'Bearer tok' } });
        const reader = res.body.getReader();
        streams.push(reader);
        const kiraStream = await fetch(`${base}/events`, { headers: { Authorization: 'Bearer kira' } });
        streams.push(kiraStream.body.getReader());
        assert.strictEqual((await call('POST', '/presence/viewing', { userId: NEWBIE }, 'kira')).status, 200);
        const frame = await waitForFrame(reader, f => f.includes(`"viewingId":"${NEWBIE}"`));
        assert.ok(frame, 'the presence frame carries whose card Kira has open');
        assert.strictEqual((await call('POST', '/presence/viewing', { userId: 'nope' }, 'kira')).status, 400);

        // The threshold is a Settings field
        const saved = await call('PATCH', '/settings', { youngAccountDays: 1 });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(saved.body.values.youngAccountDays, 1);
        assert.deepStrictEqual((await call('GET', '/queue?tab=waiting')).body.items.find(i => i.member.id === NEWBIE).member.flags.map(f => f.code),
            ['kicked', 'no_avatar'], 'a 2-day-old account is no longer «new» at 1 day');
        assert.strictEqual((await call('PATCH', '/settings', { youngAccountDays: 0 })).body.error, 'invalid_young_days');
        console.log('queue route tests passed');
    } finally {
        for (const reader of streams) await reader.cancel().catch(() => {});
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
