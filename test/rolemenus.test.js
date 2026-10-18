// Standalone test (no test framework configured): run with `node test/rolemenus.test.js`
// Role menus: dangerous roles and roles above the moderator are refused; a button
// gives the role and a second press takes it; single-choice menus swap roles in
// one request; roles the bot lost control of are refused politely.

const assert = require('assert');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const RoleMenuService = require('../src/modules/rolemenus/RoleMenuService');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const A = '200000000000000001';
const TEXT = '600000000000000001';
const ANIME = '500000000000000001';
const GAMES = '500000000000000002';
const HELPER = '500000000000000003';
const ADMIN = '500000000000000004';

const menus = new Map();
RoleMenuService.initialize = async () => {};
RoleMenuService.get = async (guildId, id) => menus.get(id) || null;
RoleMenuService.save = async menu => { menus.set(menu.id, { ...menu }); return menu; };
RoleMenuService.remove = async (guildId, id) => menus.delete(id);
AuditLogService.log = async entry => entry;

const guild = makeGuild();
const sent = [];
guild.channels.cache.set(TEXT, {
    id: TEXT, name: 'роли', type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push(payload); return { id: `7000000000000000${sent.length}` }; },
    messages: { fetch: async () => null, delete: async () => {} }
});
const role = (id, name, position, perms = () => false) => guild.roles.cache.set(id, {
    id, name, position, managed: false, editable: true, hexColor: '#123456', permissions: { has: perms }
});
role(ANIME, 'Аниме', 1);
role(GAMES, 'Игры', 2);
role(HELPER, 'Хелпер', 3, flag => flag === PermissionFlagsBits.ManageMessages);
role(ADMIN, 'Админ', 20);
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.ManageRoles });
const member = makeMember(guild, A, {});
member.roles.add = async r => { member.roles.cache.set(r.id, r); member.calls = (member.calls || 0) + 1; };
member.roles.remove = async r => { member.roles.cache.delete(r.id); member.calls = (member.calls || 0) + 1; };
member.roles.set = async ids => { member.roles.cache = new Map(ids.map(id => [id, guild.roles.cache.get(id) || { id }])); member.calls = (member.calls || 0) + 1; };
const mod = { id: MOD, tag: 'mod' };

async function guards() {
    const base = { title: 'Интересы', channelId: TEXT };
    assert.strictEqual((await RoleMenuService.create(guild, { ...base, roleIds: [HELPER] }, mod, 'panel')).code, 'role_dangerous');
    assert.strictEqual((await RoleMenuService.create(guild, { ...base, roleIds: [ADMIN] }, mod, 'panel')).code, 'role_higher');
    assert.strictEqual((await RoleMenuService.create(guild, { ...base, roleIds: [] }, mod, 'panel')).code, 'invalid_roles');
    assert.strictEqual((await RoleMenuService.create(guild, { ...base, roleIds: [ANIME] }, { id: A }, 'panel')).code, 'forbidden');
}

async function multi() {
    const { menu } = await RoleMenuService.create(guild, { title: 'Интересы', channelId: TEXT, roleIds: [ANIME, GAMES] }, mod, 'panel');
    assert.ok(menu.messageId);
    assert.strictEqual(sent.at(-1).components[0].components.length, 2, 'a button per role');

    let result = await RoleMenuService.toggle(guild, member, menu.id, ANIME);
    assert.deepStrictEqual([result.added, result.roleName], [true, 'Аниме']);
    await RoleMenuService.toggle(guild, member, menu.id, GAMES);
    assert.ok(member.roles.cache.has(ANIME) && member.roles.cache.has(GAMES), 'multi keeps both');
    result = await RoleMenuService.toggle(guild, member, menu.id, ANIME);
    assert.strictEqual(result.added, false);
    assert.ok(!member.roles.cache.has(ANIME), 'second press takes it away');
    assert.strictEqual((await RoleMenuService.toggle(guild, member, menu.id, ADMIN)).code, 'menu_not_found', 'only roles of this menu');
}

async function single() {
    member.roles.cache.clear();
    const { menu } = await RoleMenuService.create(guild, { title: 'Цвет', channelId: TEXT, roleIds: [ANIME, GAMES], mode: 'single' }, mod, 'panel');
    await RoleMenuService.toggle(guild, member, menu.id, ANIME);
    member.calls = 0;
    const result = await RoleMenuService.toggle(guild, member, menu.id, GAMES);
    assert.deepStrictEqual(result.removed, ['Аниме']);
    assert.ok(member.roles.cache.has(GAMES) && !member.roles.cache.has(ANIME));
    assert.strictEqual(member.calls, 1, 'swap in one request');

    guild.roles.cache.get(ANIME).editable = false;
    assert.strictEqual((await RoleMenuService.toggle(guild, member, menu.id, ANIME)).code, 'bot_cannot_role');
}

(async () => {
    await guards();
    await multi();
    await single();
    console.log('role menu tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
