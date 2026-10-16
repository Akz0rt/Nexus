const express = require('express');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const ModerationService = require('../../../modules/moderation/ModerationService');
const WarningService = require('../../../modules/moderation/WarningService');
const TempBanService = require('../../../modules/moderation/TempBanService');
const {
    MUTE_DURATIONS, BAN_DURATIONS, BAN_DELETE_DAYS, WARN_TTL_DAYS
} = require('../../../modules/moderation/templates');
const { describeMember, userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;

const RESULT_STATUS = {
    reason_required: 400,
    invalid_duration: 400,
    invalid_delete_days: 400,
    self: 400,
    forbidden: 403,
    target_protected: 403,
    target_higher: 403,
    member_not_found: 404,
    user_not_found: 404,
    warning_not_found: 404,
    not_banned: 404,
    bot_cannot: 409,
    not_muted: 409,
    already_banned: 409
};

function actorOf(req) {
    return { id: req.session.userId, tag: req.session.username };
}

function sendResult(res, result) {
    if (result.ok) {
        const { ok, ...rest } = result;
        return res.json({ ok, ...rest });
    }
    res.status(RESULT_STATUS[result.code] || 400).json({ error: result.code });
}

/** { id, username, displayName, avatarURL } for a Discord user object (banned users aren't members). */
function describeUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.globalName || user.username,
        avatarURL: user.displayAvatarURL({ size: 64, extension: 'png' })
    };
}

/** Latest audit entry per target for one action (the log keeps 30 days). */
async function latestByTarget(guildId, action) {
    const { items } = await AuditLogService.query({ guildId, action }, { limit: 200 });
    const map = new Map();
    for (const entry of items) {
        for (const id of entry.targetIds || []) if (!map.has(id)) map.set(id, entry);
    }
    return map;
}

function validUserId(req, res, next) {
    if (!SNOWFLAKE_RE.test(req.params.userId)) return res.status(400).json({ error: 'invalid_user_id' });
    next();
}

// GET /moderation/options — reason templates and allowed durations for the dialogs
router.get('/options', async (req, res, next) => {
    try {
        const settings = await GuildSettingsService.get(req.guild.id);
        const list = presets => Object.entries(presets).map(([id, { label }]) => ({ id, label }));
        res.json({
            reasons: settings.moderation.reasons,
            muteDurations: list(MUTE_DURATIONS),
            banDurations: list(BAN_DURATIONS),
            banDeleteDays: BAN_DELETE_DAYS,
            escalation: settings.moderation.escalation,
            warnTtlDays: WARN_TTL_DAYS
        });
    } catch (error) {
        next(error);
    }
});

// GET /moderation/active — running mutes and temporary bans
router.get('/active', async (req, res, next) => {
    try {
        const guild = req.guild;
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();
        const now = Date.now();

        const [lastMutes, lastBans, tempBans] = await Promise.all([
            latestByTarget(guild.id, 'moderation.muted'),
            latestByTarget(guild.id, 'moderation.banned'),
            TempBanService.list(guild.id)
        ]);

        const mutes = guild.members.cache
            .filter(member => (member.communicationDisabledUntilTimestamp || 0) > now)
            .map(member => {
                const entry = lastMutes.get(member.id);
                return {
                    member: describeMember(member),
                    until: new Date(member.communicationDisabledUntilTimestamp).toISOString(),
                    reason: entry?.reason || null,
                    actor: entry ? (entry.actorId ? userRef(guild, entry.actorId) : null) : null,
                    source: entry?.source || null,
                    since: entry?.createdAt || null
                };
            })
            .sort((a, b) => a.until.localeCompare(b.until));

        const bans = await Promise.all(tempBans.map(async ban => {
            const user = await guild.client.users.fetch(ban.userId).catch(() => null);
            const entry = lastBans.get(ban.userId);
            return {
                user: user ? describeUser(user) : { id: ban.userId, username: null, displayName: null, avatarURL: null },
                until: ban.unbanAt,
                reason: ban.reason,
                actor: ban.actorId ? userRef(guild, ban.actorId) : null,
                source: entry?.source || null,
                since: ban.createdAt
            };
        }));

        res.json({ mutes, bans });
    } catch (error) {
        next(error);
    }
});

// GET /moderation/bans — every ban on the server, with who/when from our log when known
router.get('/bans', async (req, res, next) => {
    try {
        const guild = req.guild;
        const [bans, lastBans, tempBans] = await Promise.all([
            guild.bans.fetch(),
            latestByTarget(guild.id, 'moderation.banned'),
            TempBanService.list(guild.id)
        ]);
        const unbanAt = new Map(tempBans.map(ban => [ban.userId, ban.unbanAt]));

        const items = bans.map(ban => {
            const entry = lastBans.get(ban.user.id);
            return {
                user: describeUser(ban.user),
                reason: entry?.reason || ban.reason || null,
                actor: entry?.actorId ? userRef(guild, entry.actorId) : null,
                bannedAt: entry?.createdAt || null,
                until: unbanAt.get(ban.user.id) || null
            };
        }).sort((a, b) => String(b.bannedAt || '').localeCompare(String(a.bannedAt || '')));

        res.json({ items });
    } catch (error) {
        next(error);
    }
});

// GET /moderation/warnings — active warns with a per-member count
router.get('/warnings', async (req, res, next) => {
    try {
        const guild = req.guild;
        const warns = await WarningService.listActive(guild.id);
        const counts = new Map();
        for (const warn of warns) counts.set(warn.userId, (counts.get(warn.userId) || 0) + 1);

        res.json({
            items: warns.map(warn => ({
                id: warn.id,
                user: userRef(guild, warn.userId),
                reason: warn.reason,
                actor: warn.actorId ? userRef(guild, warn.actorId) : null,
                source: warn.source,
                createdAt: warn.createdAt,
                expiresAt: warn.expiresAt,
                activeCount: counts.get(warn.userId)
            }))
        });
    } catch (error) {
        next(error);
    }
});

// DELETE /moderation/warnings/:warnId
router.delete('/warnings/:warnId', async (req, res, next) => {
    try {
        sendResult(res, await ModerationService.unwarn(req.guild, req.params.warnId, actorOf(req), 'panel'));
    } catch (error) {
        next(error);
    }
});

// POST /moderation/:userId/{warn|mute|unmute|kick|ban|unban}
const ACTIONS = {
    warn: (req, actor) => ModerationService.warn(req.guild, req.params.userId, req.body?.reason, actor, 'panel'),
    mute: (req, actor) => ModerationService.mute(req.guild, req.params.userId, req.body?.duration, req.body?.reason, actor, 'panel'),
    unmute: (req, actor) => ModerationService.unmute(req.guild, req.params.userId, actor, 'panel'),
    kick: (req, actor) => ModerationService.kick(req.guild, req.params.userId, req.body?.reason, actor, 'panel'),
    ban: (req, actor) => ModerationService.ban(req.guild, req.params.userId, {
        reason: req.body?.reason,
        duration: req.body?.duration,
        deleteMessageDays: req.body?.deleteMessageDays ?? 0
    }, actor, 'panel'),
    unban: (req, actor) => ModerationService.unban(req.guild, req.params.userId, actor, 'panel')
};

router.post('/:userId/:action', validUserId, async (req, res, next) => {
    const run = Object.hasOwn(ACTIONS, req.params.action) ? ACTIONS[req.params.action] : null;
    if (!run) return res.status(404).json({ error: 'not_found' });
    try {
        sendResult(res, await run(req, actorOf(req)));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
