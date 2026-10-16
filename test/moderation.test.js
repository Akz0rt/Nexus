// Standalone test (no test framework configured): run with `node test/moderation.test.js`
// Verifies role hierarchy checks, warn escalation (2 → 1 h, 3 → 1 d, 5 → ban proposal),
// that warns are silent while mutes and bans DM the user, and temporary bans.

const assert = require('assert');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const WarningService = require('../src/modules/moderation/WarningService');
const TempBanService = require('../src/modules/moderation/TempBanService');
const ModerationService = require('../src/modules/moderation/ModerationService');
const { targetProblem } = require('../src/modules/moderation/ModerationService');
const { DEFAULT_REASONS, DEFAULT_ESCALATION, escalationFor, formatDuration } = require('../src/modules/moderation/templates');

const HOUR_MS = 60 * 60 * 1000;

let warns;
let logged;
let tempBans;

function setup() {
    GuildSettingsService.get = async guildId => ({
        guildId,
        verifyQueueChannelId: 'modchan',
        moderation: { reasons: DEFAULT_REASONS, escalation: DEFAULT_ESCALATION }
    });

    warns = [];
    let seq = 0;
    WarningService.add = async warn => {
        await new Promise(resolve => setTimeout(resolve, 20)); // slow DB write
        const doc = { ...warn, id: `w${++seq}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e9).toISOString() };
        warns.push(doc);
        return doc;
    };
    WarningService.listActive = async (guildId, userId) => warns.filter(w => !userId || w.userId === userId).slice().reverse();
    WarningService.get = async (guildId, id) => warns.find(w => w.id === id) || null;
    WarningService.remove = async (guildId, id) => { warns = warns.filter(w => w.id !== id); return true; };

    tempBans = new Map();
    TempBanService.set = async ban => { tempBans.set(ban.userId, ban); return ban; };
    TempBanService.remove = async (guildId, userId) => tempBans.delete(userId);
    TempBanService.listDue = async () => [...tempBans.values()].filter(b => b.unbanAt <= new Date().toISOString());

    logged = [];
    AuditLogService.log = async entry => { logged.push(entry); return entry; };
}

function makeMember(id, position, extra = {}) {
    const member = {
        id,
        displayName: id,
        user: {
            id,
            bot: false,
            dms: [],
            send: async text => { member.user.dms.push(text); },
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
        },
        roles: { highest: { position } },
        permissions: { has: () => true },
        moderatable: true,
        kickable: true,
        bannable: true,
        timeouts: [],
        communicationDisabledUntilTimestamp: null,
        isCommunicationDisabled: () => (member.communicationDisabledUntilTimestamp || 0) > Date.now(),
        timeout: async ms => {
            member.timeouts.push(ms);
            member.communicationDisabledUntilTimestamp = ms ? Date.now() + ms : null;
        },
        kick: async () => { member.kicked = true; },
        ...extra
    };
    return member;
}

function makeGuild(members) {
    const byId = new Map(members.map(m => [m.id, m]));
    const sent = [];
    const bans = new Map();
    const guild = {
        id: 'g1',
        name: 'Тестовый',
        ownerId: 'owner',
        members: {
            fetch: async arg => {
                const member = byId.get(typeof arg === 'string' ? arg : arg.user);
                if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
                return member;
            }
        },
        bans: {
            fetch: async ({ user }) => {
                if (!bans.has(user)) throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
                return bans.get(user);
            },
            create: async (userId, options) => { bans.set(userId, options); },
            remove: async userId => {
                if (!bans.has(userId)) throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
                bans.delete(userId);
            }
        },
        client: {
            channels: { fetch: async () => ({ send: async payload => { sent.push(payload); } }) },
            users: { fetch: async id => ({ id, send: async () => { throw new Error('should not DM non-members'); } }) },
            guilds: { cache: new Map() }
        }
    };
    guild.client.guilds.cache.set(guild.id, guild);
    return { guild, sent, bans };
}

const MOD = { id: 'mod', tag: 'Mod' };

function hierarchy() {
    const { guild } = makeGuild([]);
    const actor = makeMember('mod', 10);
    assert.strictEqual(targetProblem(guild, actor, makeMember('u', 5), 'moderatable'), null);
    assert.strictEqual(targetProblem(guild, actor, makeMember('mod', 5), null), 'self');
    assert.strictEqual(targetProblem(guild, actor, makeMember('owner', 1), null), 'target_protected');
    const bot = makeMember('b', 1);
    bot.user.bot = true;
    assert.strictEqual(targetProblem(guild, actor, bot, null), 'target_protected');
    assert.strictEqual(targetProblem(guild, actor, makeMember('peer', 10), null), 'target_higher');
    assert.strictEqual(targetProblem(guild, actor, makeMember('boss', 20), null), 'target_higher');
    // The owner may act on anyone below the bot
    assert.strictEqual(targetProblem(guild, makeMember('owner', 1), makeMember('boss', 20), null), null);
    assert.strictEqual(targetProblem(guild, actor, makeMember('u', 5, { moderatable: false }), 'moderatable'), 'bot_cannot');
}

function templates() {
    assert.strictEqual(escalationFor(1), null);
    assert.deepStrictEqual(escalationFor(2), { warns: 2, action: 'timeout', durationMs: HOUR_MS });
    assert.strictEqual(escalationFor(4), null);
    assert.strictEqual(escalationFor(5).action, 'propose_ban');
    assert.strictEqual(formatDuration(HOUR_MS), '1 час');
    assert.strictEqual(formatDuration(6 * HOUR_MS), '6 часов');
    assert.strictEqual(formatDuration(24 * HOUR_MS), '1 день');
    assert.strictEqual(formatDuration(7 * 24 * HOUR_MS), '7 дней');
    assert.strictEqual(formatDuration(10 * 60 * 1000), '10 минут');
}

async function escalation() {
    setup();
    const target = makeMember('u1', 1);
    const { guild, sent } = makeGuild([makeMember('mod', 10), target]);

    const first = await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'discord');
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.activeCount, 1);
    assert.strictEqual(first.escalation, null);
    assert.deepStrictEqual(target.user.dms, [], 'a warn alone must not DM the user');

    const second = await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'discord');
    assert.deepStrictEqual(second.escalation, { action: 'timeout', ok: true, durationMs: HOUR_MS });
    assert.deepStrictEqual(target.timeouts, [HOUR_MS]);
    assert.strictEqual(target.user.dms.length, 1, 'the escalation mute DMs the user');
    assert.ok(target.user.dms[0].includes('1 час') && target.user.dms[0].includes('Эскалация: 2 варна'));

    const third = await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'discord');
    assert.strictEqual(third.escalation.durationMs, 24 * HOUR_MS);

    await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'discord');
    const fifth = await ModerationService.warn(guild, 'u1', 'Оскорбления', MOD, 'discord');
    assert.deepStrictEqual(fifth.escalation, { action: 'propose_ban', ok: true });
    assert.strictEqual(sent.length, 1, 'ban proposal goes to the moderators channel');
    assert.strictEqual(sent[0].components[0].components[0].data.custom_id, 'mod:ban:u1');

    const actions = logged.map(e => `${e.action}/${e.source}`);
    assert.deepStrictEqual(actions, [
        'moderation.warned/discord',
        'moderation.warned/discord', 'moderation.muted/auto',
        'moderation.warned/discord', 'moderation.muted/auto',
        'moderation.warned/discord',
        'moderation.warned/discord', 'moderation.ban_proposed/auto'
    ]);
}

async function concurrentWarns() {
    setup();
    const target = makeMember('u1', 1);
    const { guild } = makeGuild([makeMember('mod', 10), target]);
    const results = await Promise.all([1, 2, 3].map(() => ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'panel')));
    assert.deepStrictEqual(results.map(r => r.activeCount).sort(), [1, 2, 3]);
    assert.deepStrictEqual(target.timeouts, [HOUR_MS, 24 * HOUR_MS], 'each escalation step exactly once');
}

async function longerMuteKept() {
    setup();
    const target = makeMember('u1', 1);
    target.communicationDisabledUntilTimestamp = Date.now() + 7 * 24 * HOUR_MS;
    const { guild } = makeGuild([makeMember('mod', 10), target]);
    await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'panel');
    const second = await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'panel');
    assert.strictEqual(second.escalation.ok, false);
    assert.deepStrictEqual(target.timeouts, [], 'a 7-day mute must not be cut to 1 hour');
}

async function permissionsAndHierarchy() {
    setup();
    const noPerms = makeMember('mod', 10, { permissions: { has: () => false } });
    const { guild } = makeGuild([noPerms, makeMember('u1', 1), makeMember('peer', 10)]);
    assert.strictEqual((await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'panel')).code, 'forbidden');

    setup();
    const { guild: guild2 } = makeGuild([makeMember('mod', 10), makeMember('peer', 10)]);
    assert.strictEqual((await ModerationService.mute(guild2, 'peer', '1h', 'Флуд', MOD, 'panel')).code, 'target_higher');
    assert.strictEqual((await ModerationService.warn(guild2, 'u1', '  ', MOD, 'panel')).code, 'reason_required');
    assert.strictEqual((await ModerationService.mute(guild2, 'peer', '2h', 'Флуд', MOD, 'panel')).code, 'invalid_duration');
    assert.strictEqual((await ModerationService.warn(guild2, 'ghost', 'Флуд', MOD, 'panel')).code, 'member_not_found');
    assert.deepStrictEqual(logged, []);
}

async function muteAndUnmute() {
    setup();
    const target = makeMember('u1', 1);
    const { guild } = makeGuild([makeMember('mod', 10), target]);
    assert.strictEqual((await ModerationService.unmute(guild, 'u1', MOD, 'panel')).code, 'not_muted');
    const muted = await ModerationService.mute(guild, 'u1', '6h', 'Оскорбления', MOD, 'panel');
    assert.strictEqual(muted.ok, true);
    assert.ok(target.user.dms[0].includes('6 часов') && target.user.dms[0].includes('Оскорбления'));
    assert.strictEqual((await ModerationService.unmute(guild, 'u1', MOD, 'panel')).ok, true);
    assert.deepStrictEqual(target.timeouts, [6 * HOUR_MS, null]);
    assert.deepStrictEqual(logged.map(e => e.action), ['moderation.muted', 'moderation.unmuted']);
}

async function bans() {
    setup();
    const target = makeMember('u1', 1);
    const { guild, bans: guildBans } = makeGuild([makeMember('mod', 10), target]);

    const banned = await ModerationService.ban(guild, 'u1', { reason: 'Скам', duration: '7d', deleteMessageDays: 1 }, MOD, 'panel');
    assert.strictEqual(banned.ok, true);
    assert.ok(target.user.dms[0].includes('на 7 дней') && target.user.dms[0].includes('Скам'), 'ban DMs the user');
    assert.strictEqual(guildBans.get('u1').deleteMessageSeconds, 24 * 60 * 60);
    assert.ok(tempBans.has('u1'));
    assert.strictEqual((await ModerationService.ban(guild, 'u1', { reason: 'Скам' }, MOD, 'panel')).code, 'already_banned');

    // Time passes: the record is due, the bot lifts the ban on its own
    tempBans.get('u1').unbanAt = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(await ModerationService.processExpiredBans(guild.client), 1);
    assert.strictEqual(guildBans.has('u1'), false);
    assert.strictEqual(tempBans.has('u1'), false);
    const unban = logged.find(e => e.action === 'moderation.unbanned');
    assert.strictEqual(unban.source, 'auto');

    // Ban by ID of someone who isn't on the server: permanent, no DM attempt
    const byId = await ModerationService.ban(guild, '123456789012345678', { reason: 'Твинк', duration: 'forever' }, MOD, 'panel');
    assert.strictEqual(byId.ok, true);
    assert.strictEqual(byId.until, null);
    assert.strictEqual(tempBans.has('123456789012345678'), false);

    assert.strictEqual((await ModerationService.unban(guild, '999999999999999999', MOD, 'panel')).code, 'not_banned');
}

async function unwarn() {
    setup();
    const { guild } = makeGuild([makeMember('mod', 10), makeMember('u1', 1)]);
    const { warning } = await ModerationService.warn(guild, 'u1', 'Флуд', MOD, 'panel');
    assert.strictEqual((await ModerationService.unwarn(guild, warning.id, MOD, 'panel')).ok, true);
    assert.strictEqual(warns.length, 0);
    assert.strictEqual((await ModerationService.unwarn(guild, warning.id, MOD, 'panel')).code, 'warning_not_found');

    // A moderator can't clear their own warns or those of someone ranked at or above them
    warns.push({ id: 'own', userId: 'mod', reason: 'Флуд' }, { id: 'peer', userId: 'peer', reason: 'Флуд' });
    const { guild: guild2 } = makeGuild([makeMember('mod', 10), makeMember('peer', 10)]);
    assert.strictEqual((await ModerationService.unwarn(guild2, 'own', MOD, 'panel')).code, 'self');
    assert.strictEqual((await ModerationService.unwarn(guild2, 'peer', MOD, 'panel')).code, 'target_higher');
    assert.strictEqual(warns.length, 2);
}

async function run() {
    hierarchy();
    templates();
    await escalation();
    await concurrentWarns();
    await longerMuteKept();
    await permissionsAndHierarchy();
    await muteAndUnmute();
    await bans();
    await unwarn();
    console.log('PASS: moderation (hierarchy, escalation, DMs, mutes, bans, temp bans, unwarn)');
}

run().catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
});
