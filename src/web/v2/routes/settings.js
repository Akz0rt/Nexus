const express = require('express');
const { ChannelType } = require('discord.js');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const DiagnosticsService = require('../../../services/DiagnosticsService');
const { MUTE_DURATIONS, WARN_TTL_DAYS } = require('../../../modules/moderation/templates');
const { actorOf } = require('../result');

// Mounted behind requireGuildAccess('senior'): administrators only
const router = express.Router({ mergeParams: true });

const SLOWMODE_CHOICES = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MAX_REASONS = 15;
const MAX_RULES = 6;
const MAX_LOCKDOWN_CHANNELS = 10;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);

function fail(field, code) {
    return { ok: false, field, code };
}

/**
 * Check a Settings save and turn it into a guild-doc patch. Only the fields
 * present are changed; nested groups are merged with what's saved.
 * @returns {{ ok: true, patch: object, fields: string[] } | { ok: false, field, code }}
 */
function sanitize(guild, body, current) {
    const patch = {};
    const fields = [];
    const isRole = id => guild.roles.cache.has(id) && id !== guild.id;

    if ('boosterRoleId' in body && body.boosterRoleId) {
        const role = guild.roles.cache.get(String(body.boosterRoleId));
        const queueRoles = ['unverifiedRoleId', 'maleRoleId', 'femaleRoleId'].map(key => (key in body ? body[key] : current[key]));
        if (role && (role.managed || role.permissions.bitfield !== 0n || queueRoles.includes(role.id))) return fail('boosterRoleId', 'booster_role_unsafe');
    }
    for (const key of ['unverifiedRoleId', 'maleRoleId', 'femaleRoleId', 'boosterRoleId']) {
        if (!(key in body)) continue;
        const id = String(body[key] || '');
        if (id && !isRole(id)) return fail(key, 'role_not_found');
        patch[key] = id;
        fields.push(key);
    }
    if ('verifyQueueChannelId' in body) {
        const id = String(body.verifyQueueChannelId || '');
        if (id && !TEXT_TYPES.has(guild.channels.cache.get(id)?.type)) return fail('verifyQueueChannelId', 'channel_not_found');
        patch.verifyQueueChannelId = id;
        fields.push('verifyQueueChannelId');
    }
    if ('verificationEnabled' in body) {
        patch.modules = { ...current.modules, verification: Boolean(body.verificationEnabled) };
        fields.push('verificationEnabled');
    }
    if ('assignUnverifiedOnJoin' in body) {
        patch.assignUnverifiedOnJoin = Boolean(body.assignUnverifiedOnJoin);
        fields.push('assignUnverifiedOnJoin');
    }
    if ('youngAccountDays' in body) {
        const days = Number(body.youngAccountDays);
        if (!Number.isInteger(days) || days < 1 || days > 365) return fail('youngAccountDays', 'invalid_young_days');
        patch.verification = { ...current.verification, youngAccountDays: days };
        fields.push('youngAccountDays');
    }

    if ('reasons' in body || 'escalation' in body) {
        const moderation = { ...current.moderation };
        if ('reasons' in body) {
            if (!Array.isArray(body.reasons)) return fail('reasons', 'invalid_reasons');
            const reasons = [...new Set(body.reasons.map(r => String(r || '').trim().slice(0, 100)).filter(Boolean))];
            if (reasons.length === 0 || reasons.length > MAX_REASONS) return fail('reasons', 'invalid_reasons');
            moderation.reasons = reasons;
            fields.push('reasons');
        }
        if ('escalation' in body) {
            if (!Array.isArray(body.escalation) || body.escalation.length > MAX_RULES) return fail('escalation', 'invalid_escalation');
            const allowed = new Set(Object.values(MUTE_DURATIONS).map(d => d.ms));
            const rules = [];
            for (const rule of body.escalation) {
                const warns = Number(rule?.warns);
                if (!Number.isInteger(warns) || warns < 1 || warns > 20) return fail('escalation', 'invalid_escalation');
                if (rules.some(r => r.warns === warns)) return fail('escalation', 'duplicate_warns');
                if (rule.action === 'timeout') {
                    if (!allowed.has(Number(rule.durationMs))) return fail('escalation', 'invalid_escalation');
                    rules.push({ warns, action: 'timeout', durationMs: Number(rule.durationMs) });
                } else if (rule.action === 'propose_ban') {
                    rules.push({ warns, action: 'propose_ban' });
                } else {
                    return fail('escalation', 'invalid_escalation');
                }
            }
            moderation.escalation = rules.sort((a, b) => a.warns - b.warns);
            fields.push('escalation');
        }
        patch.moderation = moderation;
    }

    if ('lockdownChannelIds' in body || 'slowmodeSeconds' in body) {
        const lockdown = { ...current.lockdown };
        if ('lockdownChannelIds' in body) {
            if (!Array.isArray(body.lockdownChannelIds)) return fail('lockdownChannelIds', 'channel_not_found');
            const ids = [...new Set(body.lockdownChannelIds.map(String))];
            if (ids.length > MAX_LOCKDOWN_CHANNELS) return fail('lockdownChannelIds', 'too_many_channels');
            if (ids.some(id => !TEXT_TYPES.has(guild.channels.cache.get(id)?.type))) return fail('lockdownChannelIds', 'channel_not_found');
            lockdown.channelIds = ids;
            fields.push('lockdownChannelIds');
        }
        if ('slowmodeSeconds' in body) {
            const seconds = Number(body.slowmodeSeconds);
            if (!SLOWMODE_CHOICES.includes(seconds)) return fail('slowmodeSeconds', 'invalid_slowmode');
            lockdown.slowmodeSeconds = seconds;
            fields.push('slowmodeSeconds');
        }
        patch.lockdown = lockdown;
    }

    if (fields.length === 0) return fail(null, 'nothing_to_save');
    return { ok: true, patch, fields };
}

function describeSettings(settings) {
    return {
        unverifiedRoleId: settings.unverifiedRoleId || '',
        maleRoleId: settings.maleRoleId || '',
        femaleRoleId: settings.femaleRoleId || '',
        boosterRoleId: settings.boosterRoleId || '',
        verifyQueueChannelId: settings.verifyQueueChannelId || '',
        verificationEnabled: Boolean(settings.modules.verification),
        assignUnverifiedOnJoin: Boolean(settings.assignUnverifiedOnJoin),
        youngAccountDays: settings.verification.youngAccountDays,
        reasons: settings.moderation.reasons,
        escalation: settings.moderation.escalation,
        lockdownChannelIds: settings.lockdown.channelIds,
        slowmodeSeconds: settings.lockdown.slowmodeSeconds,
        fromEnv: settings.fromEnv || []
    };
}

function describeOptions(guild) {
    const botTop = guild.members.me?.roles.highest.position ?? 0;
    return {
        roles: [...guild.roles.cache.values()]
            .filter(role => role.id !== guild.id && !role.managed)
            .sort((a, b) => b.position - a.position)
            .map(role => ({ id: role.id, name: role.name, color: role.hexColor, belowBot: role.position < botTop })),
        textChannels: [...guild.channels.cache.values()]
            .filter(channel => TEXT_TYPES.has(channel.type))
            .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
            .map(channel => ({ id: channel.id, name: channel.name, category: channel.parent?.name || null })),
        muteDurations: Object.entries(MUTE_DURATIONS).map(([id, { label, ms }]) => ({ id, label, ms })),
        slowmodeChoices: SLOWMODE_CHOICES,
        warnTtlDays: WARN_TTL_DAYS
    };
}

router.get('/', async (req, res, next) => {
    try {
        const settings = await GuildSettingsService.get(req.guild.id);
        res.json({ values: describeSettings(settings), options: describeOptions(req.guild) });
    } catch (error) {
        next(error);
    }
});

// PATCH /settings — any subset of the fields above
router.patch('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const current = await GuildSettingsService.get(guild.id);
        const result = sanitize(guild, req.body || {}, current);
        if (!result.ok) return res.status(400).json({ error: result.code, field: result.field });

        await GuildSettingsService.update(guild.id, result.patch);
        const actor = actorOf(req);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'settings.updated',
            actorId: actor.id,
            actorTag: actor.tag,
            source: 'panel',
            details: { fields: result.fields }
        });
        res.json({ ok: true, values: describeSettings(await GuildSettingsService.get(guild.id)) });
    } catch (error) {
        next(error);
    }
});

router.get('/diagnostics', async (req, res, next) => {
    try {
        res.json(await DiagnosticsService.run(req.guild));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.sanitize = sanitize;
module.exports.SLOWMODE_CHOICES = SLOWMODE_CHOICES;
