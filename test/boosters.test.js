// Standalone test (no test framework configured): run with `node test/boosters.test.js`
// Booster accounts: «Бустер…» from the queue gives a marker role with no permissions
// (made once), keeps @unverified and takes them out of the queue; the term is extended,
// the account goes back to the queue, or is kicked when the term ends — with one warning
// a day before; leaving early and stopping the boost are reported.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const VerificationService = require('../src/modules/verification/VerificationService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const BoosterPassService = require('../src/modules/boosters/BoosterPassService');
const { inQueue } = require('../src/web/v2/routes/queue');

const MOD = '100000000000000001';
const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';
const UNVERIFIED = '700000000000000001';
const DAY = 24 * 60 * 60 * 1000;

// Booster passes in memory, shaped like the Cosmos container
const docs = new Map();
BoosterPassService.initialized = true;
BoosterPassService.container = {
    items: {
        query: spec => ({
            fetchAll: async () => {
                const all = [...docs.values()];
                if (typeof spec === 'string') return { resources: all };
                const soon = spec.parameters.find(p => p.name === '@soon');
                if (soon) return { resources: all.filter(d => d.until <= soon.value) };
                const guildId = spec.parameters.find(p => p.name === '@guildId').value;
                return { resources: all.filter(d => d.guildId === guildId).sort((a, b) => a.until.localeCompare(b.until)) };
            }
        }),
        upsert: async doc => { docs.set(doc.id, JSON.parse(JSON.stringify(doc))); }
    },
    item: id => ({
        read: async () => {
            if (!docs.has(id)) throw Object.assign(new Error('nf'), { code: 404 });
            return { resource: JSON.parse(JSON.stringify(docs.get(id))) };
        },
        delete: async () => { docs.delete(id); }
    })
};

const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };
let settingsDoc = {};
VerificationService.getQueueSettings = async () => ({ unverifiedRoleId: UNVERIFIED, boosterRoleId: settingsDoc.boosterRoleId || null });
GuildSettingsService.update = async (guildId, patch) => { settingsDoc = { ...settingsDoc, ...patch }; return settingsDoc; };
const cards = new Map();
QueueCardService.get = async (guildId, userId) => cards.get(userId) || null;
QueueCardService.upsert = async card => { cards.set(card.userId, card); return card; };
VerificationService.safeRender = async () => {};

const roles = new Collection();
const created = [];
const kicked = [];
let kickRefused = false;
const guild = {
    id: '900000000000000009',
    ownerId: 'owner',
    roles: {
        cache: roles,
        create: async options => {
            const role = { id: '800000000000000001', ...options, editable: true };
            created.push(options);
            roles.set(role.id, role);
            return role;
        }
    },
    members: { cache: new Collection(), me: { permissions: { has: () => true } } }
};
guild.members.fetch = async id => {
    const member = guild.members.cache.get(typeof id === 'string' ? id : id?.user);
    if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return member;
};
function member(id, { position = 1, perms = () => false } = {}) {
    const m = {
        id, guild, user: { id, bot: false }, premiumSince: null, kickable: true,
        roles: { highest: { position }, cache: new Collection([[UNVERIFIED, { id: UNVERIFIED }]]) },
        permissions: { has: perms },
        kick: async () => {
            if (kickRefused) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            kicked.push(id);
            guild.members.cache.delete(id);
            await BoosterPassService.onLeave(m); // Discord's GuildMemberRemove for our own kick
        }
    };
    m.roles.add = async role => { m.roles.cache.set(role.id || role, role); };
    m.roles.remove = async roles => { for (const role of [roles].flat()) m.roles.cache.delete(role.id || role); };
    guild.members.cache.set(id, m);
    return m;
}
member(MOD, { position: 10, perms: () => true }).roles.cache.clear();
const a = member(A);
const b = member(B);
member(C).roles.cache.clear(); // not in the queue
const mod = { id: MOD, tag: 'mod' };
const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
const settings = () => ({ unverifiedRoleId: UNVERIFIED, boosterRoleId: settingsDoc.boosterRoleId || null });

(async () => {
    const until = new Date(Date.now() + 30 * DAY).toISOString();
    assert.strictEqual((await BoosterPassService.pass(guild, [A], { until: new Date(Date.now() + 5 * 60000).toISOString() }, mod)).code, 'invalid_term');
    assert.strictEqual((await BoosterPassService.pass(guild, [A], { until }, { id: C, tag: 'c' })).code, 'forbidden');

    // Two at once (one isn't in the queue): the role is made once, with no permissions
    const passed = await BoosterPassService.pass(guild, [A, B, C], { until, note: 'куплено у X' }, mod);
    assert.strictEqual(passed.ok, true, JSON.stringify(passed));
    assert.deepStrictEqual(passed.done, [A, B]);
    assert.deepStrictEqual(passed.failed.map(f => f.userId), [C]);
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(created[0].permissions, [], 'the marker role has no permissions');
    assert.strictEqual(settingsDoc.boosterRoleId, '800000000000000001', 'saved in the settings');
    assert.ok(a.roles.cache.has(UNVERIFIED), '@unverified stays: they see nothing');
    assert.ok(a.roles.cache.has('800000000000000001'));
    assert.strictEqual(inQueue(a, settings()), false, 'out of the queue');
    assert.strictEqual(cards.get(A).status, 'booster');
    assert.strictEqual(logged.at(-1).action, 'booster.passed');
    assert.deepStrictEqual(logged.at(-1).targetIds, [A, B]);
    // A second pass reuses the role
    await BoosterPassService.release(guild, B, mod);
    assert.strictEqual(inQueue(b, settings()), true, 'back in the queue');
    assert.strictEqual(cards.get(B).status, 'pending');
    await BoosterPassService.pass(guild, [B], { until }, mod);
    assert.strictEqual(created.length, 1);

    // The queue's own approve/kick never touch a booster account
    const refused = await VerificationService.withQueuedMember(guild, A, settings(), async () => ({ ok: true }));
    assert.strictEqual(refused.code, 'booster_account');

    // Extend
    const later = new Date(Date.now() + 60 * DAY).toISOString();
    assert.strictEqual((await BoosterPassService.extend(guild, A, later, mod)).ok, true);
    assert.strictEqual(docs.get(A).until, later);
    assert.strictEqual(cards.get(A).boosterUntil, later);

    // A day before: one warning for the server, once
    const now = Date.parse(until) - 12 * 60 * 60 * 1000;
    await BoosterPassService.processDue(client, now);
    await BoosterPassService.processDue(client, now + 60000);
    const warnings = logged.filter(e => e.action === 'booster.expiring');
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0].targetIds, [B]);

    // Stopping the boost is reported
    const boosting = { ...b, premiumSince: new Date() };
    await BoosterPassService.onBoostChange(boosting, b);
    assert.strictEqual(logged.at(-1).action, 'booster.unboosted');

    // A refused kick is reported once, not every round
    kickRefused = true;
    await BoosterPassService.processDue(client, Date.parse(until) + 1000);
    await BoosterPassService.processDue(client, Date.parse(until) + 2000);
    assert.strictEqual(logged.filter(e => e.action === 'booster.expired' && e.details.failed).length, 1);
    kickRefused = false;

    // The term is over: kicked, the pass forgotten, our own kick isn't «ушёл сам»
    await BoosterPassService.processDue(client, Date.parse(until) + 3000);
    assert.deepStrictEqual(kicked, [B]);
    assert.ok(!docs.has(B));
    assert.strictEqual(cards.get(B).status, 'booster_ended');
    assert.ok(!logged.some(e => e.action === 'booster.left'), 'no «left» for our own kick');
    assert.ok(logged.some(e => e.action === 'booster.expired' && !e.details.failed));

    // Leaving on their own before the term
    guild.members.cache.delete(A);
    await BoosterPassService.onLeave(a);
    assert.strictEqual(logged.at(-1).action, 'booster.left');
    assert.ok(!docs.has(A));
    console.log('booster tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
