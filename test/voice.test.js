// Standalone test (no test framework configured): run with `node test/voice.test.js`
// Verifies group voice actions: moves (with undo data), the role-hierarchy rule
// (move anyone; mute/deafen/disconnect only lower roles), mute-all, split/gather,
// squads with DM invites, channel lock/limit/rename, group roles and panel access.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const SquadService = require('../src/modules/voice/SquadService');
const VoiceService = require('../src/modules/voice/VoiceService');
const { voiceTargetProblem, dealTeams } = require('../src/modules/voice/VoiceService');
const RoleService = require('../src/services/RoleService');
const { panelRoleFromPermissions } = require('../src/web/v2/access');
const { describeBulk } = require('../src/modules/voice/commandText');
const { makeGuild, makeChannel, makeMember, ALL } = require('./fake-voice-guild');

const MOD = { id: 'mod', tag: 'Mod' };

let logged;
let squads;

function setup() {
    logged = [];
    AuditLogService.log = async entry => { logged.push(entry); return entry; };
    squads = new Map();
    let seq = 0;
    SquadService.get = async (guildId, id) => squads.get(id) || null;
    SquadService.save = async squad => {
        const doc = { ...squad, id: squad.id || `s${++seq}` };
        squads.set(doc.id, doc);
        return doc;
    };
    SquadService.remove = async (guildId, id) => squads.delete(id);
    VoiceService.renames.clear();
    VoiceService.lastSplit.clear();
}

/** Lobby with mod + 4 people, two empty team rooms in the same category, one elsewhere. */
function world({ modPerms = ALL } = {}) {
    const guild = makeGuild();
    makeChannel(guild, { id: 'cat', name: 'Игры', type: 4, position: 0 });
    makeChannel(guild, { id: 'lobby', name: 'Лобби', parentId: 'cat', position: 1 });
    makeChannel(guild, { id: 'red', name: 'Красные', parentId: 'cat', position: 2 });
    makeChannel(guild, { id: 'blue', name: 'Синие', parentId: 'cat', position: 3 });
    makeChannel(guild, { id: 'far', name: 'Далеко', parentId: null, position: 9 });
    makeChannel(guild, { id: 'text', name: 'чат', type: 0 });
    makeMember(guild, 'mod', { position: 10, perms: modPerms, channelId: 'lobby' });
    for (const id of ['a', 'b', 'c', 'd']) makeMember(guild, id, { channelId: 'lobby' });
    makeMember(guild, 'peer', { position: 10, channelId: 'far' });
    makeMember(guild, 'musicbot', { bot: true, channelId: 'lobby' });
    makeMember(guild, 'idle', {});
    return guild;
}

async function moves() {
    setup();
    const guild = world();
    const result = await VoiceService.move(guild, ['a', 'b', 'idle', 'peer'], 'red', MOD, 'panel');
    assert.ok(result.ok);
    // Moving ignores the hierarchy: the peer (same rank) moves too
    assert.deepStrictEqual(result.done.sort(), ['a', 'b', 'peer']);
    assert.deepStrictEqual(result.failed, [{ userId: 'idle', name: 'name-idle', code: 'not_in_voice' }]);
    assert.deepStrictEqual(result.moves.find(m => m.userId === 'peer'), { userId: 'peer', from: 'far', to: 'red' });
    assert.strictEqual(guild.members.cache.get('a').voice.channelId, 'red');
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].action, 'voice.moved');
    assert.strictEqual(logged[0].details.channelName, 'Красные');
    assert.strictEqual(logged[0].details.failed, 1);

    // Undo: everyone back to where they came from, logged as an undo
    const undo = await VoiceService.moveEach(guild, result.moves.map(m => ({ userId: m.userId, channelId: m.from })), MOD, 'panel', { kind: 'undo' });
    assert.deepStrictEqual(undo.failed, []);
    assert.strictEqual(guild.members.cache.get('peer').voice.channelId, 'far');
    assert.strictEqual(logged[1].action, 'voice.move_undone');

    // Already there: done, but no Discord call and no log entry
    const same = await VoiceService.move(guild, ['a'], 'lobby', MOD, 'panel');
    assert.deepStrictEqual(same.done, ['a']);
    assert.deepStrictEqual(same.moves, []);
    assert.strictEqual(logged.length, 2);

    assert.strictEqual((await VoiceService.move(guild, ['a'], 'text', MOD, 'panel')).code, 'channel_not_found');
    assert.strictEqual((await VoiceService.move(guild, [], 'red', MOD, 'panel')).code, 'invalid_targets');
    assert.strictEqual((await VoiceService.move(guild, new Array(101).fill(0).map((_, i) => `u${i}`), 'red', MOD, 'panel')).code, 'invalid_targets');

    // Discord errors per member become per-member failures
    guild.members.cache.get('b').voice.failWith = 50013;
    const partial = await VoiceService.move(guild, ['b', 'c'], 'blue', MOD, 'panel');
    assert.deepStrictEqual(partial.failed.map(f => [f.userId, f.code]), [['b', 'bot_cannot']]);
    assert.deepStrictEqual(partial.done, ['c']);

    // No Connect on the destination → refused as a whole
    const locked = world();
    locked.channels.cache.get('red').permissionsFor = member => ({ has: flag => flag !== PermissionFlagsBits.Connect || member.id === 'bot' });
    assert.strictEqual((await VoiceService.move(locked, ['a'], 'red', MOD, 'panel')).code, 'channel_forbidden');

    const noPerm = world({ modPerms: flag => flag !== PermissionFlagsBits.MoveMembers });
    assert.strictEqual((await VoiceService.move(noPerm, ['a'], 'red', MOD, 'panel')).code, 'forbidden');

    const weakBot = world();
    weakBot.members.me.permissions.has = flag => flag !== PermissionFlagsBits.MoveMembers;
    assert.strictEqual((await VoiceService.move(weakBot, ['a'], 'red', MOD, 'panel')).code, 'bot_missing_permission');
}

async function hierarchy() {
    const guild = world();
    const mod = guild.members.cache.get('mod');
    assert.strictEqual(voiceTargetProblem(guild, mod, guild.members.cache.get('a')), null);
    assert.strictEqual(voiceTargetProblem(guild, mod, mod), null); // muting yourself is fine
    assert.strictEqual(voiceTargetProblem(guild, mod, guild.members.cache.get('musicbot')), null);
    assert.strictEqual(voiceTargetProblem(guild, mod, guild.members.cache.get('peer')), 'target_higher');
    const owner = makeMember(guild, 'owner', { position: 1, channelId: 'far' });
    assert.strictEqual(voiceTargetProblem(guild, mod, owner), 'target_protected');
    // The owner may act on anyone
    assert.strictEqual(voiceTargetProblem(guild, owner, guild.members.cache.get('peer')), null);
}

async function muteDeafenDisconnect() {
    setup();
    const guild = world();
    const muted = await VoiceService.apply(guild, 'mute', ['a', 'peer', 'idle'], MOD, 'panel');
    assert.deepStrictEqual(muted.done, ['a']);
    assert.deepStrictEqual(muted.failed.map(f => f.code), ['target_higher', 'not_in_voice']);
    assert.strictEqual(guild.members.cache.get('a').voice.serverMute, true);
    assert.strictEqual(logged[0].action, 'voice.muted');
    assert.deepStrictEqual(logged[0].targetIds, ['a']);

    await VoiceService.apply(guild, 'deafen', ['b'], MOD, 'panel');
    assert.strictEqual(guild.members.cache.get('b').voice.serverDeaf, true);
    await VoiceService.apply(guild, 'disconnect', ['c'], MOD, 'panel');
    assert.strictEqual(guild.members.cache.get('c').voice.channelId, null);
    assert.deepStrictEqual(logged.map(e => e.action), ['voice.muted', 'voice.deafened', 'voice.disconnected']);

    // Nothing done → nothing logged
    await VoiceService.apply(guild, 'mute', ['peer'], MOD, 'panel');
    assert.strictEqual(logged.length, 3);

    assert.strictEqual((await VoiceService.apply(guild, 'constructor', ['a'], MOD, 'panel')).code, 'invalid_action');
    const noMute = world({ modPerms: flag => flag !== PermissionFlagsBits.MuteMembers });
    assert.strictEqual((await VoiceService.apply(noMute, 'mute', ['a'], MOD, 'panel')).code, 'forbidden');

    const lobby = world();
    lobby.members.cache.get('d').voice.failWith = 40032;
    const left = await VoiceService.apply(lobby, 'mute', ['d'], MOD, 'panel');
    assert.deepStrictEqual(left.failed.map(f => f.code), ['not_in_voice']);
}

async function muteChannel() {
    setup();
    const guild = world();
    makeMember(guild, 'boss', { position: 20, channelId: 'lobby' });
    guild.members.cache.get('d').voice.serverMute = true;
    const result = await VoiceService.muteChannel(guild, 'lobby', true, MOD, 'discord', { exceptIds: ['mod'] });
    // Host and bots untouched, already-muted skipped, the higher-ranked reported
    assert.deepStrictEqual(result.done.sort(), ['a', 'b', 'c']);
    assert.deepStrictEqual(result.failed.map(f => [f.userId, f.code]), [['boss', 'target_higher']]);
    assert.strictEqual(guild.members.cache.get('musicbot').voice.serverMute, false);
    assert.strictEqual(guild.members.cache.get('mod').voice.serverMute, false);
    assert.strictEqual(logged[0].details.wholeChannel, true);
    assert.match(describeBulk(result, 'Микрофон выключен:'), /^Микрофон выключен: 3 из 4\.\nНе вышло: name-boss — роль не ниже твоей\.$/);

    const back = await VoiceService.muteChannel(guild, 'lobby', false, MOD, 'discord', { exceptIds: ['mod'] });
    assert.deepStrictEqual(back.done.sort(), ['a', 'b', 'c', 'd']);
    assert.strictEqual((await VoiceService.muteChannel(guild, 'red', true, MOD, 'discord')).code, 'nobody');
}

async function splitAndGather() {
    setup();
    // Round-robin: sizes differ by at most one, every member placed once
    const dealt = dealTeams(['1', '2', '3', '4', '5'], ['x', 'y'], () => 0.5);
    assert.strictEqual(dealt.length, 5);
    assert.deepStrictEqual(dealt.filter(d => d.channelId === 'x').length, 3);
    assert.deepStrictEqual(new Set(dealt.map(d => d.userId)).size, 5);

    const guild = world();
    const mod = guild.members.cache.get('mod');
    assert.deepStrictEqual(VoiceService.freeChannelsNear(guild, guild.channels.cache.get('lobby'), mod, 5).map(c => c.id), ['red', 'blue']);

    const split = await VoiceService.split(guild, 'lobby', ['red', 'blue'], MOD, 'discord', { exceptIds: ['mod'] });
    assert.ok(split.ok);
    assert.deepStrictEqual(split.done.sort(), ['a', 'b', 'c', 'd']); // the bot and the host stay
    assert.strictEqual(guild.channels.cache.get('red').members.size, 2);
    assert.strictEqual(guild.channels.cache.get('blue').members.size, 2);
    assert.strictEqual(guild.members.cache.get('mod').voice.channelId, 'lobby');
    assert.strictEqual(logged[0].action, 'voice.split');
    assert.deepStrictEqual(VoiceService.lastSplit.get(guild.id), { sourceChannelId: 'lobby', targetChannelIds: ['red', 'blue'].filter(id => split.moves.some(m => m.to === id)) });

    const gathered = await VoiceService.gather(guild, 'lobby', ['red', 'blue'], MOD, 'discord');
    assert.deepStrictEqual(gathered.done.sort(), ['a', 'b', 'c', 'd']);
    assert.strictEqual(guild.channels.cache.get('lobby').members.size, 6);
    assert.strictEqual(logged[1].action, 'voice.gathered');

    assert.strictEqual((await VoiceService.split(guild, 'lobby', ['red'], MOD, 'discord')).code, 'need_two_channels');
    assert.strictEqual((await VoiceService.gather(guild, 'lobby', ['red'], MOD, 'discord')).code, 'nobody');
}

async function squadsFlow() {
    setup();
    const guild = world();
    makeMember(guild, 'shy', { dmClosed: true });
    assert.strictEqual((await VoiceService.saveSquad(guild, { name: ' ', memberIds: ['a'] }, MOD, 'panel')).code, 'invalid_name');
    assert.strictEqual((await VoiceService.saveSquad(guild, { name: 'Мафия', memberIds: [] }, MOD, 'panel')).code, 'invalid_targets');
    assert.strictEqual((await VoiceService.saveSquad(guild, { id: 'nope', name: 'Мафия', memberIds: ['a'] }, MOD, 'panel')).code, 'squad_not_found');

    const saved = await VoiceService.saveSquad(guild, { name: 'Мафия, пятница', memberIds: ['a', 'peer', 'idle', 'shy', 'gone'] }, MOD, 'panel');
    assert.ok(saved.ok);
    assert.strictEqual(logged.at(-1).action, 'voice.squad_saved');

    const gathered = await VoiceService.gatherSquad(guild, saved.squad.id, 'red', MOD, 'panel');
    assert.ok(gathered.ok);
    assert.deepStrictEqual(gathered.done.sort(), ['a', 'peer']);
    assert.deepStrictEqual(gathered.invited, ['idle']);
    assert.match(guild.members.cache.get('idle').dms[0], /«Красные».*«Тестовый».*https:\/\/discord\.com\/channels\/900000000000000009\/red/);
    assert.deepStrictEqual(gathered.failed.map(f => [f.userId, f.code]), [['shy', 'dm_closed']]);
    assert.deepStrictEqual(logged.slice(-2).map(e => e.action), ['voice.gathered', 'voice.squad_invited']);

    assert.ok((await VoiceService.deleteSquad(guild, saved.squad.id, MOD, 'panel')).ok);
    assert.strictEqual((await VoiceService.gatherSquad(guild, saved.squad.id, 'red', MOD, 'panel')).code, 'squad_not_found');

    const noMove = world({ modPerms: flag => flag !== PermissionFlagsBits.MoveMembers });
    assert.strictEqual((await VoiceService.saveSquad(noMove, { name: 'x', memberIds: ['a'] }, MOD, 'panel')).code, 'forbidden');
}

async function channelSettings() {
    setup();
    const guild = world();
    const lobby = guild.channels.cache.get('lobby');
    assert.ok((await VoiceService.setLocked(guild, 'lobby', true, MOD, 'panel')).ok);
    assert.deepStrictEqual(lobby.overwriteEdits.at(-1), { Connect: false });
    assert.ok((await VoiceService.setLocked(guild, 'lobby', false, MOD, 'panel')).ok);
    assert.deepStrictEqual(lobby.overwriteEdits.at(-1), { Connect: null });
    assert.deepStrictEqual(logged.map(e => e.action), ['voice.channel_locked', 'voice.channel_unlocked']);

    assert.ok((await VoiceService.editChannel(guild, 'lobby', { userLimit: 5 }, MOD, 'panel')).ok);
    assert.strictEqual(lobby.userLimit, 5);
    assert.strictEqual((await VoiceService.editChannel(guild, 'lobby', { userLimit: 100 }, MOD, 'panel')).code, 'invalid_limit');
    assert.strictEqual((await VoiceService.editChannel(guild, 'lobby', { name: '  ' }, MOD, 'panel')).code, 'invalid_name');
    assert.ok((await VoiceService.editChannel(guild, 'lobby', { userLimit: 5 }, MOD, 'panel')).unchanged);

    // Discord allows two renames per 10 minutes; the third is refused instead of hanging
    assert.ok((await VoiceService.editChannel(guild, 'lobby', { name: 'Ивент' }, MOD, 'panel')).ok);
    assert.ok((await VoiceService.editChannel(guild, 'lobby', { name: 'Ивент 2' }, MOD, 'panel')).ok);
    assert.strictEqual((await VoiceService.editChannel(guild, 'lobby', { name: 'Ивент 3' }, MOD, 'panel')).code, 'rename_rate_limited');
    assert.strictEqual(lobby.name, 'Ивент 2');
    assert.deepStrictEqual(logged.at(-1).details.before, { name: 'Ивент', userLimit: 5 });

    const noManage = world({ modPerms: flag => flag !== PermissionFlagsBits.ManageChannels });
    noManage.channels.cache.get('lobby').permissionsFor = member => ({ has: flag => member.id === 'bot' || flag !== PermissionFlagsBits.ManageChannels });
    assert.strictEqual((await VoiceService.setLocked(noManage, 'lobby', true, MOD, 'panel')).code, 'forbidden');
}

async function roles() {
    setup();
    const guild = world();
    const role = id => ({ id, name: `role-${id}`, position: 5, managed: false, editable: true, hexColor: '#123456' });
    guild.roles.cache.set('event', role('event'));
    guild.roles.cache.set('high', { ...role('high'), position: 15 });
    guild.roles.cache.set('integration', { ...role('integration'), managed: true });
    guild.roles.cache.set('abovebot', { ...role('abovebot'), editable: false });
    guild.members.cache.get('b').roles.cache.set('event', role('event'));

    const mod = guild.members.cache.get('mod');
    assert.deepStrictEqual(RoleService.assignableRoles(guild, mod).map(r => r.id), ['event']);

    const added = await RoleService.bulkRole(guild, ['a', 'b', 'gone'], 'event', true, MOD, 'panel');
    assert.deepStrictEqual(added.done, ['a', 'b']);
    assert.deepStrictEqual(added.failed.map(f => f.code), ['member_not_found']);
    assert.ok(guild.members.cache.get('a').roles.cache.has('event'));
    // b already had it: no entry for b in the log
    assert.deepStrictEqual(logged[0].targetIds, ['a']);
    assert.strictEqual(logged[0].action, 'roles.added');

    assert.strictEqual((await RoleService.bulkRole(guild, ['a'], 'high', true, MOD, 'panel')).code, 'role_higher');
    assert.strictEqual((await RoleService.bulkRole(guild, ['a'], 'integration', true, MOD, 'panel')).code, 'role_managed');
    assert.strictEqual((await RoleService.bulkRole(guild, ['a'], 'abovebot', true, MOD, 'panel')).code, 'bot_cannot_role');
    assert.strictEqual((await RoleService.bulkRole(guild, ['a'], guild.id, true, MOD, 'panel')).code, 'role_not_found');
    const removed = await RoleService.bulkRole(guild, ['a'], 'event', false, MOD, 'panel');
    assert.deepStrictEqual(removed.done, ['a']);
    assert.strictEqual(logged.at(-1).action, 'roles.removed');
}

function panelAccess() {
    const only = wanted => ({ has: flag => flag === wanted });
    assert.strictEqual(panelRoleFromPermissions(only(PermissionFlagsBits.MoveMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(only(PermissionFlagsBits.MuteMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(only(PermissionFlagsBits.DeafenMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(only(PermissionFlagsBits.Connect)), 'none');
}

async function run() {
    await moves();
    await hierarchy();
    await muteDeafenDisconnect();
    await muteChannel();
    await splitAndGather();
    await squadsFlow();
    await channelSettings();
    await roles();
    panelAccess();
    console.log('PASS: voice actions');
}

run().catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
});
