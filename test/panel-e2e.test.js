// Standalone test (no test framework configured): run with `node test/panel-e2e.test.js`
// End-to-end: the desktop app's ApiClient against the real Express app, with a fake
// Discord client and stubbed Cosmos. Covers guild routing, role checks, the queue
// handler and live events over a real SSE connection.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, {
    adminPassword: 'secret',
    clientId: '111',
    discordClientSecret: 'shh',
    publicUrl: 'https://panel.example'
});

const state = require('../src/state');
const EventBus = require('../src/services/EventBus');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const { createApp } = require('../src/server');
const { ApiClient } = require('../desktop/electron/api');

const SESSIONS = {
    'admin-token': { userId: 'mod', username: 'kira', createdAt: new Date().toISOString() },
    'user-token': { userId: 'plain', username: 'bob', createdAt: new Date().toISOString() }
};
PanelSessionService.get = async token => SESSIONS[token] || null;
GuildSettingsService.get = async guildId => ({
    guildId,
    unverifiedRoleId: 'unv',
    maleRoleId: 'male',
    femaleRoleId: 'female',
    verifyQueueChannelId: 'queue',
    modules: { verification: true }
});
QueueCardService.listPending = async () => [];
AuditLogService.query = async () => ({ items: [], cursor: null });

// --- fake Discord ---------------------------------------------------------------
function collection(entries) {
    const map = new Map(entries);
    map.filter = fn => collection([...map].filter(([, v]) => fn(v)));
    map.map = fn => [...map.values()].map(fn);
    return map;
}

function fakeMember(id, { roles = [], perms = [], joinedAt = '2026-10-16T10:00:00Z' } = {}) {
    const flags = new Set(perms);
    return {
        id,
        displayName: id,
        nickname: null,
        joinedAt: new Date(joinedAt),
        permissions: { has: flag => flags.has(flag) },
        roles: { cache: new Set(roles) },
        user: {
            bot: false,
            username: id,
            avatar: 'a',
            createdTimestamp: Date.parse('2024-01-01T00:00:00Z'),
            displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/a.png`
        }
    };
}

const members = collection([
    ['mod', fakeMember('mod', { perms: [PermissionFlagsBits.Administrator] })],
    ['plain', fakeMember('plain')],
    ['newbie', fakeMember('newbie', { roles: ['unv'] })]
]);
const guild = {
    id: 'g1',
    name: 'Test',
    memberCount: members.size,
    iconURL: () => null,
    members: { cache: members, fetch: async id => members.get(id) }
};
state.client = { isReady: () => true, guilds: { cache: new Map([['g1', guild]]) } };

async function run() {
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let unauthorized = 0;
    const admin = new ApiClient(base, () => 'admin-token', () => { unauthorized++; });
    const plain = new ApiClient(base, () => 'user-token', () => { unauthorized++; });

    try {
        // Guild list and queue through guildId routing + nested routers
        const { guilds } = await admin.request('GET', '/guilds');
        assert.deepStrictEqual(guilds.map(g => [g.id, g.panelRole]), [['g1', 'senior']]);

        const queue = await admin.request('GET', '/guilds/g1/queue?tab=waiting');
        assert.deepStrictEqual(queue.items.map(item => item.member.id), ['newbie']);
        assert.strictEqual(queue.items[0].card, null);

        // Role checks are server-side
        assert.deepStrictEqual((await plain.request('GET', '/guilds')).guilds, []);
        await assert.rejects(plain.request('GET', '/guilds/g1/queue'), err => err.status === 403);
        await assert.rejects(admin.request('GET', '/guilds/nope/queue'), err => err.status === 404);

        // Input validation on actions
        await assert.rejects(
            admin.request('POST', '/guilds/g1/queue/newbie/approve', { gender: 'other' }),
            err => err.status === 400 && err.message === 'invalid_gender'
        );

        // Live events: arrive for g1 only
        const received = [];
        const states = [];
        const presence = [];
        const stream = admin.stream('g1', (event, data) => {
            if (event === 'presence') presence.push(data.users.map(u => u.id));
            else received.push({ event, data });
        }, s => states.push(s));
        const deadline = Date.now() + 5000;
        while (!states.includes('open')) {
            if (Date.now() > deadline) throw new Error('stream never opened');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        EventBus.emit('audit', { guildId: 'g2', id: 'other' });
        EventBus.emit('audit', { guildId: 'g1', id: 'mine', action: 'verification.approved' });
        while (received.length === 0) {
            if (Date.now() > deadline) throw new Error('event never arrived');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepStrictEqual(received.map(r => r.data.id), ['mine']);
        assert.strictEqual(received[0].event, 'audit');
        assert.deepStrictEqual(presence[0], ['mod'], 'own presence is announced on connect');
        stream.close();

        assert.strictEqual(unauthorized, 0);
        console.log('PASS: desktop client ↔ API end-to-end (routing, roles, queue, live events)');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
