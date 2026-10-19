// Standalone test (no test framework configured): run with `node test/member-card.test.js`
// The member card: time in the voice channel, last activity, birthday, why a role is locked;
// moderator notes (everyone reads, the author or an administrator deletes, no text in the
// journal); «Сменить ник…» with its permission and hierarchy checks.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const ActivityService = require('../src/services/ActivityService');
const CosmosDBService = require('../src/services/CosmosDBService');
const WarningService = require('../src/modules/moderation/WarningService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const TempRoleService = require('../src/modules/roles/TempRoleService');
const VoiceService = require('../src/modules/voice/VoiceService');
const MemberNoteService = require('../src/modules/members/MemberNoteService');
const { createApp } = require('../src/server');
const { makeGuild, makeChannel, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const MOD = '100000000000000002';
const MOD2 = '100000000000000003';
const BORIS = '300000000000000001';
const BOSS = '300000000000000002';
const VOICE = '500000000000000001';

// Notes in memory, shaped like the Cosmos container the service uses
const notes = new Map();
MemberNoteService.initialized = true;
MemberNoteService.container = {
    items: {
        query: ({ parameters }) => ({
            fetchNext: async () => {
                const userId = parameters.find(p => p.name === '@userId').value;
                return { resources: [...notes.values()].filter(n => n.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
            }
        }),
        create: async note => { notes.set(note.id, note); }
    },
    item: id => ({
        read: async () => {
            if (!notes.has(id)) throw Object.assign(new Error('not found'), { code: 404 });
            return { resource: notes.get(id) };
        },
        delete: async () => { notes.delete(id); }
    })
};

const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };
AuditLogService.query = async () => ({ items: [] });
WarningService.listActive = async () => [];
QueueCardService.get = async () => null;
TempRoleService.listForUser = async () => [];
const lastMessage = '2026-10-19T08:00:00.000Z';
ActivityService.lastMessageAt = async userId => (userId === BORIS ? lastMessage : null);
CosmosDBService.getBirthday = async userId => (userId === BORIS ? { month: 3, day: 3, lastCongratulatedOn: null } : null);

const guild = makeGuild();
guild.iconURL = () => null;
makeChannel(guild, { id: VOICE, name: 'Болталка' });
const role = (id, name, position, extra = {}) => ({ id, name, position, hexColor: '#2ec4ff', managed: false, editable: true, ...extra });
const event = role('700000000000000001', 'Ивент', 2);
const admin = role('700000000000000002', 'Админ', 20, { editable: false }); // above the bot
const twitch = role('700000000000000003', 'Twitch', 1, { managed: true });
const mods = role('700000000000000004', 'Модеры', 9);
for (const r of [event, admin, twitch, mods]) guild.roles.cache.set(r.id, r);

makeMember(guild, ADMIN, { position: 30, perms: flag => flag === PermissionFlagsBits.Administrator || flag === PermissionFlagsBits.ManageNicknames || flag === PermissionFlagsBits.ManageRoles });
makeMember(guild, MOD, { position: 5, perms: flag => [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.ManageRoles].includes(flag) });
makeMember(guild, MOD2, { position: 5, perms: flag => flag === PermissionFlagsBits.ModerateMembers });
const boris = makeMember(guild, BORIS, { position: 1, channelId: VOICE });
boris.roles.cache = new Collection([event, admin, twitch, mods].map(r => [r.id, r]));
boris.voice.serverMute = true;
boris.voice.channel = guild.channels.cache.get(VOICE);
boris.nickname = null;
boris.manageable = true;
boris.setNickname = async nick => { boris.nickname = nick; boris.displayName = nick || 'name-boris'; return boris; };
makeMember(guild, BOSS, { position: 10 }).manageable = true;
guild.memberCount = guild.members.cache.size;
VoiceService.noteChannel(guild.id, BORIS, VOICE);

(async () => {
    PanelSessionService.get = async token => ({
        admin: { userId: ADMIN, username: 'admin' },
        mod: { userId: MOD, username: 'mod' },
        mod2: { userId: MOD2, username: 'mod2' }
    }[token] || null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body, token = 'mod') => {
        const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    try {
        // The card's new facts
        const card = await call('GET', `/members/${BORIS}`);
        assert.strictEqual(card.status, 200, JSON.stringify(card.body));
        assert.ok(card.body.voice.since, 'time in the channel');
        assert.strictEqual(card.body.voice.serverMute, true);
        assert.strictEqual(card.body.lastMessageAt, lastMessage);
        assert.deepStrictEqual(card.body.birthday, { month: 3, day: 3 });
        assert.deepStrictEqual(card.body.notes, []);
        assert.strictEqual(card.body.moderation.can.nick, true);
        const locks = Object.fromEntries(card.body.roles.map(r => [r.name, r.lock]));
        assert.deepStrictEqual(locks, { Админ: 'bot', Модеры: 'higher', Ивент: null, Twitch: 'managed' });
        const plain = await call('GET', `/members/${BORIS}`, null, 'mod2');
        assert.strictEqual(plain.body.roles.find(r => r.name === 'Ивент').lock, 'no_permission');
        assert.strictEqual(plain.body.moderation.can.nick, false);

        // Notes: anyone adds and reads, the text never reaches the journal
        assert.strictEqual((await call('POST', `/members/${BORIS}/notes`, { text: '   ' })).body.error, 'note_empty');
        assert.strictEqual((await call('POST', `/members/${BORIS}/notes`, { text: 'x'.repeat(501) })).body.error, 'note_too_long');
        const added = await call('POST', `/members/${BORIS}/notes`, { text: 'Просил не выключать микро на ивентах' });
        assert.strictEqual(added.status, 200, JSON.stringify(added.body));
        const noteId = added.body.note.id;
        assert.strictEqual(logged.at(-1).action, 'member.note_added');
        assert.ok(!JSON.stringify(logged.at(-1)).includes('микро'), 'no note text in the journal');
        const seen = (await call('GET', `/members/${BORIS}`, null, 'mod2')).body.notes;
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].text, 'Просил не выключать микро на ивентах');
        assert.strictEqual(seen[0].canDelete, false, 'not the author');
        assert.strictEqual((await call('GET', `/members/${BORIS}`, null, 'admin')).body.notes[0].canDelete, true, 'an administrator');
        // Another moderator can't delete it; the administrator can
        assert.strictEqual((await call('DELETE', `/members/${BORIS}/notes/${noteId}`, null, 'mod2')).status, 403);
        assert.strictEqual((await call('DELETE', `/members/${BOSS}/notes/${noteId}`, null, 'admin')).status, 404, 'a note of someone else');
        assert.strictEqual((await call('DELETE', `/members/${BORIS}/notes/${noteId}`, null, 'admin')).status, 200);
        assert.strictEqual(logged.at(-1).action, 'member.note_deleted');
        assert.strictEqual((await call('DELETE', `/members/${BORIS}/notes/${noteId}`)).status, 404);
        // The author deletes their own
        const own = await call('POST', `/members/${BORIS}/notes`, { text: 'ещё одна' });
        assert.strictEqual((await call('DELETE', `/members/${BORIS}/notes/${own.body.note.id}`)).status, 200);

        // Nickname
        assert.strictEqual((await call('PUT', `/members/${BORIS}/nickname`, { nickname: 'Боря' }, 'mod2')).status, 403, 'no Manage Nicknames');
        assert.strictEqual((await call('PUT', `/members/${BORIS}/nickname`, { nickname: 'x'.repeat(33) })).body.error, 'nickname_too_long');
        assert.strictEqual((await call('PUT', `/members/${BOSS}/nickname`, { nickname: 'Босс' })).body.error, 'target_higher');
        const renamed = await call('PUT', `/members/${BORIS}/nickname`, { nickname: 'Боря' });
        assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
        assert.strictEqual(boris.nickname, 'Боря');
        assert.deepStrictEqual(logged.at(-1).details, { before: null, after: 'Боря' });
        assert.strictEqual((await call('PUT', `/members/${BORIS}/nickname`, { nickname: '' })).body.nickname, null, 'empty resets');
        assert.strictEqual(boris.nickname, null);
        console.log('member card tests passed');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
