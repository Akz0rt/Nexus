const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../../services/GuildSettingsService');
const AuditLogService = require('../../services/AuditLogService');
const WarningService = require('./WarningService');
const TempBanService = require('./TempBanService');
const {
    MUTE_DURATIONS, BAN_DURATIONS, BAN_DELETE_DAYS, escalationFor, formatDuration
} = require('./templates');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const UNKNOWN_BAN = 10026;
const MAX_REASON_LENGTH = 400;
const CUSTOM_ID_PREFIX = 'mod';

// Escalation and expired bans act on their own, with no moderator behind them
const AUTO_ACTOR = { id: null, tag: null };
const ESCALATION_DM_REASON = 'Повторные нарушения правил';

function cleanReason(reason) {
    return String(reason || '').trim().slice(0, MAX_REASON_LENGTH);
}

/** Reason shown in Discord's own audit log: "<reason> · <who>". */
function discordReason(reason, actor) {
    return `${reason} · ${actor.tag || actor.id || 'Nexus'}`;
}

function warnsWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'варн';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'варна';
    return 'варнов';
}

/**
 * Why `actor` may not punish `target`, or null if they may.
 * capability: the GuildMember getter telling whether the bot itself can do it
 * ('moderatable' | 'kickable' | 'bannable'), or null when the bot does nothing on Discord (warn).
 */
function targetProblem(guild, actor, target, capability) {
    if (actor && target.id === actor.id) return 'self';
    if (target.user?.bot || target.id === guild.ownerId) return 'target_protected';
    if (actor && actor.id !== guild.ownerId
        && target.roles.highest.position >= actor.roles.highest.position) {
        return 'target_higher';
    }
    if (capability && !target[capability]) return 'bot_cannot';
    return null;
}

/**
 * Warns, mutes (Discord timeouts), kicks and bans, shared by slash commands,
 * Discord buttons and the desktop panel. Every method returns { ok: true, ... }
 * or { ok: false, code }.
 */
class ModerationService {
    constructor() {
        // Per-member promise chains: concurrent warns are counted one after another,
        // so an escalation step can't be skipped or applied twice.
        this.chains = new Map();
    }

    async serial(key, fn) {
        const previous = this.chains.get(key) || Promise.resolve();
        const run = previous.catch(() => {}).then(fn);
        this.chains.set(key, run);
        try {
            return await run;
        } finally {
            if (this.chains.get(key) === run) this.chains.delete(key);
        }
    }

    async fetchMember(guild, userId) {
        try {
            return await guild.members.fetch({ user: userId, force: true });
        } catch (error) {
            if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return null;
            throw error;
        }
    }

    /** The acting moderator if they hold the permission, otherwise null. */
    async authorize(guild, actor, permission) {
        const member = await this.fetchMember(guild, actor.id);
        return member?.permissions.has(permission) ? member : null;
    }

    /** DM the punished user; closed DMs must not stop the punishment. */
    async notify(user, text) {
        try {
            await user.send(text);
            return true;
        } catch {
            return false;
        }
    }

    // --- Warns -------------------------------------------------------------------

    /** Warn a member (no DM — warns are silent), then apply the escalation step it reaches. */
    async warn(guild, userId, reason, actor, source) {
        reason = cleanReason(reason);
        if (!reason) return { ok: false, code: 'reason_required' };
        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.ModerateMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };

        const member = await this.fetchMember(guild, userId);
        if (!member) return { ok: false, code: 'member_not_found' };
        const problem = targetProblem(guild, actorMember, member, null);
        if (problem) return { ok: false, code: problem };

        return this.serial(`${guild.id}:${userId}`, async () => {
            const warning = await WarningService.add({
                guildId: guild.id,
                userId,
                reason,
                actorId: actor.id,
                actorTag: actor.tag,
                source
            });
            const active = await WarningService.listActive(guild.id, userId);

            await AuditLogService.log({
                guildId: guild.id,
                action: 'moderation.warned',
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: [userId],
                reason,
                source,
                details: { warnId: warning.id, activeWarns: active.length }
            });

            const escalation = await this.escalate(guild, member, active);
            return { ok: true, warning, activeCount: active.length, escalation };
        });
    }

    async unwarn(guild, warnId, actor, source) {
        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.ModerateMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const warning = await WarningService.get(guild.id, warnId);
        if (!warning) return { ok: false, code: 'warning_not_found' };

        // Same rules as giving a warn: not your own, not someone ranked at or above you
        if (warning.userId === actor.id) return { ok: false, code: 'self' };
        const target = await this.fetchMember(guild, warning.userId);
        if (target) {
            const problem = targetProblem(guild, actorMember, target, null);
            if (problem) return { ok: false, code: problem };
        }

        await WarningService.remove(guild.id, warnId);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.unwarned',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [warning.userId],
            reason: warning.reason,
            source,
            details: { warnId }
        });
        return { ok: true, warning };
    }

    /**
     * Escalation step for the member's active warn count.
     * @returns {Promise<null|{ action: string, ok: boolean, code?: string, durationMs?: number }>}
     */
    async escalate(guild, member, activeWarns) {
        const settings = await GuildSettingsService.get(guild.id);
        const rule = escalationFor(activeWarns.length, settings.moderation?.escalation);
        if (!rule) return null;
        const reason = `Эскалация: ${activeWarns.length} ${warnsWord(activeWarns.length)}`;

        try {
            if (rule.action === 'timeout') {
                if (!member.moderatable) return { action: 'timeout', ok: false, code: 'bot_cannot' };
                // Never shorten a longer mute that is already running
                const until = member.communicationDisabledUntilTimestamp || 0;
                if (until > Date.now() + rule.durationMs) return { action: 'timeout', ok: false, code: 'already_muted' };
                // Warns are silent, so the DM must not reveal them
                await this.applyTimeout(guild, member, rule.durationMs, reason, AUTO_ACTOR, 'auto', ESCALATION_DM_REASON);
                return { action: 'timeout', ok: true, durationMs: rule.durationMs };
            }
            if (rule.action === 'propose_ban') {
                await this.proposeBan(guild, member, activeWarns, settings);
                return { action: 'propose_ban', ok: true };
            }
        } catch (error) {
            console.error(`Moderation escalation for ${member.id} failed:`, error.message || error);
            return { action: rule.action, ok: false, code: 'failed' };
        }
        return null;
    }

    /** Ask the moderators (queue channel) whether to ban; senior staff decide with the button. */
    async proposeBan(guild, member, activeWarns, settings) {
        if (settings.verifyQueueChannelId) {
            const channel = await guild.client.channels.fetch(settings.verifyQueueChannelId);
            const embed = new EmbedBuilder()
                .setColor(0xef5b5f)
                .setTitle(`${activeWarns.length} ${warnsWord(activeWarns.length)} у ${member.displayName}`)
                .setDescription(`<@${member.id}> набрал(а) ${activeWarns.length} активных ${warnsWord(activeWarns.length)}. Забанить?`)
                .addFields({
                    name: 'Причины',
                    value: activeWarns.slice(0, 10).map(w => `• ${w.reason}`).join('\n').slice(0, 1024) || '—'
                })
                .setThumbnail(member.user.displayAvatarURL({ size: 128 }));
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${CUSTOM_ID_PREFIX}:ban:${member.id}`)
                    .setLabel('Забанить')
                    .setStyle(ButtonStyle.Danger)
            );
            await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
        }

        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.ban_proposed',
            targetIds: [member.id],
            reason: `${activeWarns.length} ${warnsWord(activeWarns.length)}`,
            source: 'auto',
            details: { activeWarns: activeWarns.length }
        });
    }

    // --- Mutes (Discord timeouts) ------------------------------------------------

    /** dmReason: what the user is told (escalation hides that warns exist); reason goes to the log. */
    async applyTimeout(guild, member, durationMs, reason, actor, source, dmReason = reason) {
        await member.timeout(durationMs, discordReason(reason, actor));
        const until = new Date(Date.now() + durationMs).toISOString();
        const dmSent = await this.notify(member.user,
            `Вам выдан мут на сервере «${guild.name}» на ${formatDuration(durationMs)}.\nПричина: ${dmReason}`);

        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.muted',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [member.id],
            reason,
            source,
            details: { durationMs, until, dmSent }
        });
        return until;
    }

    /** @param {string} duration key of MUTE_DURATIONS */
    async mute(guild, userId, duration, reason, actor, source) {
        reason = cleanReason(reason);
        if (!reason) return { ok: false, code: 'reason_required' };
        const preset = MUTE_DURATIONS[duration];
        if (!preset) return { ok: false, code: 'invalid_duration' };

        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.ModerateMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const member = await this.fetchMember(guild, userId);
        if (!member) return { ok: false, code: 'member_not_found' };
        const problem = targetProblem(guild, actorMember, member, 'moderatable');
        if (problem) return { ok: false, code: problem };

        const until = await this.applyTimeout(guild, member, preset.ms, reason, actor, source);
        return { ok: true, until };
    }

    async unmute(guild, userId, actor, source) {
        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.ModerateMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const member = await this.fetchMember(guild, userId);
        if (!member) return { ok: false, code: 'member_not_found' };
        if (!member.isCommunicationDisabled()) return { ok: false, code: 'not_muted' };
        const problem = targetProblem(guild, actorMember, member, 'moderatable');
        if (problem) return { ok: false, code: problem };

        await member.timeout(null, discordReason('Мут снят', actor));
        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.unmuted',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [userId],
            source
        });
        return { ok: true };
    }

    // --- Kick --------------------------------------------------------------------

    /**
     * Several punishments at once (a template from «Наказать…»): warn, mute, then kick or
     * ban, each through its own method (log, DM, escalation as usual). Stops at the
     * first refusal; what already happened stays.
     * @param {object[]} steps cleaned with cleanSteps()
     * @returns {{ ok: boolean, code?: string, steps: Array<{ kind, ok, code? }> }}
     */
    async punish(guild, userId, steps, reason, actor, source) {
        if (!cleanReason(reason)) return { ok: false, code: 'reason_required', steps: [] };
        const done = [];
        for (const step of steps) {
            let result;
            if (step.kind === 'warn') result = await this.warn(guild, userId, reason, actor, source);
            else if (step.kind === 'mute') {
                const member = await this.fetchMember(guild, userId).catch(() => null);
                const longer = (member?.communicationDisabledUntilTimestamp || 0) > Date.now() + (MUTE_DURATIONS[step.duration]?.ms || 0);
                result = longer ? { ok: true, kept: true } : await this.mute(guild, userId, step.duration, reason, actor, source);
            }
            else if (step.kind === 'kick') result = await this.kick(guild, userId, reason, actor, source);
            else result = await this.ban(guild, userId, { reason, duration: step.duration, deleteMessageDays: step.deleteDays }, actor, source);
            done.push({ kind: step.kind, ok: Boolean(result.ok), code: result.ok ? undefined : result.code, kept: result.kept || undefined });
            if (!result.ok) return { ok: done.length > 1, code: result.code, steps: done };
        }
        return { ok: true, steps: done };
    }

    async kick(guild, userId, reason, actor, source) {
        reason = cleanReason(reason);
        if (!reason) return { ok: false, code: 'reason_required' };
        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.KickMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const member = await this.fetchMember(guild, userId);
        if (!member) return { ok: false, code: 'member_not_found' };
        const problem = targetProblem(guild, actorMember, member, 'kickable');
        if (problem) return { ok: false, code: problem };

        await member.kick(discordReason(reason, actor));
        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.kicked',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [userId],
            reason,
            source
        });
        return { ok: true };
    }

    // --- Bans --------------------------------------------------------------------

    /**
     * Ban a member, or a user who isn't on the server (by ID).
     * @param {{ reason: string, duration: string, deleteMessageDays: number }} options
     *        duration: key of BAN_DURATIONS
     */
    async ban(guild, userId, { reason, duration = 'forever', deleteMessageDays = 0 }, actor, source) {
        reason = cleanReason(reason);
        if (!reason) return { ok: false, code: 'reason_required' };
        const preset = BAN_DURATIONS[duration];
        if (!preset) return { ok: false, code: 'invalid_duration' };
        deleteMessageDays = Number(deleteMessageDays);
        if (!BAN_DELETE_DAYS.includes(deleteMessageDays)) return { ok: false, code: 'invalid_delete_days' };

        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.BanMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };

        const member = await this.fetchMember(guild, userId);
        let user = member?.user || null;
        if (member) {
            const problem = targetProblem(guild, actorMember, member, 'bannable');
            if (problem) return { ok: false, code: problem };
        } else {
            if (userId === actor.id) return { ok: false, code: 'self' };
            user = await guild.client.users.fetch(userId).catch(() => null);
            if (!user) return { ok: false, code: 'user_not_found' };
        }

        const existing = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
        if (existing) return { ok: false, code: 'already_banned' };

        // DM first: once banned, the bot shares no server with them
        const until = preset.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
        const dmSent = member
            ? await this.notify(user, `Вы забанены на сервере «${guild.name}» ${preset.ms ? `на ${formatDuration(preset.ms)}` : 'навсегда'}.\nПричина: ${reason}`)
            : false;

        await guild.bans.create(userId, {
            reason: discordReason(reason, actor),
            deleteMessageSeconds: deleteMessageDays * 24 * 60 * 60
        });

        if (until) {
            await TempBanService.set({ guildId: guild.id, userId, unbanAt: until, reason, actorId: actor.id, actorTag: actor.tag });
        } else {
            await TempBanService.remove(guild.id, userId);
        }

        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.banned',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [userId],
            reason,
            source,
            details: { durationMs: preset.ms, until, deleteMessageDays, dmSent, wasMember: Boolean(member) }
        });
        return { ok: true, until };
    }

    async unban(guild, userId, actor, source, { expired = false } = {}) {
        if (!expired && !(await this.authorize(guild, actor, PermissionFlagsBits.BanMembers))) {
            return { ok: false, code: 'forbidden' };
        }

        try {
            await guild.bans.remove(userId, expired ? 'Срок бана истёк' : discordReason('Разбан', actor));
        } catch (error) {
            if (error.code !== UNKNOWN_BAN) throw error;
            await TempBanService.remove(guild.id, userId);
            return { ok: false, code: 'not_banned' };
        }
        await TempBanService.remove(guild.id, userId);

        await AuditLogService.log({
            guildId: guild.id,
            action: 'moderation.unbanned',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [userId],
            reason: expired ? 'Срок бана истёк' : null,
            source,
            details: { expired }
        });
        return { ok: true };
    }

    /** Lift temporary bans whose time is up (runs every minute). */
    async processExpiredBans(client) {
        const due = await TempBanService.listDue();
        let lifted = 0;
        for (const ban of due) {
            const guild = client.guilds.cache.get(ban.guildId);
            if (!guild) continue;
            try {
                const result = await this.unban(guild, ban.userId, AUTO_ACTOR, 'auto', { expired: true });
                if (result.ok) lifted++;
            } catch (error) {
                console.error(`Moderation: auto-unban of ${ban.userId} failed:`, error.message || error);
            }
        }
        return lifted;
    }
}

module.exports = new ModerationService();
module.exports.targetProblem = targetProblem;
module.exports.CUSTOM_ID_PREFIX = CUSTOM_ID_PREFIX;
module.exports.AUTO_ACTOR = AUTO_ACTOR;
