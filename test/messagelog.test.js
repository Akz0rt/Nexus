// Standalone test (no test framework configured): run with `node test/messagelog.test.js`
// Deleted/edited message log: what gets logged, who deleted (from Discord's audit
// log), purges as one entry, and that message texts reach only moderators who can
// read the channel — in the journal API, the member card and the live stream.
// Also: the /roles screen API is for Manage Roles only, and the AI answers only when addressed.

const assert = require('assert');
const { EventEmitter } = require('node:events');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const WarningService = require('../src/modules/moderation/WarningService');
const TempRoleService = require('../src/modules/roles/TempRoleService');
const messagelog = require('../src/modules/messagelog');
const { isAddressedToBot } = require('../src/modules/ai');
const { SseHub } = require('../src/web/v2/events');
const { canSeeEntry } = require('../src/web/v2/visibility');
const { buildAuditQuery } = require('../src/services/AuditLogService');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const PEER = '100000000000000002';
const AUTHOR = '200000000000000001';
const OPEN = '600000000000000001';
const STAFF = '600000000000000002';

const guild = makeGuild();
const textChannel = (id, name, readable) => {
    const channel = {
        id, name, guild,
        permissionsFor: member => ({ has: flag => readable(member.id) || ![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory].includes(flag) })
    };
    guild.channels.cache.set(id, channel);
    return channel;
};
const open = textChannel(OPEN, 'общий', () => true);
const staff = textChannel(STAFF, 'админская', id => id === MOD);
// MOD: manages roles, reads #админская. PEER: kicks only, can't read it
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.ManageRoles });
makeMember(guild, PEER, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
makeMember(guild, AUTHOR, {});
guild.memberCount = guild.members.cache.size;
guild.iconURL = () => null;

let logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };

function message({ id = 'm1', content = 'привет', channel = open, bot = false, attachments = [] } = {}) {
    return {
        id,
        guild,
        channel,
        channelId: channel.id,
        content,
        partial: false,
        system: false,
        author: { id: AUTHOR, bot, tag: 'author', username: 'author' },
        attachments: new Collection(attachments.map((name, i) => [String(i), { name }])),
        createdAt: new Date('2026-10-17T10:00:00Z'),
        url: `https://discord.com/channels/${guild.id}/${channel.id}/${id}`
    };
}

async function logging() {
    // No View Audit Log: no lookup, no delay
    guild.members.me.permissions = { has: flag => flag !== PermissionFlagsBits.ViewAuditLog };
    logged = [];
    await messagelog.onDelete(message({ content: 'секрет', attachments: ['фото.png'] }));
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].action, 'message.deleted');
    assert.strictEqual(logged[0].actorId, null);
    assert.deepStrictEqual(logged[0].targetIds, [AUTHOR]);
    assert.strictEqual(logged[0].details.content, 'секрет');
    assert.deepStrictEqual(logged[0].details.attachments, ['фото.png']);
    assert.strictEqual(logged[0].details.channelId, OPEN);

    logged = [];
    await messagelog.onDelete(message({ bot: true }));
    await messagelog.onDelete({ ...message(), partial: true });
    await messagelog.onDelete(message({ content: '' }));
    assert.strictEqual(logged.length, 0, 'bots, unknown and empty messages are skipped');

    await messagelog.onDelete(message({ content: 'x'.repeat(2500) }));
    assert.strictEqual(logged[0].details.content.length, 2001);

    logged = [];
    await messagelog.onEdit(message({ content: 'было' }), message({ content: 'было' }));
    assert.strictEqual(logged.length, 0, 'an embed loading in is not an edit');
    await messagelog.onEdit(message({ content: 'было' }), message({ content: 'стало' }));
    assert.deepStrictEqual([logged[0].action, logged[0].details.content, logged[0].details.newContent, logged[0].actorId],
        ['message.edited', 'было', 'стало', AUTHOR]);

    logged = [];
    const purged = new Collection([['1', message({ id: '1' })], ['2', message({ id: '2' })], ['3', message({ id: '3', bot: true })]]);
    await messagelog.onBulkDelete(purged, open);
    assert.strictEqual(logged.length, 1);
    assert.deepStrictEqual([logged[0].action, logged[0].details.count, logged[0].targetIds], ['message.bulk_deleted', 3, [AUTHOR]]);
    assert.strictEqual(logged[0].details.content, undefined, 'purges keep no texts');
}

async function whoDeleted() {
    guild.members.me.permissions = { has: () => true };
    const now = Date.now();
    const entries = [
        // An old merged entry: the same moderator deleted this author's message minutes ago
        { id: 'e-old', target: { id: AUTHOR }, extra: { channel: { id: OPEN }, count: 1 }, createdTimestamp: now - 5 * 60 * 1000, executor: { id: PEER, tag: 'peer' } }
    ];
    guild.fetchAuditLogs = async () => ({ entries: new Collection(entries.map(e => [e.id, e])) });

    // First look: the old entry is only remembered, the author deleted it themselves
    let found = await messagelog.findDeleter(guild, 72, e => e.target.id === AUTHOR);
    assert.strictEqual(found, null);
    // Discord bumps the count: the moderator deleted another one
    entries[0].extra.count = 2;
    found = await messagelog.findDeleter(guild, 72, e => e.target.id === AUTHOR);
    assert.strictEqual(found.id, PEER);
    // Unchanged count again: not them
    found = await messagelog.findDeleter(guild, 72, e => e.target.id === AUTHOR);
    assert.strictEqual(found, null);
    // A brand-new entry counts at once
    entries.push({ id: 'e-new', target: { id: AUTHOR }, extra: { channel: { id: OPEN }, count: 1 }, createdTimestamp: Date.now(), executor: { id: MOD, tag: 'mod' } });
    found = await messagelog.findDeleter(guild, 72, e => e.target.id === AUTHOR);
    assert.strictEqual(found.id, MOD);
}

function visibility() {
    const mod = guild.members.cache.get(MOD);
    const peer = guild.members.cache.get(PEER);
    const inStaff = { action: 'message.deleted', details: { channelId: STAFF } };
    assert.strictEqual(canSeeEntry(guild, mod, inStaff), true);
    assert.strictEqual(canSeeEntry(guild, peer, inStaff), false);
    assert.strictEqual(canSeeEntry(guild, peer, { action: 'message.edited', details: { channelId: OPEN } }), true);
    assert.strictEqual(canSeeEntry(guild, peer, { action: 'moderation.muted', details: {} }), true);
    // Channel deleted since: administrators only
    assert.strictEqual(canSeeEntry(guild, peer, { action: 'message.deleted', details: { channelId: '1' } }), false);

    // Live stream: the staff-channel entry reaches only MOD's stream
    const bus = new EventEmitter();
    const hub = new SseHub({ canSee: (guildId, userId, entry) => canSeeEntry(guild, guild.members.cache.get(userId), entry) }).attach(bus);
    const stream = () => {
        const res = new EventEmitter();
        res.frames = [];
        res.writeHead = () => {};
        res.write = chunk => res.frames.push(chunk);
        return res;
    };
    const modStream = stream();
    const peerStream = stream();
    hub.subscribe(guild.id, modStream, { id: MOD });
    hub.subscribe(guild.id, peerStream, { id: PEER });
    bus.emit('audit', { guildId: guild.id, ...inStaff });
    bus.emit('audit', { guildId: guild.id, action: 'roles.added', details: {} });
    const audits = res => res.frames.filter(f => f.startsWith('event: audit')).length;
    assert.strictEqual(audits(modStream), 2);
    assert.strictEqual(audits(peerStream), 1);
    bus.emit('job', { guildId: guild.id, status: 'running' });
    assert.ok(peerStream.frames.at(-1).startsWith('event: job'));
    hub.stopHeartbeat();
}

function groupFilter() {
    const query = buildAuditQuery({ guildId: 'g', action: 'message.*' });
    assert.ok(query.query.includes('STARTSWITH(c.action, @action)'));
    assert.deepStrictEqual(query.parameters.find(p => p.name === '@action').value, 'message.');
}

function aiAddressing() {
    const botId = '999';
    const msg = (mentions, reply) => ({
        reference: reply ? { messageId: 'x' } : null,
        mentions: { users: new Collection(mentions.map(id => [id, {}])), repliedUser: reply ? { id: reply } : null }
    });
    assert.strictEqual(isAddressedToBot(msg([botId]), botId), true);
    assert.strictEqual(isAddressedToBot(msg([], botId), botId), true);
    assert.strictEqual(isAddressedToBot(msg([]), botId), false);
    assert.strictEqual(isAddressedToBot(msg(['123'], '123'), botId), false);
}

async function api() {
    const entries = [
        { id: '1', guildId: guild.id, action: 'message.deleted', targetIds: [AUTHOR], details: { channelId: STAFF, content: 'секрет' } },
        { id: '2', guildId: guild.id, action: 'message.deleted', targetIds: [AUTHOR], details: { channelId: OPEN, content: 'привет' } },
        { id: '3', guildId: guild.id, action: 'moderation.warned', targetIds: [AUTHOR], details: {} }
    ];
    AuditLogService.query = async () => ({ items: entries, cursor: 'next' });
    QueueCardService.get = async () => null;
    WarningService.listActive = async () => [];
    TempRoleService.listForUser = async () => [];
    let session = { userId: PEER, username: 'peer' };
    PanelSessionService.get = async token => (token === 'tok' ? session : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };

    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path) => {
        const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer tok' } });
        return { status: res.status, body: await res.json() };
    };
    try {
        const journal = await call('GET', '/audit');
        assert.deepStrictEqual(journal.body.items.map(e => e.id), ['2', '3'], 'no text from #админская for PEER');
        assert.strictEqual(journal.body.cursor, 'next', 'a short page still offers more');
        const card = await call('GET', `/members/${AUTHOR}`);
        assert.deepStrictEqual(card.body.history.map(e => e.id), ['2', '3']);
        assert.strictEqual(card.body.moderation.can.roles, false);
        assert.strictEqual((await call('GET', '/roles')).status, 403, 'the roles screen needs Manage Roles');
        assert.strictEqual((await call('GET', '/roles/presets')).status, 403);
        const guilds = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/guilds`, { headers: { Authorization: 'Bearer tok' } }).then(r => r.json());
        assert.strictEqual(guilds.guilds[0].can.roles, false);

        session = { userId: MOD, username: 'mod' };
        assert.deepStrictEqual((await call('GET', '/audit')).body.items.map(e => e.id), ['1', '2', '3']);
        const roles = await call('GET', '/roles');
        assert.strictEqual(roles.status, 200);
        assert.deepStrictEqual(roles.body.items, []);
        assert.strictEqual(roles.body.job, null);
    } finally {
        server.close();
    }
}

(async () => {
    await logging();
    await whoDeleted();
    visibility();
    groupFilter();
    aiAddressing();
    await api();
    console.log('message log tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
