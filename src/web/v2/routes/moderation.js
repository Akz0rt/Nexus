const express = require('express');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const ModerationService = require('../../../modules/moderation/ModerationService');
const WarningService = require('../../../modules/moderation/WarningService');
const TempBanService = require('../../../modules/moderation/TempBanService');
const {
    MUTE_DURATIONS, BAN_DURATIONS, BAN_DELETE_DAYS, WARN_TTL_DAYS, MAX_TEMPLATES, cleanSteps, describeSteps
} = require('../../../modules/moderation/templates');
const ReportService = require('../../../modules/reports/ReportService');
const { canSeeChannel } = require('../visibility');

const BANS_COUNT_TTL_MS = 5 * 60 * 1000;
const bansCount = new Map(); // guildId -> { at, n }: counting bans pages through all of them
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
        const list = presets => Object.entries(presets).map(([id, { label, ms }]) => ({ id, label, ms: ms ?? null }));
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

// GET /moderation/summary — counts for the tabs
router.get('/summary', async (req, res, next) => {
    try {
        const guild = req.guild;
        const now = Date.now();
        let bans = bansCount.get(guild.id);
        if (!bans || now - bans.at > BANS_COUNT_TTL_MS) {
            let n = 0;
            let after;
            try {
                for (let page = 0; page < 10; page++) {
                    const chunk = await guild.bans.fetch({ limit: 1000, after, cache: false });
                    n += chunk.size;
                    if (chunk.size < 1000) break;
                    after = chunk.lastKey();
                }
            } catch {
                n = null; // no «Банить участников»
            }
            bans = { at: now, n };
            bansCount.set(guild.id, bans);
        }
        const [warns, tempBans] = await Promise.all([WarningService.listActive(guild.id), TempBanService.list(guild.id)]);
        const mutes = guild.members.cache.filter(member => (member.communicationDisabledUntilTimestamp || 0) > now).size;
        res.json({ active: mutes + tempBans.length, bans: bans.n, warnings: warns.length });
    } catch (error) {
        next(error);
    }
});

// GET /moderation/templates — «Наказать…» templates (everyone); PUT replaces them (administrators)
router.get('/templates', async (req, res, next) => {
    try {
        const settings = await GuildSettingsService.get(req.guild.id);
        res.json({ items: settings.moderation.templates.map(t => ({ ...t, summary: describeSteps(t.steps) })), canEdit: req.panelRole === 'senior' });
    } catch (error) {
        next(error);
    }
});

router.put('/templates', async (req, res, next) => {
    try {
        if (req.panelRole !== 'senior') return res.status(403).json({ error: 'forbidden' });
        const list = req.body?.items;
        if (!Array.isArray(list) || list.length > MAX_TEMPLATES) return res.status(400).json({ error: 'invalid_templates' });
        const templates = [];
        for (const item of list) {
            const name = String(item?.name || '').trim().slice(0, 40);
            const reason = String(item?.reason || name).trim().slice(0, 200);
            const steps = cleanSteps(item?.steps);
            if (!name || !steps) return res.status(400).json({ error: 'invalid_templates' });
            const id = /^[a-z0-9-]{1,40}$/.test(String(item.id || '')) ? String(item.id) : `t${Date.now().toString(36)}${templates.length}`;
            templates.push({ id, name, reason, steps });
        }
        const current = await GuildSettingsService.get(req.guild.id);
        await GuildSettingsService.update(req.guild.id, { moderation: { ...current.moderation, templates } });
        const actor = actorOf(req);
        await AuditLogService.log({
            guildId: req.guild.id, action: 'settings.updated', actorId: actor.id, actorTag: actor.tag,
            source: 'panel', details: { fields: ['templates'] }
        });
        res.json({ ok: true, items: templates.map(t => ({ ...t, summary: describeSteps(t.steps) })) });
    } catch (error) {
        next(error);
    }
});

// POST /moderation/:userId/punish — { templateId } or { steps, reason }, optional reportId:
// the steps run in order; a punishment from a report closes it as resolved
router.post('/:userId/punish', validUserId, async (req, res, next) => {
    try {
        const guild = req.guild;
        const actor = actorOf(req);
        const body = req.body || {};
        let steps;
        let reason;
        if (body.templateId) {
            const settings = await GuildSettingsService.get(guild.id);
            const template = settings.moderation.templates.find(t => t.id === String(body.templateId));
            if (!template) return res.status(404).json({ error: 'template_not_found' });
            steps = cleanSteps(template.steps);
            reason = String(body.reason || template.reason || template.name);
            // An administrator may have changed it since the list was loaded: never apply steps nobody saw
            if (body.expect && body.expect !== describeSteps(steps)) return res.status(409).json({ error: 'template_changed' });
        } else {
            steps = cleanSteps(body.steps);
            reason = String(body.reason || '');
        }
        if (!steps) return res.status(400).json({ error: 'invalid_steps' });

        // The report must be one this moderator may see, and still open
        let report = null;
        if (body.reportId) {
            report = await ReportService.get(guild.id, String(body.reportId));
            const viewer = guild.members.cache.get(req.session.userId);
            if (!report || !canSeeChannel(guild, viewer, report.channelId)) return res.status(404).json({ error: 'report_not_found' });
            if (report.targetId !== req.params.userId) return res.status(400).json({ error: 'report_other_member' });
        }

        const result = await ModerationService.punish(guild, req.params.userId, steps, reason, actor, 'panel');
        const done = result.steps.filter(step => step.ok).map(step => steps.find(s => s.kind === step.kind));
        let closed = false;
        if (report && done.length > 0) {
            const closing = await ReportService.close(guild.id, report.id, 'resolved', describeSteps(done), actor, 'panel');
            closed = closing.ok;
        }
        if (!result.ok) {
            return res.status(RESULT_STATUS[result.code] || 400).json({ error: result.code, steps: result.steps });
        }
        res.json({ ok: true, steps: result.steps, summary: describeSteps(done), reportClosed: closed, failed: result.code || null });
    } catch (error) {
        next(error);
    }
});

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
