// Standalone test (no test framework configured): run with `node test/settings.test.js`
// Settings saves are validated and merged into the guild doc; the API is for
// administrators only; diagnostics report missing permissions and role order;
// moderator stats and upcoming birthdays are computed right.

const assert = require('assert');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const DiagnosticsService = require('../src/services/DiagnosticsService');
const { sanitize } = require('../src/web/v2/routes/settings');
const { buildStats } = require('../src/web/v2/routes/stats');
const { upcomingBirthdays } = require('../src/web/v2/routes/overview');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const MOD = '100000000000000002';
const UNV = '500000000000000001';
const MALE = '500000000000000002';
const FEMALE = '500000000000000003';
const QUEUE = '600000000000000001';
const VOICE = '600000000000000002';

const guild = makeGuild();
guild.iconURL = () => null;
for (const [id, name, position] of [[UNV, 'АНверефи', 1], [MALE, 'Парень', 2], [FEMALE, 'Девушка', 9]]) {
    guild.roles.cache.set(id, { id, name, position, managed: false, hexColor: '#123456' });
}
guild.channels.cache.set(QUEUE, { id: QUEUE, name: 'очередь', type: ChannelType.GuildText, rawPosition: 0, permissionsFor: () => ({ has: () => true }) });
guild.channels.cache.set(VOICE, { id: VOICE, name: 'голос', type: ChannelType.GuildVoice, rawPosition: 1 });
makeMember(guild, ADMIN, { position: 20, perms: flag => flag === PermissionFlagsBits.Administrator });
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
guild.memberCount = guild.members.cache.size;

let doc = {};
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, doc);
GuildSettingsService.update = async (guildId, patch) => { doc = { ...doc, ...patch }; return doc; };
const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };

async function validation() {
    const current = await GuildSettingsService.get(guild.id);
    assert.strictEqual(sanitize(guild, { unverifiedRoleId: '1' }, current).code, 'role_not_found');
    assert.strictEqual(sanitize(guild, { verifyQueueChannelId: VOICE }, current).code, 'channel_not_found', 'the queue needs a text channel');
    assert.strictEqual(sanitize(guild, { reasons: [] }, current).code, 'invalid_reasons');
    assert.strictEqual(sanitize(guild, { escalation: [{ warns: 2, action: 'timeout', durationMs: 123 }] }, current).code, 'invalid_escalation');
    assert.strictEqual(sanitize(guild, { escalation: [{ warns: 2, action: 'propose_ban' }, { warns: 2, action: 'propose_ban' }] }, current).code, 'duplicate_warns');
    assert.strictEqual(sanitize(guild, { slowmodeSeconds: 7 }, current).code, 'invalid_slowmode');
    assert.strictEqual(sanitize(guild, {}, current).code, 'nothing_to_save');

    const ok = sanitize(guild, {
        reasons: [' Флуд ', 'Флуд', 'Спам', ''],
        escalation: [{ warns: 5, action: 'propose_ban' }, { warns: 2, action: 'timeout', durationMs: 3600000 }],
        verificationEnabled: false
    }, current);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.patch.moderation.reasons, ['Флуд', 'Спам']);
    assert.deepStrictEqual(ok.patch.moderation.escalation.map(r => r.warns), [2, 5], 'rules sorted by warns');
    assert.strictEqual(ok.patch.modules.verification, false);
    assert.deepStrictEqual(ok.fields.sort(), ['escalation', 'reasons', 'verificationEnabled']);
}

async function diagnostics() {
    doc = { unverifiedRoleId: UNV, maleRoleId: MALE, femaleRoleId: FEMALE, verifyQueueChannelId: QUEUE, modules: { verification: true } };
    guild.members.me = {
        id: 'bot',
        roles: { highest: { position: 5 } },
        permissions: { has: flag => flag !== PermissionFlagsBits.ManageGuild && flag !== PermissionFlagsBits.Administrator }
    };
    guild.client = { options: { intents: { has: () => true } }, ws: { ping: 42 } };
    const result = await DiagnosticsService.run(guild, { database: async () => 7 });
    const bad = result.checks.filter(c => c.level === 'bad').map(c => c.label);
    assert.deepStrictEqual(bad, ['Управлять сервером', 'Роль «Девушка» ниже роли бота']);
    assert.ok(result.checks.some(c => c.group === 'lockdown' && c.level === 'warn'), 'no start channels → warning');
    assert.strictEqual(result.pingMs, 42);
    assert.strictEqual(result.dbMs, 7);

    const down = await DiagnosticsService.run(guild, { database: async () => { throw new Error('timeout'); } });
    assert.strictEqual(down.checks.find(c => c.label === 'База данных').level, 'bad');
}

async function api() {
    let session = { userId: MOD, username: 'mod' };
    PanelSessionService.get = async token => (token === 'tok' ? session : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        assert.strictEqual((await call('GET', '/settings')).status, 403, 'moderators without Administrator get no settings');
        assert.strictEqual((await call('POST', '/lockdown/on')).status, 403);

        session = { userId: ADMIN, username: 'admin' };
        const read = await call('GET', '/settings');
        assert.strictEqual(read.status, 200);
        assert.deepStrictEqual(read.body.options.textChannels.map(c => c.id), [QUEUE]);
        assert.strictEqual(read.body.options.roles.find(r => r.id === FEMALE).belowBot, false);

        const saved = await call('PATCH', '/settings', { lockdownChannelIds: [QUEUE], slowmodeSeconds: 60 });
        assert.strictEqual(saved.status, 200);
        assert.deepStrictEqual(saved.body.values.lockdownChannelIds, [QUEUE]);
        assert.strictEqual(saved.body.values.slowmodeSeconds, 60);
        assert.strictEqual(doc.unverifiedRoleId, UNV, 'other settings untouched');
        assert.strictEqual(logged.at(-1).action, 'settings.updated');
        const refused = await call('PATCH', '/settings', { slowmodeSeconds: 7 });
        assert.deepStrictEqual([refused.status, refused.body.error, refused.body.field], [400, 'invalid_slowmode', 'slowmodeSeconds']);
    } finally {
        server.close();
    }
}

function stats() {
    const hour = 3600000;
    const t0 = Date.parse('2026-10-17T10:00:00Z');
    const result = buildStats(
        [
            { actorId: 'kira', action: 'verification.approved', n: 5 },
            { actorId: 'kira', action: 'voice.moved', n: 2 },
            { actorId: 'kira', action: 'voice.squad_saved', n: 9 },
            { actorId: 'bob', action: 'moderation.muted', n: 1 },
            { actorId: 'author', action: 'message.edited', n: 50 }
        ],
        [
            { handledBy: 'kira', createdAt: new Date(t0).toISOString(), handledAt: new Date(t0 + hour).toISOString() },
            { handledBy: 'kira', createdAt: new Date(t0).toISOString(), handledAt: new Date(t0 + 3 * hour).toISOString() },
            { handledBy: 'bob', createdAt: new Date(t0).toISOString(), handledAt: new Date(t0 + 5 * hour).toISOString() }
        ]
    );
    assert.deepStrictEqual(result.moderators.map(m => m.actorId), ['kira', 'bob'], 'message authors are not moderators');
    const kira = result.moderators[0];
    assert.deepStrictEqual([kira.approved, kira.voice, kira.total, kira.decided, kira.averageWaitMs], [5, 2, 7, 2, 2 * hour]);
    assert.deepStrictEqual([result.queue.decided, result.queue.averageWaitMs, result.queue.medianWaitMs], [3, 3 * hour, 3 * hour]);
}

function birthdays() {
    const today = new Date();
    const inDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return { month: d.getMonth() + 1, day: d.getDate() }; };
    const list = upcomingBirthdays(guild, { [ADMIN]: inDays(3), [MOD]: inDays(0), '999': inDays(1), [UNV]: inDays(20) });
    assert.deepStrictEqual(list.map(b => [b.id, b.inDays]), [[MOD, 0], [ADMIN, 3]], 'only members, next 7 days, soonest first');
}

(async () => {
    await validation();
    await diagnostics();
    await api();
    stats();
    birthdays();
    console.log('settings tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
