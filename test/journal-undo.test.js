// Standalone test (no test framework configured): run with `node test/journal-undo.test.js`
// «Отменить» in the journal: each undoable action goes through its service with the permission
// the action needs; a pass goes back to the queue for any moderator with Manage Roles, any time,
// unless the roles were changed by hand; an undone entry can't be undone twice.
// Plus the stats' decisions per day.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '', timezone: 'UTC' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const ModerationService = require('../src/modules/moderation/ModerationService');
const VerificationService = require('../src/modules/verification/VerificationService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const { dailyDecisions } = require('../src/web/v2/routes/stats');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const HELPER = '100000000000000002';
const NEWBIE = '300000000000000001';
const UNVERIFIED = '700000000000000001';
const MALE = '700000000000000002';
const EXTRA = '700000000000000003';

const entries = new Map();
const logged = [];
AuditLogService.get = async (guildId, id) => entries.get(id) || null;
AuditLogService.markUndone = async (entry, actor, { outdated = false } = {}) => { entries.set(entry.id, { ...entry, undoneAt: 'now', undoneBy: actor.id, outdated }); };
AuditLogService.query = async ({ targetId, action, since }) => ({
    items: [...entries.values()].filter(e => e.action === action && e.targetIds.includes(targetId) && e.createdAt >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
});
AuditLogService.log = async entry => { logged.push(entry); return entry; };
let clock = Date.parse('2026-10-20T10:00:00Z');
const add = (id, action, targetIds, details = {}) => entries.set(id, { id, action, targetIds, details, guildId: 'g', createdAt: new Date(clock += 1000).toISOString() });

const calls = [];
ModerationService.unwarn = async (guild, warnId) => { calls.push(`unwarn ${warnId}`); return { ok: true }; };
ModerationService.unmute = async (guild, userId) => { calls.push(`unmute ${userId}`); return { ok: false, code: 'not_muted' }; };

VerificationService.getQueueSettings = async () => ({ unverifiedRoleId: UNVERIFIED, maleRoleId: MALE, femaleRoleId: 'f' });
VerificationService.safeRender = async () => {};
let card = { userId: NEWBIE, status: 'approved', gender: 'male', extraRoleIds: [EXTRA], handledBy: 'someone-else', handledAt: new Date(Date.now() - 3 * 86400000).toISOString() };
QueueCardService.get = async () => card;
QueueCardService.upsert = async next => { card = next; return next; };

const guild = makeGuild();
guild.iconURL = () => null;
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.ManageRoles || flag === PermissionFlagsBits.ModerateMembers });
makeMember(guild, HELPER, { position: 10, perms: flag => flag === PermissionFlagsBits.ModerateMembers });
const newbie = makeMember(guild, NEWBIE);
newbie.roles.cache = new Collection([[MALE, { id: MALE }], [EXTRA, { id: EXTRA }], ['keep', { id: 'keep' }]]);
newbie.roles.set = async ids => { newbie.roles.cache = new Collection(ids.map(id => [id, { id }])); };
guild.memberCount = guild.members.cache.size;

(async () => {
    // Decisions per day: the period's days in order, empty days included
    const now = Date.parse('2026-10-20T12:00:00Z');
    const days = dailyDecisions([
        { status: 'approved', handledAt: '2026-10-20T08:00:00Z' },
        { status: 'approved', handledAt: '2026-10-18T08:00:00Z' },
        { status: 'kicked', handledAt: '2026-10-18T09:00:00Z' },
        { status: 'approved', handledAt: '2026-09-01T09:00:00Z' }
    ], 3, 'UTC', now);
    assert.deepStrictEqual(days, [
        { date: '2026-10-18', approved: 1, kicked: 1 },
        { date: '2026-10-19', approved: 0, kicked: 0 },
        { date: '2026-10-20', approved: 1, kicked: 0 }
    ]);

    // Around the clock change (Berlin, 25.10) every day is there once
    assert.deepStrictEqual(dailyDecisions([], 3, 'Europe/Berlin', Date.parse('2026-10-26T23:30:00Z')).map(d => d.date), ['2026-10-25', '2026-10-26', '2026-10-27']);

    let token = 'mod';
    PanelSessionService.get = async t => ({ mod: { userId: MOD, username: 'mod' }, helper: { userId: HELPER, username: 'helper' } }[t] || null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const undo = async id => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}/audit/${id}/undo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json() };
    };
    try {
        add('w', 'moderation.warned', [NEWBIE], { warnId: 'warn-1' });
        assert.strictEqual((await undo('w')).status, 200);
        assert.deepStrictEqual(calls, ['unwarn warn-1']);
        assert.strictEqual((await undo('w')).body.error, 'already_undone', 'not twice');

        add('m', 'moderation.muted', [NEWBIE]);
        const stale = await undo('m');
        assert.strictEqual(stale.body.error, 'not_muted', 'the service says why');
        assert.strictEqual(stale.body.outdated, true);
        assert.ok(entries.get('m').outdated, 'nothing left to undo: the entry stops offering it');

        // An older mute must not lift a newer one
        add('m1', 'moderation.muted', [HELPER]);
        add('m2', 'moderation.muted', [HELPER]);
        assert.strictEqual((await undo('m1')).body.error, 'newer_action');
        // A group bigger than one click undoes
        add('big', 'roles.added', Array.from({ length: 101 }, (_, i) => `4000000000000${String(i).padStart(5, '0')}`), { roleId: EXTRA });
        assert.strictEqual((await undo('big')).body.error, 'too_many_to_undo');

        add('x', 'moderation.kicked', [NEWBIE]);
        assert.strictEqual((await undo('x')).body.error, 'cannot_undo');
        assert.strictEqual((await undo('nope')).status, 404);

        // A pass from three days ago by someone else: back to the queue, gender and extra roles gone
        add('p', 'verification.approved', [NEWBIE], { gender: 'male' });
        token = 'helper';
        assert.strictEqual((await undo('p')).status, 403, 'needs Manage Roles');
        token = 'mod';
        const back = await undo('p');
        assert.strictEqual(back.status, 200, JSON.stringify(back.body));
        assert.deepStrictEqual([...newbie.roles.cache.keys()].sort(), ['keep', UNVERIFIED].sort());
        assert.strictEqual(card.status, 'pending');
        assert.strictEqual(logged.at(-1).action, 'verification.undone');

        // Roles changed by hand since: refused
        card = { ...card, status: 'approved', gender: 'male', handledBy: MOD, handledAt: new Date().toISOString() };
        add('p2', 'verification.approved', [NEWBIE], { gender: 'male' });
        assert.strictEqual((await undo('p2')).body.error, 'roles_changed');
        console.log('journal undo tests passed');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
