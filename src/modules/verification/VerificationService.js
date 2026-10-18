const { PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../../services/GuildSettingsService');
const AuditLogService = require('../../services/AuditLogService');
const RoleService = require('../../services/RoleService');
const QueueCardService = require('./QueueCardService');
const InviteTracker = require('../invites/InviteTracker');
const { buildCardMessage } = require('./card');
const { computeNewRoles, shouldAssignUnverified } = require('./roles');

const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_MEMBER = 10007;
const LOCK_WAIT_MS = 8000;
const LOCK_POLL_MS = 100;
// The app offers "Undo" for 10 s after approving; allow some slack for latency
const UNDO_WINDOW_MS = 15 * 1000;

/**
 * Verification queue logic shared by Discord buttons and (later) the web panel.
 * Discord is the source of truth: a member is in the queue iff they hold @unverified.
 */
class VerificationService {
    constructor() {
        // guildId:userId pairs with an action in flight — also tells event handlers
        // to ignore the guildMemberUpdate/Remove our own action triggers.
        this.locks = new Set();
    }

    lockKey(guildId, userId) {
        return `${guildId}:${userId}`;
    }

    isLocked(guildId, userId) {
        return this.locks.has(this.lockKey(guildId, userId));
    }

    /** Settings needed for the queue, or null if the module is off / not configured. */
    async getQueueSettings(guildId) {
        const settings = await GuildSettingsService.get(guildId);
        if (!settings.modules.verification || !settings.unverifiedRoleId || !settings.verifyQueueChannelId) {
            return null;
        }
        return settings;
    }

    async fetchMember(guild, userId) {
        try {
            return await guild.members.fetch({ user: userId, force: true });
        } catch (error) {
            if (error.code === UNKNOWN_MEMBER) return null;
            throw error;
        }
    }

    async fetchQueueChannel(guild, settings) {
        const channel = await guild.client.channels.fetch(settings.verifyQueueChannelId);
        if (!channel?.isTextBased?.()) {
            throw new Error(`VERIFY_QUEUE_CHANNEL_ID (${settings.verifyQueueChannelId}) is not a text channel`);
        }
        return channel;
    }

    /** Edit the card message in place; resend it if the message was deleted. */
    async renderCard(guild, card, member) {
        // Cards created from the panel for members without a Discord card have nothing to edit
        if (!card.messageId && card.status !== 'pending') return card;

        const settings = await GuildSettingsService.get(guild.id);
        const channelId = card.channelId || settings.verifyQueueChannelId;
        const channel = await guild.client.channels.fetch(channelId);
        const payload = buildCardMessage(member, card, settings.verification);

        if (card.messageId) {
            try {
                await channel.messages.edit(card.messageId, payload);
                return card;
            } catch (error) {
                if (error.code !== UNKNOWN_MESSAGE) throw error;
            }
        }

        // Only pending cards are worth resending; closed ones can stay gone
        if (card.status !== 'pending') return card;
        const message = await channel.send(payload);
        return QueueCardService.upsert({ ...card, channelId: channel.id, messageId: message.id });
    }

    /**
     * Make sure a pending card exists for a member holding @unverified.
     * Creates a new card (and logs it) or repairs a deleted message.
     */
    async ensureCard(guild, member, source = 'bot') {
        if (member.user.bot) return null;
        const settings = await this.getQueueSettings(guild.id);
        if (!settings) return null;

        // Startup reconcile and guildMemberUpdate can race for the same member
        const key = this.lockKey(guild.id, member.id);
        if (this.locks.has(key)) return null;
        this.locks.add(key);
        try {
            return await this.ensureCardUnlocked(guild, member, settings, source);
        } finally {
            this.locks.delete(key);
        }
    }

    async ensureCardUnlocked(guild, member, settings, source) {
        const existing = await QueueCardService.get(guild.id, member.id);
        if (existing?.status === 'pending') {
            return this.renderCard(guild, existing, member);
        }

        const channel = await this.fetchQueueChannel(guild, settings);
        const card = {
            guildId: guild.id,
            userId: member.id,
            status: 'pending',
            channelId: channel.id,
            messageId: null,
            createdAt: new Date().toISOString(),
            handledBy: null,
            handledAt: null,
            gender: null,
            reason: null,
            // Kicks from the queue add up across re-joins; the invite is this join's
            kickCount: existing?.kickCount || 0,
            invite: InviteTracker.joinOf(guild.id, member.id)
        };
        const message = await channel.send(buildCardMessage(member, card, settings.verification));
        card.messageId = message.id;
        await QueueCardService.upsert(card);

        await AuditLogService.log({
            guildId: guild.id,
            action: 'verification.queued',
            targetIds: [member.id],
            source
        });
        return card;
    }

    /**
     * New member joined: give @unverified unless someone already did.
     * The card itself is created by the guildMemberUpdate this role change triggers.
     * @returns {Promise<'assigned'|'skipped'>}
     */
    async assignOnJoin(member) {
        const settings = await this.getQueueSettings(member.guild.id);
        if (!settings || !settings.assignUnverifiedOnJoin) return 'skipped';

        const roleIds = {
            unverifiedId: settings.unverifiedRoleId,
            maleId: settings.maleRoleId,
            femaleId: settings.femaleRoleId
        };
        if (!shouldAssignUnverified(member, roleIds)) return 'skipped';

        // Adding a role is idempotent, so a race with a third-party bot does no harm
        await member.roles.add(settings.unverifiedRoleId, 'Новичок: выдача @АНверефи при входе');
        await AuditLogService.log({
            guildId: member.guild.id,
            action: 'verification.role_assigned',
            targetIds: [member.id],
            source: 'bot'
        });
        return 'assigned';
    }

    /** Close a pending card without an action from us (role removed elsewhere, member left). */
    async closeCard(guild, userId, status, member = null) {
        const card = await QueueCardService.get(guild.id, userId);
        if (!card || card.status !== 'pending') return null;

        const updated = await QueueCardService.upsert({
            ...card,
            status,
            handledAt: new Date().toISOString()
        });
        try {
            await this.renderCard(guild, updated, member);
        } catch (error) {
            console.error(`Verification: failed to update card for ${userId}:`, error.message || error);
        }

        await AuditLogService.log({
            guildId: guild.id,
            action: status === 'left' ? 'verification.left' : 'verification.role_removed',
            targetIds: [userId],
            source: 'discord'
        });
        return updated;
    }

    async assertPermission(guild, actorId, permission) {
        const actor = await guild.members.fetch(actorId).catch(() => null);
        return Boolean(actor?.permissions.has(permission));
    }

    alreadyHandled(card) {
        return { ok: false, code: 'already_handled', card };
    }

    /**
     * Run fn(card, member) under the per-member lock if the member is still in the queue.
     * Discord is the source of truth: in the queue = holds @unverified. The card is
     * optional metadata — members who got the role before stage 1 or while the bot
     * was down have none, so a fresh one (without a Discord message) is made up.
     * Returns fn's result or an { ok: false } object.
     */
    async withQueuedMember(guild, userId, settings, fn) {
        const key = this.lockKey(guild.id, userId);
        // A concurrent click waits for the first one, then sees its outcome
        // ("already approved by X") — or proceeds if the first one failed.
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (this.locks.has(key)) {
            if (Date.now() > deadline) return { ok: false, code: 'in_progress' };
            await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
        }
        this.locks.add(key);
        try {
            const card = await QueueCardService.get(guild.id, userId);
            const member = await this.fetchMember(guild, userId);
            if (!member) {
                if (card?.status === 'pending') await this.markLeftUnlocked(guild, card);
                return { ok: false, code: 'member_left' };
            }
            if (!member.roles.cache.has(settings.unverifiedRoleId)) return this.alreadyHandled(card);

            const queuedCard = card?.status === 'pending' ? card : {
                guildId: guild.id,
                userId,
                status: 'pending',
                channelId: null,
                messageId: null,
                createdAt: new Date().toISOString(),
                handledBy: null,
                handledAt: null,
                gender: null,
                reason: null,
                kickCount: card?.kickCount || 0,
                invite: InviteTracker.joinOf(guild.id, userId)
            };
            return await fn(queuedCard, member);
        } finally {
            this.locks.delete(key);
        }
    }

    /**
     * Approve: swap @unverified for the gender role in one roles.set call.
     * Extra roles (a preset or picked by hand) go into the same call; ones the
     * moderator may not give are left out and reported in `skippedRoles`.
     * @param {{ id: string, tag?: string }} actor
     * @param {{ extraRoleIds?: string[] }} [options]
     */
    async approve(guild, userId, gender, actor, source, { extraRoleIds = [] } = {}) {
        const settings = await this.getQueueSettings(guild.id);
        if (!settings) return { ok: false, code: 'not_configured' };
        const actorMember = await guild.members.fetch(actor.id).catch(() => null);
        if (!actorMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return { ok: false, code: 'forbidden' };
        }
        // The queue's own roles never count as extras: @unverified would keep them in the queue,
        // the other gender role would give them both
        const reserved = new Set([settings.unverifiedRoleId, settings.maleRoleId, settings.femaleRoleId].filter(Boolean));
        const extraIds = extraRoleIds.filter(id => !reserved.has(String(id)));
        const extras = extraIds.length > 0
            ? RoleService.sortRoles(guild, actorMember, extraIds)
            : { valid: [], skipped: [] };

        return this.withQueuedMember(guild, userId, settings, async (card, member) => {
            const roles = computeNewRoles(member.roles.cache.keys(), {
                unverifiedId: settings.unverifiedRoleId,
                maleId: settings.maleRoleId,
                femaleId: settings.femaleRoleId
            }, gender);
            // Only the ones they don't have yet: undo takes these away again
            const added = extras.valid.filter(role => !roles.includes(role.id));
            await member.roles.set([...roles, ...added.map(role => role.id)],
                `Пропуск: ${gender === 'male' ? 'парень' : 'девушка'} · ${actor.tag || actor.id}`);

            const updated = await QueueCardService.upsert({
                ...card,
                status: 'approved',
                gender,
                extraRoleIds: added.map(role => role.id),
                handledBy: actor.id,
                handledAt: new Date().toISOString()
            });
            await this.safeRender(guild, updated, member);

            await AuditLogService.log({
                guildId: guild.id,
                action: 'verification.approved',
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: [userId],
                source,
                details: added.length ? { gender, extraRoles: added.map(role => role.name) } : { gender }
            });
            return { ok: true, card: updated, skippedRoles: extras.skipped };
        });
    }

    /**
     * Undo a fresh approval: give @unverified back, drop the gender role and
     * reopen the card. Only the moderator who approved, only within UNDO_WINDOW_MS.
     */
    async undoApprove(guild, userId, actor, source) {
        const settings = await this.getQueueSettings(guild.id);
        if (!settings) return { ok: false, code: 'not_configured' };

        const key = this.lockKey(guild.id, userId);
        if (this.locks.has(key)) return { ok: false, code: 'in_progress' };
        this.locks.add(key);
        try {
            const card = await QueueCardService.get(guild.id, userId);
            if (!card || card.status !== 'approved') return { ok: false, code: 'nothing_to_undo', card };
            if (card.handledBy !== actor.id) return { ok: false, code: 'forbidden', card };
            if (Date.now() - Date.parse(card.handledAt) > UNDO_WINDOW_MS) return { ok: false, code: 'undo_expired', card };

            const member = await this.fetchMember(guild, userId);
            if (!member) return { ok: false, code: 'member_left', card };

            const genderRoleId = card.gender === 'male' ? settings.maleRoleId : settings.femaleRoleId;
            const roles = new Set(member.roles.cache.keys());
            if (genderRoleId) roles.delete(genderRoleId);
            for (const roleId of card.extraRoleIds || []) roles.delete(roleId);
            roles.add(settings.unverifiedRoleId);
            await member.roles.set([...roles], `Отмена пропуска · ${actor.tag || actor.id}`);

            const reopened = await QueueCardService.upsert({
                ...card,
                status: 'pending',
                gender: null,
                extraRoleIds: [],
                handledBy: null,
                handledAt: null
            });
            await this.safeRender(guild, reopened, member);

            await AuditLogService.log({
                guildId: guild.id,
                action: 'verification.undone',
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: [userId],
                source,
                details: { gender: card.gender }
            });
            return { ok: true, card: reopened };
        } finally {
            this.locks.delete(key);
        }
    }

    async kick(guild, userId, reason, actor, source) {
        const settings = await this.getQueueSettings(guild.id);
        if (!settings) return { ok: false, code: 'not_configured' };
        if (!(await this.assertPermission(guild, actor.id, PermissionFlagsBits.KickMembers))) {
            return { ok: false, code: 'forbidden' };
        }

        return this.withQueuedMember(guild, userId, settings, async (card, member) => {
            await member.kick(`${reason} · ${actor.tag || actor.id}`);

            const updated = await QueueCardService.upsert({
                ...card,
                status: 'kicked',
                reason,
                kickCount: (card.kickCount || 0) + 1,
                handledBy: actor.id,
                handledAt: new Date().toISOString()
            });
            await this.safeRender(guild, updated, member);

            await AuditLogService.log({
                guildId: guild.id,
                action: 'verification.kicked',
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: [userId],
                reason,
                source
            });
            return { ok: true, card: updated };
        });
    }

    // Used inside withQueuedMember, where the card is already known to be pending
    async markLeftUnlocked(guild, card) {
        const updated = await QueueCardService.upsert({ ...card, status: 'left', handledAt: new Date().toISOString() });
        await this.safeRender(guild, updated, null);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'verification.left',
            targetIds: [card.userId],
            source: 'discord'
        });
    }

    async safeRender(guild, card, member) {
        try {
            await this.renderCard(guild, card, member);
        } catch (error) {
            console.error(`Verification: failed to update card for ${card.userId}:`, error.message || error);
        }
    }

    /**
     * Startup reconciliation: closes pending cards whose member lost @unverified
     * or left while the bot was down. Never posts to the queue channel — cards
     * are created only when the role appears (guildMemberUpdate).
     * The full member fetch also fills the cache so guildMemberUpdate has old snapshots.
     */
    async reconcile(guild) {
        const settings = await this.getQueueSettings(guild.id);
        if (!settings) return { skipped: true };

        const members = await guild.members.fetch();
        const pending = await QueueCardService.listPending(guild.id);
        let closed = 0;

        for (const card of pending) {
            const member = members.get(card.userId);
            if (member && member.roles.cache.has(settings.unverifiedRoleId)) continue;
            try {
                await this.closeCard(guild, card.userId, member ? 'closed' : 'left', member || null);
                closed++;
            } catch (error) {
                console.error(`Verification reconcile: closing ${card.userId} failed:`, error.message || error);
            }
        }

        return { closed, queued: pending.length - closed };
    }
}

module.exports = new VerificationService();
