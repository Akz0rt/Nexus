const { GuildFeature, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../../services/GuildSettingsService');
const AuditLogService = require('../../services/AuditLogService');

/**
 * Lockdown closes the server for a while: invites paused (nobody new gets in by
 * any link) and slowmode in the start channels. Turning it off restores exactly
 * what was there before — invites stay paused if they already were, each channel
 * gets its old slowmode back. The state lives in the guild settings doc, so it
 * survives a restart. Only administrators may use it.
 */
class LockdownService {
    constructor() {
        this.busy = new Set(); // guildIds with a change in flight
    }

    async status(guild) {
        const settings = await GuildSettingsService.get(guild.id);
        const state = settings.lockdownState?.active ? settings.lockdownState : null;
        return {
            active: Boolean(state),
            since: state?.since || null,
            actorId: state?.actorId || null,
            actorTag: state?.actorTag || null,
            invitesPaused: guild.features.includes(GuildFeature.InvitesDisabled),
            channelIds: settings.lockdown.channelIds,
            // Names for the banner ("slowmode 30 с в #старт"); a deleted channel has none
            channels: settings.lockdown.channelIds.map(id => ({ id, name: guild.channels.cache.get(id)?.name || null })),
            slowmodeSeconds: settings.lockdown.slowmodeSeconds
        };
    }

    async authorize(guild, actor) {
        const member = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
        return Boolean(member?.permissions.has(PermissionFlagsBits.Administrator));
    }

    async setInvitesPaused(guild, paused, reason) {
        const features = guild.features.filter(feature => feature !== GuildFeature.InvitesDisabled);
        if (paused) features.push(GuildFeature.InvitesDisabled);
        await guild.edit({ features, reason });
    }

    async withLock(guildId, fn) {
        if (this.busy.has(guildId)) return { ok: false, code: 'in_progress' };
        this.busy.add(guildId);
        try {
            return await fn();
        } finally {
            this.busy.delete(guildId);
        }
    }

    async enable(guild, actor, source) {
        if (!(await this.authorize(guild, actor))) return { ok: false, code: 'forbidden' };
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return { ok: false, code: 'bot_missing_manage_guild' };

        return this.withLock(guild.id, async () => {
            const settings = await GuildSettingsService.get(guild.id);
            if (settings.lockdownState?.active) return { ok: false, code: 'already_active' };
            const reason = `Lockdown · ${actor.tag || actor.id}`;
            const seconds = settings.lockdown.slowmodeSeconds;

            const invitesWerePaused = guild.features.includes(GuildFeature.InvitesDisabled);
            if (!invitesWerePaused) await this.setInvitesPaused(guild, true, reason);

            const channels = [];
            const failed = [];
            for (const channelId of settings.lockdown.channelIds) {
                const channel = guild.channels.cache.get(channelId);
                if (!channel?.setRateLimitPerUser) {
                    failed.push({ id: channelId, name: null, code: 'channel_not_found' });
                    continue;
                }
                const previous = channel.rateLimitPerUser || 0;
                try {
                    if (previous < seconds) await channel.setRateLimitPerUser(seconds, reason);
                    channels.push({ id: channel.id, previous });
                } catch (error) {
                    failed.push({ id: channel.id, name: channel.name, code: 'bot_cannot' });
                }
            }

            const state = {
                active: true,
                since: new Date().toISOString(),
                actorId: actor.id,
                actorTag: actor.tag || null,
                invitesWerePaused,
                channels
            };
            await GuildSettingsService.update(guild.id, { lockdownState: state });
            await AuditLogService.log({
                guildId: guild.id,
                action: 'server.lockdown_on',
                actorId: actor.id,
                actorTag: actor.tag,
                source,
                details: {
                    slowmodeSeconds: seconds,
                    channelNames: channels.map(c => guild.channels.cache.get(c.id)?.name).filter(Boolean),
                    failed: failed.length
                }
            });
            return { ok: true, status: await this.status(guild), failed };
        });
    }

    async disable(guild, actor, source) {
        if (!(await this.authorize(guild, actor))) return { ok: false, code: 'forbidden' };

        return this.withLock(guild.id, async () => {
            const settings = await GuildSettingsService.get(guild.id);
            const state = settings.lockdownState;
            if (!state?.active) return { ok: false, code: 'not_active' };
            const reason = `Lockdown снят · ${actor.tag || actor.id}`;

            const failed = [];
            if (!state.invitesWerePaused && guild.features.includes(GuildFeature.InvitesDisabled)) {
                try {
                    await this.setInvitesPaused(guild, false, reason);
                } catch (error) {
                    failed.push({ id: 'invites', name: 'инвайты', code: 'bot_cannot' });
                }
            }
            for (const { id, previous } of state.channels || []) {
                const channel = guild.channels.cache.get(id);
                if (!channel?.setRateLimitPerUser) continue; // deleted meanwhile
                try {
                    await channel.setRateLimitPerUser(previous || 0, reason);
                } catch (error) {
                    failed.push({ id, name: channel.name, code: 'bot_cannot' });
                }
            }

            await GuildSettingsService.update(guild.id, {
                lockdownState: { active: false, endedAt: new Date().toISOString(), endedBy: actor.id, startedAt: state.since }
            });
            await AuditLogService.log({
                guildId: guild.id,
                action: 'server.lockdown_off',
                actorId: actor.id,
                actorTag: actor.tag,
                source,
                details: { sinceMs: Date.now() - Date.parse(state.since), failed: failed.length }
            });
            return { ok: true, status: await this.status(guild), failed };
        });
    }
}

module.exports = new LockdownService();
