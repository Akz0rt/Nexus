// Standalone test (no test framework configured): run with `node test/roles.test.js`
// Temporary roles (refused over a permanent role, extended, expired), presets
// (checked at use time, one request), approval with extra roles and its undo,
// and background mass changes.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const EventBus = require('../src/services/EventBus');
const TempRoleService = require('../src/modules/roles/TempRoleService');
const PresetService = require('../src/modules/roles/PresetService');
const RoleService = require('../src/services/RoleService');
const RoleJobService = require('../src/modules/roles/RoleJobService');
const rolesModule = require('../src/modules/roles');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const VerificationService = require('../src/modules/verification/VerificationService');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';
const EVENT = '500000000000000001';
const HELPER = '500000000000000002';
const ADMIN = '500000000000000003';

let logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };

// In-memory temp_roles that keeps the real index logic
const grants = new Map();
const key = (g, u, r) => `${g}:${u}:${r}`;
TempRoleService.initialize = async () => {};
TempRoleService.get = async (g, u, r) => grants.get(key(g, u, r)) || null;
TempRoleService.set = async grant => {
    grants.set(key(grant.guildId, grant.userId, grant.roleId), { ...grant });
    TempRoleService.index.add(key(grant.guildId, grant.userId, grant.roleId));
    return grant;
};
TempRoleService.remove = async (g, u, r) => {
    TempRoleService.index.delete(key(g, u, r));
    return grants.delete(key(g, u, r));
};
TempRoleService.list = async g => [...grants.values()].filter(grant => grant.guildId === g);
TempRoleService.listDue = async (now = new Date()) => [...grants.values()].filter(grant => grant.expiresAt <= now.toISOString());

const presets = new Map();
PresetService.get = async (g, id) => presets.get(id) || null;
PresetService.save = async preset => { const doc = { ...preset, id: preset.id || `p${presets.size + 1}` }; presets.set(doc.id, doc); return doc; };
PresetService.remove = async (g, id) => presets.delete(id);

function setup() {
    logged = [];
    grants.clear();
    TempRoleService.index.clear();
    presets.clear();
    const guild = makeGuild();
    const role = (id, name, position, extra = {}) => {
        const r = { id, name, position, managed: false, editable: true, hexColor: '#3fa7ff', ...extra };
        guild.roles.cache.set(id, r);
        return r;
    };
    role(EVENT, 'Ивент', 1);
    role(HELPER, 'Хелпер', 2);
    role(ADMIN, 'Админ', 20);
    const manage = flag => flag === PermissionFlagsBits.ManageRoles;
    makeMember(guild, MOD, { position: 10, perms: manage });
    for (const id of [A, B, C]) makeMember(guild, id, {});
    // Roles given by id (presets, approval) as well as by object
    for (const member of guild.members.cache.values()) {
        member.roles.add = async (roles, reason) => {
            member.roleCalls = (member.roleCalls || 0) + 1;
            member.lastReason = reason;
            for (const r of [].concat(roles)) {
                const id = typeof r === 'string' ? r : r.id;
                member.roles.cache.set(id, guild.roles.cache.get(id) || { id });
            }
        };
        member.roles.remove = async r => { member.roles.cache.delete(typeof r === 'string' ? r : r.id); };
    }
    guild.memberCount = guild.members.cache.size;
    return guild;
}

const actor = { id: MOD, tag: 'mod' };

async function temporaryRoles() {
    const guild = setup();
    const a = guild.members.cache.get(A);
    const b = guild.members.cache.get(B);
    b.roles.cache.set(EVENT, guild.roles.cache.get(EVENT)); // B has it for good

    const result = await RoleService.bulkRole(guild, [A, B], EVENT, true, actor, 'panel', { duration: '1h' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.done, [A]);
    assert.deepStrictEqual(result.failed.map(f => [f.userId, f.code]), [[B, 'has_permanent']]);
    assert.ok(a.roles.cache.has(EVENT));
    const grant = grants.get(key(guild.id, A, EVENT));
    assert.ok(grant && Date.parse(grant.expiresAt) > Date.now() + 59 * 60 * 1000);
    assert.strictEqual(logged[0].details.durationMs, 60 * 60 * 1000);

    // Again for 7 days: extended, not refused
    await RoleService.bulkRole(guild, [A], EVENT, true, actor, 'panel', { duration: '7d' });
    assert.ok(Date.parse(grants.get(key(guild.id, A, EVENT)).expiresAt) > Date.now() + 6 * 24 * 3600 * 1000);

    // Unknown duration is refused before anything happens
    const bad = await RoleService.bulkRole(guild, [C], EVENT, true, actor, 'panel', { duration: '2y' });
    assert.strictEqual(bad.code, 'invalid_duration');

    // Taking it away drops the record
    await RoleService.bulkRole(guild, [A], EVENT, false, actor, 'panel');
    assert.ok(!a.roles.cache.has(EVENT));
    assert.strictEqual(grants.size, 0);
    assert.strictEqual(TempRoleService.has(guild.id, A, EVENT), false);

    // Given for good over a temporary one: becomes permanent
    await RoleService.bulkRole(guild, [C], EVENT, true, actor, 'panel', { duration: '1h' });
    await RoleService.bulkRole(guild, [C], EVENT, true, actor, 'panel');
    assert.strictEqual(grants.size, 0);
    assert.ok(guild.members.cache.get(C).roles.cache.has(EVENT));
}

async function expiry() {
    const guild = setup();
    const a = guild.members.cache.get(A);
    await RoleService.bulkRole(guild, [A], HELPER, true, actor, 'panel', { duration: '1h' });
    grants.get(key(guild.id, A, HELPER)).expiresAt = new Date(Date.now() - 1000).toISOString();
    logged = [];

    const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
    const taken = await rolesModule.processExpiredRoles(client);
    assert.strictEqual(taken, 1);
    assert.ok(!a.roles.cache.has(HELPER));
    assert.strictEqual(grants.size, 0);
    assert.deepStrictEqual(logged.map(e => [e.action, e.source, e.details.roleName]), [['roles.temp_expired', 'auto', 'Хелпер']]);

    // The bot can't take it any more: the moderators see it in the journal, no endless retries
    await RoleService.bulkRole(guild, [C], HELPER, true, actor, 'panel', { duration: '1h' });
    grants.get(key(guild.id, C, HELPER)).expiresAt = new Date(Date.now() - 1000).toISOString();
    guild.members.cache.get(C).roles.remove = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    logged = [];
    assert.strictEqual(await rolesModule.processExpiredRoles(client), 0);
    assert.strictEqual(grants.size, 0);
    assert.strictEqual(logged[0].details.failed, true);

    // Someone left: record dropped without touching Discord
    await RoleService.bulkRole(guild, [B], HELPER, true, actor, 'panel', { duration: '1h' });
    grants.get(key(guild.id, B, HELPER)).expiresAt = new Date(Date.now() - 1000).toISOString();
    guild.members.cache.delete(B);
    assert.strictEqual(await rolesModule.processExpiredRoles(client), 0);
    assert.strictEqual(grants.size, 0);
}

async function presetsAtUseTime() {
    const guild = setup();
    const saved = await RoleService.savePreset(guild, { name: '  Ивентер ', roleIds: [EVENT, HELPER] }, actor, 'panel');
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.preset.name, 'Ивентер');
    // A role above the moderator can't go into a preset
    const refused = await RoleService.savePreset(guild, { name: 'Админы', roleIds: [ADMIN] }, actor, 'panel');
    assert.strictEqual(refused.code, 'role_higher');

    // Later the helper role moves above the bot: skipped, the rest still given in one call
    guild.roles.cache.get(HELPER).editable = false;
    const a = guild.members.cache.get(A);
    const applied = await RoleService.applyPreset(guild, A, saved.preset.id, actor, 'panel');
    assert.strictEqual(applied.ok, true);
    assert.deepStrictEqual(applied.added, ['Ивент']);
    assert.deepStrictEqual(applied.skipped.map(s => s.code), ['bot_cannot_role']);
    assert.strictEqual(a.roleCalls, 1);
    assert.ok(a.roles.cache.has(EVENT));
    assert.strictEqual(logged.at(-1).action, 'roles.preset_applied');

    // A moderator without Manage Roles may not use presets
    const noRoles = await RoleService.applyPreset(guild, A, saved.preset.id, { id: A }, 'panel');
    assert.strictEqual(noRoles.code, 'forbidden');
}

async function approveWithExtras() {
    const guild = setup();
    GuildSettingsService.get = async guildId => ({
        guildId, unverifiedRoleId: 'unv', maleRoleId: 'male', femaleRoleId: 'female',
        verifyQueueChannelId: 'queue', modules: { verification: true }
    });
    const cards = {};
    QueueCardService.get = async (g, u) => (cards[u] ? { ...cards[u] } : null);
    QueueCardService.upsert = async card => { cards[card.userId] = { ...card }; return card; };
    VerificationService.renderCard = async card => card;

    const a = guild.members.cache.get(A);
    a.roles.cache.set('unv', { id: 'unv' });
    const sets = [];
    a.roles.set = async (ids, reason) => { sets.push(ids); a.roles.cache = new Map(ids.map(id => [id, { id }])); };
    guild.members.fetch = async arg => {
        const id = typeof arg === 'string' ? arg : arg?.user;
        const member = guild.members.cache.get(id);
        if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return member;
    };

    const result = await VerificationService.approve(guild, A, 'female', actor, 'panel', { extraRoleIds: [EVENT, ADMIN, 'unv', 'male'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(sets.length, 1, 'gender and extra roles go in one request');
    assert.deepStrictEqual([...sets[0]].sort(), ['female', EVENT].sort(), '@unverified and the other gender role are never extras');
    assert.deepStrictEqual(result.skippedRoles.map(r => [r.id, r.code]), [[ADMIN, 'role_higher']]);
    assert.deepStrictEqual(cards[A].extraRoleIds, [EVENT]);
    assert.deepStrictEqual(logged.at(-1).details.extraRoles, ['Ивент']);

    const undo = await VerificationService.undoApprove(guild, A, actor, 'panel');
    assert.strictEqual(undo.ok, true);
    assert.deepStrictEqual([...sets[1]].sort(), ['unv'], 'undo takes the extra roles away too');
    assert.deepStrictEqual(cards[A].extraRoleIds, []);
}

async function massJobs() {
    const guild = setup();
    for (const id of [A, B, C]) guild.members.cache.get(id).roles.cache.set(HELPER, guild.roles.cache.get(HELPER));
    guild.members.cache.get(C).roles.remove = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    const bot = makeMember(guild, '900000000000000001', { bot: true });
    bot.roles.cache.set(HELPER, guild.roles.cache.get(HELPER));

    const events = [];
    const onJob = job => events.push({ ...job });
    EventBus.on('job', onJob);

    const filter = { type: 'role', id: HELPER };
    const preview = await RoleJobService.preview(guild, { roleId: HELPER, add: false, filter }, actor);
    assert.strictEqual(preview.count, 3, 'bots are left out');

    const started = await RoleJobService.start(guild, { roleId: HELPER, add: false, filter }, actor, 'panel');
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.job.total, 3);
    const second = await RoleJobService.start(guild, { roleId: HELPER, add: false, filter }, actor, 'panel');
    assert.strictEqual(second.code, 'job_running');

    for (let i = 0; i < 50 && RoleJobService.current(guild.id).status !== 'done'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const job = RoleJobService.current(guild.id);
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(job.doneCount, 2);
    assert.deepStrictEqual(job.failedIds, [C]);
    assert.strictEqual(events.at(-1).status, 'done');
    const entry = logged.at(-1);
    assert.strictEqual(entry.action, 'roles.removed');
    assert.strictEqual(entry.details.count, 2);
    assert.strictEqual(entry.details.total, 3);

    // Retry for the failed ones; nobody left → refused
    guild.members.cache.get(C).roles.remove = async () => { guild.members.cache.get(C).roles.cache.delete(HELPER); };
    const retry = await RoleJobService.start(guild, { roleId: HELPER, add: false, filter: { type: 'users', userIds: job.failedIds } }, actor, 'panel');
    assert.strictEqual(retry.ok, true);
    for (let i = 0; i < 50 && RoleJobService.current(guild.id).status !== 'done'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const nobody = await RoleJobService.start(guild, { roleId: HELPER, add: false, filter }, actor, 'panel');
    assert.strictEqual(nobody.code, 'nobody');

    const higher = await RoleJobService.start(guild, { roleId: ADMIN, add: true, filter: { type: 'all' } }, actor, 'panel');
    assert.strictEqual(higher.code, 'role_higher');
    EventBus.off('job', onJob);
}

async function cleanupOnManualRemoval() {
    const guild = setup();
    await RoleService.bulkRole(guild, [A], EVENT, true, actor, 'panel', { duration: '1d' });
    const handlers = {};
    rolesModule.register({ on: (event, fn) => { handlers[event] = fn; } });
    const a = guild.members.cache.get(A);
    a.guild = guild;
    a.roles.cache.delete(EVENT);
    handlers.guildMemberUpdate({}, a);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(grants.size, 0);
}

(async () => {
    await temporaryRoles();
    await expiry();
    await presetsAtUseTime();
    await approveWithExtras();
    await massJobs();
    await cleanupOnManualRemoval();
    console.log('roles tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
