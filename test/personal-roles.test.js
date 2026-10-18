// Standalone test (no test framework configured): run with `node test/personal-roles.test.js`
// Personal roles: renting (paid, placed above the anchor, limit of active roles),
// extending, selling with the owner's 95%, buyers' own term, reminders and expiry.

const assert = require('assert');
const { Collection } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const EconomyService = require('../src/modules/economy/EconomyService');
const PersonalRoleService = require('../src/modules/economy/PersonalRoleService');
const { legacyPersonalRoles } = require('../src/modules/economy/legacyImport');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const OWNER = '200000000000000001';
const BUYER = '200000000000000002';
const POOR = '200000000000000003';
const DAY = 24 * 60 * 60 * 1000;

// ---- fakes ----
const balances = new Map();
const txs = [];
EconomyService.move = async (guildId, member, amount, { cause }) => {
    const money = balances.get(member.id) || 0;
    if (money + amount < 0) return { ok: false, code: 'insufficient_funds', balance: money };
    balances.set(member.id, money + amount);
    txs.push({ userId: member.id, amount, cause });
    return { ok: true, account: { money: money + amount } };
};
EconomyService.transfer = async (guildId, from, to, amount, { fee = 0, outCause, inCause }) => {
    const debit = await EconomyService.move(guildId, from, -amount, { cause: outCause });
    if (!debit.ok) return debit;
    const credit = await EconomyService.move(guildId, to, amount - fee, { cause: inCause });
    return { ok: true, from: debit.account, to: credit.account };
};
EconomyService.get = async (guildId, userId) => ({ money: balances.get(userId) || 0 });
const store = new Map();
PersonalRoleService.initialize = async () => {};
PersonalRoleService.get = async (guildId, id) => (store.has(id) ? { ...store.get(id) } : null);
PersonalRoleService.list = async () => [...store.values()].map(doc => ({ ...doc }));
PersonalRoleService.listAll = PersonalRoleService.list;
PersonalRoleService.save = async doc => { store.set(doc.id, { ...doc }); return doc; };
PersonalRoleService.remove = async (guildId, id) => { store.delete(id); };
const audit = [];
AuditLogService.log = async entry => { audit.push(entry); return entry; };
let settings = { enabled: true, anchorRoleId: 'anchor', createPrice: 3000, rentPrice: 1000, periodDays: 30, maxActive: 2 };
GuildSettingsService.get = async () => ({ economy: { personalRoles: settings } });

const guild = makeGuild();
guild.name = 'Тест';
guild.features = ['ROLE_ICONS'];
guild.roles.cache.set('anchor', { id: 'anchor', name: '---', position: 10 });
guild.members.me = { roles: { highest: { position: 50 } } };
let nextRole = 0;
const created = [];
guild.roles.create = async options => {
    const role = {
        id: `70000000000000000${++nextRole}`, ...options, editable: true, managed: false,
        edits: [], deleted: false,
        edit: async patch => { role.edits.push(patch); Object.assign(role, patch); },
        delete: async () => { role.deleted = true; guild.roles.cache.delete(role.id); }
    };
    created.push(options);
    guild.roles.cache.set(role.id, role);
    return role;
};
const dms = [];
const owner = makeMember(guild, OWNER, {});
const buyer = makeMember(guild, BUYER, {});
const poor = makeMember(guild, POOR, {});
for (const m of [owner, buyer, poor]) m.send = async payload => { dms.push({ to: m.id, text: payload.content }); };
const client = { guilds: { cache: new Map([[guild.id, guild]]) } };

async function renting() {
    balances.set(OWNER, 5000);
    assert.strictEqual((await PersonalRoleService.create(guild, owner, { name: '@everyone hi' })).code, 'invalid_name');
    assert.strictEqual((await PersonalRoleService.create(guild, owner, { name: 'Кот', color: 'зелёный' })).code, 'invalid_color');
    assert.strictEqual((await PersonalRoleService.create(guild, owner, { name: 'Кот', icon: { url: 'x', contentType: 'image/gif', size: 10 } })).code, 'invalid_icon');
    assert.strictEqual(balances.get(OWNER), 5000, 'refusals cost nothing');

    const result = await PersonalRoleService.create(guild, owner, { name: 'Кот', color: '#ff7a1a', emoji: '🐱' });
    assert.ok(result.ok);
    assert.strictEqual(balances.get(OWNER), 2000, 'paid 3000');
    assert.deepStrictEqual([created[0].position, created[0].color, created[0].unicodeEmoji, created[0].permissions], [11, 0xff7a1a, '🐱', []], 'right above the anchor, no permissions');
    assert.ok(owner.roles.cache.has(result.role.id), 'the owner wears it');
    const expires = Date.parse(result.doc.expiresAt);
    assert.ok(Math.abs(expires - (Date.now() + 30 * DAY)) < 5000);

    balances.set(POOR, 100);
    const broke = await PersonalRoleService.create(guild, poor, { name: 'Мечта' });
    assert.deepStrictEqual([broke.code, broke.price, broke.balance], ['insufficient_funds', 3000, 100]);

    // The limit counts active roles
    balances.set(OWNER, 10000);
    await PersonalRoleService.create(guild, owner, { name: 'Пёс' });
    assert.strictEqual((await PersonalRoleService.create(guild, owner, { name: 'Третья' })).code, 'too_many_roles');

    // Extending: from the current end, paid
    const extended = await PersonalRoleService.extend(guild, owner, result.role.id, 2);
    assert.strictEqual(extended.cost, 2000);
    assert.ok(Math.abs(Date.parse(extended.doc.expiresAt) - (expires + 60 * DAY)) < 5000);
    assert.strictEqual((await PersonalRoleService.extend(guild, buyer, result.role.id)).code, 'not_owner');
    assert.strictEqual((await PersonalRoleService.extend(guild, owner, result.role.id, 12)).code, 'too_far', 'not more than a year ahead');

    // Taking it off keeps it theirs
    await PersonalRoleService.wear(guild, owner, result.role.id, false);
    assert.ok(!owner.roles.cache.has(result.role.id) && store.get(result.role.id).ownerWears === false);
    return result.role.id;
}

async function selling(roleId) {
    assert.strictEqual((await PersonalRoleService.buy(guild, buyer, roleId)).code, 'not_for_sale');
    await PersonalRoleService.setPrice(guild, owner, roleId, 1000);
    assert.strictEqual((await PersonalRoleService.buy(guild, owner, roleId)).code, 'own_role');
    balances.set(BUYER, 1500);
    const ownerBefore = balances.get(OWNER);
    const bought = await PersonalRoleService.buy(guild, buyer, roleId);
    assert.ok(bought.ok);
    assert.strictEqual(balances.get(BUYER), 500);
    assert.strictEqual(balances.get(OWNER) - ownerBefore, 950, 'owner gets 95%');
    assert.ok(buyer.roles.cache.has(roleId));
    assert.ok(Math.abs(Date.parse(bought.expiresAt) - (Date.now() + 30 * DAY)) < 5000, "the buyer's own term");
    assert.strictEqual((await PersonalRoleService.buy(guild, buyer, roleId)).code, 'insufficient_funds');
    assert.ok(audit.some(e => e.action === 'personal_role.bought'));
}

async function time(roleId) {
    const doc = store.get(roleId);
    // The buyer's term ends first: the role comes off them, with a DM
    await PersonalRoleService.processDue(client, Date.parse(doc.buyers[0].expiresAt) + 1000);
    assert.ok(!buyer.roles.cache.has(roleId));
    assert.deepStrictEqual(store.get(roleId).buyers, []);
    assert.ok(dms.some(d => d.to === BUYER && /\/shop/.test(d.text)));

    // A holder from the old bot keeps it until the role itself ends
    store.get(roleId).buyers = [{ userId: POOR, expiresAt: null, permanent: true }];
    poor.roles.cache.set(roleId, guild.roles.cache.get(roleId));
    await PersonalRoleService.processDue(client, Date.parse(store.get(roleId).expiresAt) - 5 * DAY);
    assert.ok(poor.roles.cache.has(roleId) && store.get(roleId).buyers.length === 1);
    assert.strictEqual((await PersonalRoleService.buy(guild, poor, roleId)).code, 'already_yours');

    // 3 days before the end: one reminder
    const end = Date.parse(store.get(roleId).expiresAt);
    await PersonalRoleService.processDue(client, end - 2 * DAY);
    await PersonalRoleService.processDue(client, end - 1 * DAY);
    assert.strictEqual(dms.filter(d => d.to === OWNER && /закончится/.test(d.text)).length, 1);

    // The end: deleted from Discord and forgotten
    await PersonalRoleService.processDue(client, end + 1000);
    assert.ok(!store.has(roleId) && !guild.roles.cache.has(roleId));
    assert.ok(dms.some(d => d.to === OWNER && /удалена/.test(d.text)));
}

async function adminAndLeaving() {
    assert.strictEqual(store.size, 0, 'the other role ran out too');
    balances.set(OWNER, 5000);
    const other = (await PersonalRoleService.create(guild, owner, { name: 'Ёж' })).doc;
    await PersonalRoleService.setPrice(guild, owner, other.roleId, 500);
    store.get(other.roleId).buyers = [{ userId: BUYER, expiresAt: new Date(Date.now() + DAY).toISOString() }];
    // A buyer leaves: off the role at once
    await PersonalRoleService.memberLeft(guild.id, BUYER);
    assert.deepStrictEqual(store.get(other.roleId).buyers, []);
    // The owner leaves: anonymous key, off sale; back within 3 days — theirs again
    const leftAt = Date.now();
    await PersonalRoleService.memberLeft(guild.id, OWNER, leftAt);
    let doc = store.get(other.roleId);
    assert.ok(doc.ownerId.startsWith('anon-') && doc.ownerId !== OWNER && doc.price === null && doc.ownerLeftAt);
    owner.roles.cache.clear();
    await PersonalRoleService.memberReturned(guild, owner, leftAt + 2 * DAY);
    doc = store.get(other.roleId);
    assert.deepStrictEqual([doc.ownerId, doc.ownerLeftAt], [OWNER, null]);
    assert.ok(owner.roles.cache.has(other.roleId), 'worn again');
    // Leaves again and stays away: the role is deleted after 3 days
    await PersonalRoleService.memberLeft(guild.id, OWNER, leftAt);
    await PersonalRoleService.memberReturned(guild, owner, leftAt + 4 * DAY);
    assert.ok(store.get(other.roleId).ownerId.startsWith('anon-'), 'too late to come back');
    await PersonalRoleService.processDue(client, leftAt + 4 * DAY);
    assert.ok(!store.has(other.roleId) && !guild.roles.cache.has(other.roleId));

    // Free roles (price 0 in the settings) work too
    settings = { ...settings, createPrice: 0, rentPrice: 0 };
    balances.set(OWNER, 0);
    const free = await PersonalRoleService.create(guild, owner, { name: 'Бесплатная' });
    assert.ok(free.ok, 'created for free');
    assert.ok((await PersonalRoleService.extend(guild, owner, free.role.id)).ok, 'extended for free');
    assert.strictEqual(balances.get(OWNER), 0);
    settings = { ...settings, createPrice: 3000, rentPrice: 1000 };
    await PersonalRoleService.destroy(guild, free.role.id, { id: OWNER, source: 'discord' });
    balances.set(OWNER, 5000);
    const again = (await PersonalRoleService.create(guild, owner, { name: 'Ёж-2' })).doc;
    const granted = await PersonalRoleService.grant(guild, again.roleId, 10, { id: 'mod', source: 'panel' });
    assert.ok(granted.ok);
    assert.strictEqual((await PersonalRoleService.destroy(guild, again.roleId, { id: BUYER, source: 'discord' })).code, 'not_owner');
    assert.ok((await PersonalRoleService.destroy(guild, again.roleId, { id: 'mod', source: 'panel' })).ok, 'an administrator may delete');
    assert.strictEqual(store.size, 0);
}

function legacy() {
    const rows = [
        { id: OWNER, historytrans: JSON.stringify([{ cause: 'Создание личной роли <@&111>', time: '2025-01-01T00:00:00Z' }, { cause: 'Создание личной роли <@&222>', time: '2025-01-02T00:00:00Z' }]) },
        { id: '200000000000000099', historytrans: JSON.stringify([{ cause: 'Создание личной роли <@&333>', time: '2025-01-03T00:00:00Z' }]) }
    ];
    const roles = new Map([['111', {}], ['333', {}]]); // 222 no longer exists
    const docs = legacyPersonalRoles(rows, guild.id, {
        roles, holdersOf: id => (id === '111' ? [BUYER] : []), memberIds: new Set([OWNER, BUYER]), periodDays: 30, now: 0
    });
    assert.deepStrictEqual(docs.map(d => [d.roleId, d.ownerId, d.ownerWears, d.buyers.map(b => [b.userId, b.permanent])]), [['111', OWNER, false, [[BUYER, true]]]], 'gone roles and owners who left are skipped');
    assert.strictEqual(docs[0].expiresAt, new Date(30 * DAY).toISOString());
}

(async () => {
    const roleId = await renting();
    await selling(roleId);
    await time(roleId);
    await adminAndLeaving();
    legacy();
    console.log('personal roles tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
