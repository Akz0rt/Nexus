// Standalone test (no test framework configured): run with `node test/voice-routes.test.js`
// Runs the real Express app against a fake guild and checks the /voice and /roles API:
// the board comes back grouped and ordered, actions map to the service, errors to HTTP codes.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const SquadService = require('../src/modules/voice/SquadService');
const VoiceService = require('../src/modules/voice/VoiceService');
const { createApp } = require('../src/server');
const { makeGuild, makeChannel, makeMember } = require('./fake-voice-guild');

const MOD_ID = '100000000000000001';
const A_ID = '200000000000000002';
const B_ID = '200000000000000003';
const PEER_ID = '300000000000000003';
const CAT_ID = '400000000000000001';
const LOBBY_ID = '400000000000000002';
const RED_ID = '400000000000000003';
const LOOSE_ID = '400000000000000004';

PanelSessionService.get = async token => (token === 'tok' ? { userId: MOD_ID, username: 'mod' } : null);
AuditLogService.log = async entry => entry;
const squads = new Map();
SquadService.list = async () => [...squads.values()];
SquadService.get = async (guildId, id) => squads.get(id) || null;
SquadService.save = async squad => { const doc = { ...squad, id: squad.id || `sq${squads.size + 1}` }; squads.set(doc.id, doc); return doc; };
SquadService.remove = async (guildId, id) => squads.delete(id);

const guild = makeGuild();
makeChannel(guild, { id: CAT_ID, name: 'Игры', type: 4, position: 2 });
makeChannel(guild, { id: LOOSE_ID, name: 'Общий', position: 0 });
makeChannel(guild, { id: RED_ID, name: 'Красные', parentId: CAT_ID, position: 4 });
makeChannel(guild, { id: LOBBY_ID, name: 'Лобби', parentId: CAT_ID, position: 3 });
// Mod: may do everything except manage roles
const modPerms = flag => flag !== PermissionFlagsBits.Administrator && flag !== PermissionFlagsBits.ManageRoles;
makeMember(guild, MOD_ID, { position: 10, perms: modPerms, channelId: LOBBY_ID });
makeMember(guild, A_ID, { channelId: LOBBY_ID });
makeMember(guild, B_ID, {});
makeMember(guild, PEER_ID, { position: 10, perms: modPerms, channelId: LOOSE_ID });
guild.members.cache.get(A_ID).voice.selfMute = true;
guild.channels.cache.get(RED_ID).permissionOverwrites.cache.set(guild.id, { deny: { has: flag => flag === PermissionFlagsBits.Connect } });
guild.roles.cache.set('500000000000000001', { id: '500000000000000001', name: 'Ивент', position: 1, managed: false, editable: true, hexColor: '#123456' });
guild.memberCount = guild.members.cache.size;
state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };

async function run() {
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
        const board = await call('GET', '/voice');
        assert.strictEqual(board.status, 200);
        // Uncategorised first, then categories by position; channels by position
        assert.deepStrictEqual(board.body.categories.map(c => c.name), ['Без категории', 'Игры']);
        assert.deepStrictEqual(board.body.categories[1].channels.map(c => c.name), ['Лобби', 'Красные']);
        assert.strictEqual(board.body.categories[1].channels[1].locked, true);
        const lobby = board.body.categories[1].channels[0];
        assert.deepStrictEqual(lobby.members.map(m => m.id).sort(), [A_ID, MOD_ID].sort());
        const tileA = lobby.members.find(m => m.id === A_ID);
        assert.strictEqual(tileA.selfMute, true);
        assert.strictEqual(tileA.moderator, false);
        assert.strictEqual(lobby.members.find(m => m.id === MOD_ID).moderator, true);
        assert.strictEqual(board.body.myChannelId, LOBBY_ID);
        assert.deepStrictEqual(board.body.can, { move: true, mute: true, deafen: true, timeout: true, roles: false, channels: true });

        const moved = await call('POST', '/voice/move', { userIds: [A_ID, B_ID], channelId: LOOSE_ID });
        assert.strictEqual(moved.status, 200);
        assert.deepStrictEqual(moved.body.done, [A_ID]);
        assert.deepStrictEqual(moved.body.failed.map(f => f.code), ['not_in_voice']);
        assert.deepStrictEqual(moved.body.moves, [{ userId: A_ID, from: LOBBY_ID, to: LOOSE_ID }]);

        const undo = await call('POST', '/voice/move', { moves: [{ userId: A_ID, channelId: LOBBY_ID }], kind: 'undo' });
        assert.deepStrictEqual(undo.body.done, [A_ID]);
        assert.strictEqual(guild.members.cache.get(A_ID).voice.channelId, LOBBY_ID);

        assert.strictEqual((await call('POST', '/voice/move', { userIds: [A_ID], channelId: '1' })).status, 404);
        assert.strictEqual((await call('POST', '/voice/move', { userIds: 'nope', channelId: LOOSE_ID })).status, 400);

        const muted = await call('POST', '/voice/mute', { userIds: [A_ID, PEER_ID] });
        assert.deepStrictEqual(muted.body.done, [A_ID]);
        assert.deepStrictEqual(muted.body.failed.map(f => f.code), ['target_higher']);
        assert.strictEqual((await call('POST', '/voice/explode', { userIds: [A_ID] })).status, 400);

        assert.strictEqual((await call('POST', `/voice/channels/${LOBBY_ID}/mute-all`, { on: false, exceptIds: [MOD_ID] })).body.done[0], A_ID);
        assert.strictEqual((await call('POST', `/voice/channels/${LOBBY_ID}/lock`, { locked: true })).status, 200);
        assert.strictEqual((await call('PATCH', `/voice/channels/${LOBBY_ID}`, { userLimit: 4 })).status, 200);
        await call('PATCH', `/voice/channels/${LOBBY_ID}`, { name: 'Раз' });
        await call('PATCH', `/voice/channels/${LOBBY_ID}`, { name: 'Два' });
        assert.strictEqual((await call('PATCH', `/voice/channels/${LOBBY_ID}`, { name: 'Три' })).status, 429);
        assert.strictEqual((await call('POST', '/voice/channels/abc/lock', {})).status, 400);

        const created = await call('POST', '/voice/squads', { name: 'Мафия', memberIds: [A_ID, B_ID] });
        assert.strictEqual(created.status, 200);
        const list = await call('GET', '/voice/squads');
        assert.deepStrictEqual(list.body.items[0].members.map(m => m.displayName), [`name-${A_ID}`, `name-${B_ID}`]);
        const squadId = created.body.squad.id;
        const gathered = await call('POST', `/voice/squads/${squadId}/gather`, { channelId: LOOSE_ID });
        assert.deepStrictEqual(gathered.body.done, [A_ID]);
        assert.deepStrictEqual(gathered.body.invited, [B_ID]);
        assert.strictEqual((await call('PUT', '/voice/squads/missing', { name: 'x', memberIds: [A_ID] })).status, 404);
        assert.strictEqual((await call('DELETE', `/voice/squads/${squadId}`)).status, 200);

        // No Manage Roles → no assignable roles, bulk refused
        assert.deepStrictEqual((await call('GET', '/roles/assignable')).body.items, []);
        assert.strictEqual((await call('POST', '/roles/bulk', { userIds: [A_ID], roleId: '5', add: true })).status, 403);

        console.log('PASS: voice API');
    } finally {
        server.close();
        VoiceService.renames.clear();
    }
}

run().catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
});
