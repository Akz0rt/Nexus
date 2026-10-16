// Standalone test (no test framework configured): run with `node test/moderation-routes.test.js`
// Runs the real Express app against a fake guild and checks the /moderation API:
// actions map to the service, errors map to HTTP codes, lists come back shaped for the app.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const WarningService = require('../src/modules/moderation/WarningService');
const TempBanService = require('../src/modules/moderation/TempBanService');
const { DEFAULT_REASONS, DEFAULT_ESCALATION } = require('../src/modules/moderation/templates');
const { createApp } = require('../src/server');

const MOD_ID = '100000000000000001';
const USER_ID = '200000000000000002';
const PEER_ID = '300000000000000003';

PanelSessionService.get = async token => (token === 'tok' ? { userId: MOD_ID, username: 'mod' } : null);
GuildSettingsService.get = async guildId => ({
    guildId, moderation: { reasons: DEFAULT_REASONS, escalation: DEFAULT_ESCALATION }
});
AuditLogService.log = async entry => entry;
AuditLogService.query = async () => ({ items: [], cursor: null });

let warns = [];
WarningService.add = async warn => {
    const doc = { ...warn, id: `w${warns.length + 1}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e9).toISOString() };
    warns.push(doc);
    return doc;
};
WarningService.listActive = async (guildId, userId) => warns.filter(w => !userId || w.userId === userId);
WarningService.get = async (guildId, id) => warns.find(w => w.id === id) || null;
WarningService.remove = async (guildId, id) => { warns = warns.filter(w => w.id !== id); return true; };
TempBanService.list = async () => [];

function makeMember(id, position) {
    const member = {
        id,
        displayName: `name-${id}`,
        joinedAt: new Date(),
        user: {
            id, username: `user-${id}`, bot: false, createdTimestamp: Date.now() - 1e10,
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
            send: async () => {}
        },
        roles: { highest: { position } },
        permissions: { has: flag => position >= 10 && flag !== PermissionFlagsBits.Administrator },
        moderatable: true,
        communicationDisabledUntilTimestamp: null,
        timeout: async ms => { member.communicationDisabledUntilTimestamp = ms ? Date.now() + ms : null; }
    };
    return member;
}

const members = new Collection([
    [MOD_ID, makeMember(MOD_ID, 10)],
    [USER_ID, makeMember(USER_ID, 1)],
    [PEER_ID, makeMember(PEER_ID, 10)]
]);
const guild = {
    id: '900000000000000009',
    name: 'Test',
    ownerId: 'owner',
    memberCount: members.size,
    members: {
        cache: members,
        fetch: async arg => {
            const member = members.get(typeof arg === 'string' ? arg : arg.user);
            if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
            return member;
        }
    },
    client: { channels: { fetch: async () => ({ send: async () => {} }) } }
};
state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };

async function run() {
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}/moderation`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, body: await res.json() };
    };

    try {
        const options = await call('GET', '/options');
        assert.strictEqual(options.status, 200);
        assert.deepStrictEqual(options.body.reasons, DEFAULT_REASONS);
        assert.deepStrictEqual(options.body.muteDurations.map(d => d.id), ['10m', '1h', '6h', '1d', '7d']);

        const warned = await call('POST', `/${USER_ID}/warn`, { reason: 'Флуд' });
        assert.strictEqual(warned.status, 200);
        assert.strictEqual(warned.body.activeCount, 1);

        assert.strictEqual((await call('POST', `/${USER_ID}/warn`, {})).status, 400);
        assert.strictEqual((await call('POST', `/${PEER_ID}/warn`, { reason: 'Флуд' })).body.error, 'target_higher');
        assert.strictEqual((await call('POST', `/${PEER_ID}/warn`, { reason: 'Флуд' })).status, 403);
        assert.strictEqual((await call('POST', `/${USER_ID}/mute`, { duration: '2h', reason: 'x' })).status, 400);
        assert.strictEqual((await call('POST', `/${USER_ID}/constructor`)).status, 404);
        assert.strictEqual((await call('POST', '/not-an-id/warn', { reason: 'x' })).status, 400);

        const muted = await call('POST', `/${USER_ID}/mute`, { duration: '1h', reason: 'Флуд' });
        assert.strictEqual(muted.status, 200);
        const active = await call('GET', '/active');
        assert.deepStrictEqual(active.body.mutes.map(m => m.member.id), [USER_ID]);

        const list = await call('GET', '/warnings');
        assert.strictEqual(list.body.items.length, 1);
        assert.strictEqual(list.body.items[0].user.displayName, `name-${USER_ID}`);
        assert.strictEqual(list.body.items[0].activeCount, 1);

        assert.strictEqual((await call('DELETE', `/warnings/${list.body.items[0].id}`)).status, 200);
        assert.strictEqual((await call('DELETE', '/warnings/w404')).status, 404);

        console.log('PASS: moderation API');
    } finally {
        server.close();
    }
}

run().catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
});
