const { ChannelType, PermissionFlagsBits } = require('discord.js');
const AuditLogService = require('../../services/AuditLogService');
const SquadService = require('./SquadService');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const NOT_IN_VOICE = 40032; // "Target user is not connected to voice"
const MISSING_PERMISSIONS = 50013;
const MAX_TARGETS = 100;
const CONCURRENCY = 5;
const MAX_CHANNEL_NAME = 100;
const MAX_SQUAD_NAME = 60;
const RENAME_WINDOW_MS = 10 * 60 * 1000; // Discord allows 2 renames per channel per 10 min
const RENAMES_PER_WINDOW = 2;

/**
 * Group actions on members in voice. move: anyone (as in Discord itself);
 * mute, deafen and disconnect: only members ranked below the actor.
 */
const MEMBER_ACTIONS = {
    mute: {
        permission: PermissionFlagsBits.MuteMembers,
        log: 'voice.muted',
        apply: (member, reason) => member.voice.setMute(true, reason)
    },
    unmute: {
        permission: PermissionFlagsBits.MuteMembers,
        log: 'voice.unmuted',
        apply: (member, reason) => member.voice.setMute(false, reason)
    },
    deafen: {
        permission: PermissionFlagsBits.DeafenMembers,
        log: 'voice.deafened',
        apply: (member, reason) => member.voice.setDeaf(true, reason)
    },
    undeafen: {
        permission: PermissionFlagsBits.DeafenMembers,
        log: 'voice.undeafened',
        apply: (member, reason) => member.voice.setDeaf(false, reason)
    },
    disconnect: {
        permission: PermissionFlagsBits.MoveMembers,
        log: 'voice.disconnected',
        apply: (member, reason) => member.voice.disconnect(reason)
    }
};

/** Audit action for each kind of move, so the journal tells a split from a plain move. */
const MOVE_KINDS = {
    move: 'voice.moved',
    undo: 'voice.move_undone',
    split: 'voice.split',
    gather: 'voice.gathered'
};

function discordReason(text, actor) {
    return `${text} · ${actor.tag || actor.id || 'Nexus'}`;
}

function isVoice(channel) {
    return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

/** Run fn over items, at most `limit` at a time (discord.js queues per-route rate limits itself). */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

/** Fisher–Yates on a copy; random is injectable for tests. */
function shuffle(items, random = Math.random) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/** Deal userIds round-robin into channels: team sizes differ by at most one. */
function dealTeams(userIds, channelIds, random = Math.random) {
    return shuffle(userIds, random).map((userId, index) => ({ userId, channelId: channelIds[index % channelIds.length] }));
}

/**
 * Why `actor` may not mute/deafen/disconnect `target`, or null if they may.
 * Unlike punishments, acting on yourself and on bots (music bots) is fine.
 */
function voiceTargetProblem(guild, actor, target) {
    if (target.id === actor.id) return null;
    if (target.id === guild.ownerId) return 'target_protected';
    if (actor.id !== guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
        return 'target_higher';
    }
    return null;
}

function errorCode(error) {
    if (error.code === NOT_IN_VOICE) return 'not_in_voice';
    if (error.code === MISSING_PERMISSIONS) return 'bot_cannot';
    if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return 'member_not_found';
    return 'failed';
}

function cleanIds(userIds) {
    if (!Array.isArray(userIds)) return null;
    const ids = [...new Set(userIds.map(String))];
    if (ids.length === 0 || ids.length > MAX_TARGETS) return null;
    return ids;
}

/**
 * Moves, mutes, deafens and disconnects in voice, voice-channel settings and
 * group role changes — shared by slash commands and the desktop panel.
 * Bulk methods return { ok: true, done: [userId], failed: [{ userId, name, code }] }
 * (moves also return moves: [{ userId, from, to }] for undo) or { ok: false, code }.
 */
class VoiceService {
    constructor() {
        this.renames = new Map(); // channelId -> [timestamps]
        this.lastSplit = new Map(); // guildId -> { sourceChannelId, targetChannelIds }
        this.since = new Map(); // "guildId:userId" -> when they entered their current channel
    }

    /** Remember when a member entered a channel (unknown for those already in voice at startup). */
    noteChannel(guildId, userId, channelId, at = Date.now()) {
        const key = `${guildId}:${userId}`;
        if (channelId) this.since.set(key, at);
        else this.since.delete(key);
    }

    inChannelSince(guildId, userId) {
        const at = this.since.get(`${guildId}:${userId}`);
        return at ? new Date(at).toISOString() : null;
    }

    async fetchMember(guild, userId) {
        const cached = guild.members.cache.get(userId);
        if (cached) return cached;
        try {
            return await guild.members.fetch(userId);
        } catch (error) {
            if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return null;
            throw error;
        }
    }

    /** The acting moderator if they hold every permission, otherwise null. */
    async authorize(guild, actor, ...permissions) {
        const member = await this.fetchMember(guild, actor.id);
        return member && permissions.every(flag => member.permissions.has(flag)) ? member : null;
    }

    botHas(guild, permission, channel = null) {
        const me = guild.members.me;
        if (!me) return false;
        return channel ? Boolean(channel.permissionsFor(me)?.has(permission)) : me.permissions.has(permission);
    }

    // --- Moves -------------------------------------------------------------------

    /**
     * Move each target to its own channel.
     * @param {Array<{ userId: string, channelId: string }>} targets
     * @param {'move'|'undo'|'split'|'gather'} kind
     */
    async moveEach(guild, targets, actor, source, { kind = 'move', details = {} } = {}) {
        if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
            return { ok: false, code: 'invalid_targets' };
        }
        const actorMember = await this.authorize(guild, actor, PermissionFlagsBits.MoveMembers);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        if (!this.botHas(guild, PermissionFlagsBits.MoveMembers)) return { ok: false, code: 'bot_missing_permission' };

        // Every destination must be a voice channel the actor and the bot may enter
        const channels = new Map();
        for (const channelId of new Set(targets.map(target => String(target.channelId)))) {
            const channel = guild.channels.cache.get(channelId);
            if (!isVoice(channel)) return { ok: false, code: 'channel_not_found' };
            if (!channel.permissionsFor(actorMember)?.has(PermissionFlagsBits.Connect)) {
                return { ok: false, code: 'channel_forbidden' };
            }
            if (!this.botHas(guild, PermissionFlagsBits.Connect, channel)) return { ok: false, code: 'bot_cannot_channel' };
            channels.set(channelId, channel);
        }

        const unique = [...new Map(targets.map(target => [String(target.userId), String(target.channelId)])).entries()];
        const reason = discordReason('Перемещение', actor);
        const results = await mapLimit(unique, CONCURRENCY, async ([userId, channelId]) => {
            const member = await this.fetchMember(guild, userId).catch(() => null);
            if (!member) return { userId, name: null, code: 'member_not_found' };
            const from = member.voice?.channelId || null;
            if (!from) return { userId, name: member.displayName, code: 'not_in_voice' };
            if (from === channelId) return { userId, name: member.displayName, from, to: channelId, skipped: true };
            try {
                await member.voice.setChannel(channelId, reason);
                return { userId, name: member.displayName, from, to: channelId };
            } catch (error) {
                return { userId, name: member.displayName, code: errorCode(error) };
            }
        });

        const failed = results.filter(r => r.code).map(({ userId, name, code }) => ({ userId, name, code }));
        const moves = results.filter(r => !r.code && !r.skipped).map(({ userId, from, to }) => ({ userId, from, to }));
        const done = results.filter(r => !r.code).map(r => r.userId);

        if (moves.length > 0) {
            const destinations = [...new Set(moves.map(move => move.to))];
            await AuditLogService.log({
                guildId: guild.id,
                action: MOVE_KINDS[kind] || MOVE_KINDS.move,
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: moves.map(move => move.userId),
                source,
                details: {
                    ...details,
                    channelId: destinations.length === 1 ? destinations[0] : null,
                    channelName: destinations.length === 1 ? channels.get(destinations[0]).name : null,
                    channelCount: destinations.length,
                    failed: failed.length
                }
            });
            // "Собрать обратно" (/voice gather) needs to know where the teams went
            if (kind === 'split' && details.sourceChannelId) {
                this.lastSplit.set(guild.id, { sourceChannelId: details.sourceChannelId, targetChannelIds: destinations });
            }
        }
        return { ok: true, done, failed, moves };
    }

    /** Move members to one channel. */
    async move(guild, userIds, channelId, actor, source, options = {}) {
        const ids = cleanIds(userIds);
        if (!ids) return { ok: false, code: 'invalid_targets' };
        return this.moveEach(guild, ids.map(userId => ({ userId, channelId })), actor, source, options);
    }

    /** Non-bot members currently in a voice channel. */
    membersIn(guild, channelId, { exceptIds = [] } = {}) {
        const channel = guild.channels.cache.get(channelId);
        if (!isVoice(channel)) return null;
        const except = new Set(exceptIds);
        return [...channel.members.values()].filter(member => !member.user.bot && !except.has(member.id));
    }

    /** Everyone from `fromChannelIds` into `intoChannelId` ("Собрать сюда", "Собрать обратно"). */
    async gather(guild, intoChannelId, fromChannelIds, actor, source) {
        const ids = [];
        for (const channelId of new Set(fromChannelIds || [])) {
            if (channelId === intoChannelId) continue;
            const members = this.membersIn(guild, channelId);
            if (!members) return { ok: false, code: 'channel_not_found' };
            ids.push(...members.map(member => member.id));
        }
        if (ids.length === 0) return { ok: false, code: 'nobody' };
        return this.move(guild, ids, intoChannelId, actor, source, { kind: 'gather' });
    }

    /**
     * Split a channel into teams over the given channels, at random.
     * exceptIds stay where they are (the host).
     */
    async split(guild, sourceChannelId, targetChannelIds, actor, source, { exceptIds = [], random } = {}) {
        const members = this.membersIn(guild, sourceChannelId, { exceptIds });
        if (!members) return { ok: false, code: 'channel_not_found' };
        const targets = [...new Set(targetChannelIds || [])].filter(id => id !== sourceChannelId);
        if (targets.length < 2) return { ok: false, code: 'need_two_channels' };
        if (members.length < 2) return { ok: false, code: 'nobody' };

        const assignments = dealTeams(members.map(member => member.id), targets, random);
        const result = await this.moveEach(guild, assignments, actor, source, {
            kind: 'split',
            details: { sourceChannelId, teams: targets.length }
        });
        return { ...result, sourceChannelId, targetChannelIds: targets };
    }

    /**
     * Empty voice channels next to `channel` (same category) that the actor and
     * the bot can use — where /voice split sends the teams.
     */
    freeChannelsNear(guild, channel, actorMember, count) {
        return [...guild.channels.cache.values()]
            .filter(other => other.id !== channel.id
                && other.type === ChannelType.GuildVoice
                && other.parentId === channel.parentId
                && other.members.size === 0
                && other.permissionsFor(actorMember)?.has(PermissionFlagsBits.Connect)
                && this.botHas(guild, PermissionFlagsBits.Connect, other))
            .sort((a, b) => a.rawPosition - b.rawPosition)
            .slice(0, count);
    }

    // --- Mute / deafen / disconnect ----------------------------------------------

    /** @param {'mute'|'unmute'|'deafen'|'undeafen'|'disconnect'} action */
    async apply(guild, action, userIds, actor, source, { details = {} } = {}) {
        const spec = Object.hasOwn(MEMBER_ACTIONS, action) ? MEMBER_ACTIONS[action] : null;
        if (!spec) return { ok: false, code: 'invalid_action' };
        const ids = cleanIds(userIds);
        if (!ids) return { ok: false, code: 'invalid_targets' };
        const actorMember = await this.authorize(guild, actor, spec.permission);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        if (!this.botHas(guild, spec.permission)) return { ok: false, code: 'bot_missing_permission' };

        const reason = discordReason(action === 'disconnect' ? 'Отключение от голоса' : 'Голосовое действие', actor);
        const results = await mapLimit(ids, CONCURRENCY, async userId => {
            const member = await this.fetchMember(guild, userId).catch(() => null);
            if (!member) return { userId, name: null, code: 'member_not_found' };
            const problem = voiceTargetProblem(guild, actorMember, member);
            if (problem) return { userId, name: member.displayName, code: problem };
            if (!member.voice?.channelId) return { userId, name: member.displayName, code: 'not_in_voice' };
            try {
                await spec.apply(member, reason);
                return { userId, name: member.displayName };
            } catch (error) {
                return { userId, name: member.displayName, code: errorCode(error) };
            }
        });

        const failed = results.filter(r => r.code);
        const done = results.filter(r => !r.code).map(r => r.userId);
        if (done.length > 0) {
            await AuditLogService.log({
                guildId: guild.id,
                action: spec.log,
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: done,
                source,
                details: { ...details, failed: failed.length }
            });
        }
        return { ok: true, done, failed };
    }

    /**
     * Mute (or unmute) everyone in a channel except exceptIds (the host) and bots.
     * Members ranked at or above the actor are left alone and reported as failed.
     */
    async muteChannel(guild, channelId, on, actor, source, { exceptIds = [] } = {}) {
        const channel = guild.channels.cache.get(channelId);
        const members = this.membersIn(guild, channelId, { exceptIds });
        if (!members) return { ok: false, code: 'channel_not_found' };
        const targets = members.filter(member => Boolean(member.voice.serverMute) !== on);
        if (targets.length === 0) return { ok: false, code: 'nobody' };
        return this.apply(guild, on ? 'mute' : 'unmute', targets.map(member => member.id), actor, source, {
            details: { channelId, channelName: channel.name, wholeChannel: true }
        });
    }

    // --- Squads ------------------------------------------------------------------

    /** Create or update a squad. Anyone who may move members manages squads. */
    async saveSquad(guild, { id, name, memberIds }, actor, source) {
        if (!(await this.authorize(guild, actor, PermissionFlagsBits.MoveMembers))) return { ok: false, code: 'forbidden' };
        const clean = String(name || '').trim().slice(0, MAX_SQUAD_NAME);
        if (!clean) return { ok: false, code: 'invalid_name' };
        const ids = cleanIds(memberIds);
        if (!ids) return { ok: false, code: 'invalid_targets' };
        if (id && !(await SquadService.get(guild.id, String(id)))) return { ok: false, code: 'squad_not_found' };

        const squad = await SquadService.save({ id: id ? String(id) : undefined, guildId: guild.id, name: clean, memberIds: ids, actorId: actor.id });
        await AuditLogService.log({
            guildId: guild.id,
            action: 'voice.squad_saved',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [],
            source,
            details: { squadId: squad.id, squadName: squad.name, size: ids.length }
        });
        return { ok: true, squad };
    }

    async deleteSquad(guild, squadId, actor, source) {
        if (!(await this.authorize(guild, actor, PermissionFlagsBits.MoveMembers))) return { ok: false, code: 'forbidden' };
        const squad = await SquadService.get(guild.id, String(squadId));
        if (!squad) return { ok: false, code: 'squad_not_found' };
        await SquadService.remove(guild.id, squad.id);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'voice.squad_deleted',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [],
            source,
            details: { squadId: squad.id, squadName: squad.name }
        });
        return { ok: true };
    }

    /**
     * Bring a squad into a channel: members in voice are moved, members on the
     * server but not in voice get a DM with a link to the channel.
     */
    async gatherSquad(guild, squadId, channelId, actor, source) {
        const squad = await SquadService.get(guild.id, String(squadId));
        if (!squad) return { ok: false, code: 'squad_not_found' };
        const channel = guild.channels.cache.get(String(channelId));
        if (!isVoice(channel)) return { ok: false, code: 'channel_not_found' };

        const inVoice = [];
        const absent = [];
        for (const userId of squad.memberIds) {
            const member = await this.fetchMember(guild, userId).catch(() => null);
            if (!member) continue; // left the server
            if (member.voice?.channelId) inVoice.push(member.id);
            else absent.push(member);
        }

        let result;
        if (inVoice.length > 0) {
            result = await this.moveEach(guild, inVoice.map(userId => ({ userId, channelId: channel.id })), actor, source, {
                kind: 'gather',
                details: { squadId: squad.id, squadName: squad.name }
            });
            if (!result.ok) return result;
        } else {
            if (!(await this.authorize(guild, actor, PermissionFlagsBits.MoveMembers))) return { ok: false, code: 'forbidden' };
            result = { ok: true, done: [], failed: [], moves: [] };
        }

        const link = `https://discord.com/channels/${guild.id}/${channel.id}`;
        const invited = [];
        for (const member of absent) {
            try {
                await member.send(`Вас зовут в голосовой канал «${channel.name}» на сервере «${guild.name}» (состав «${squad.name}»): ${link}`);
                invited.push(member.id);
            } catch {
                result.failed.push({ userId: member.id, name: member.displayName, code: 'dm_closed' });
            }
        }
        if (invited.length > 0) {
            await AuditLogService.log({
                guildId: guild.id,
                action: 'voice.squad_invited',
                actorId: actor.id,
                actorTag: actor.tag,
                targetIds: invited,
                source,
                details: { squadId: squad.id, squadName: squad.name, channelId: channel.id, channelName: channel.name }
            });
        }
        return { ...result, invited };
    }

    // --- Channel settings --------------------------------------------------------

    async authorizeChannel(guild, channelId, actor) {
        const channel = guild.channels.cache.get(channelId);
        if (!isVoice(channel)) return { code: 'channel_not_found' };
        const actorMember = await this.fetchMember(guild, actor.id);
        if (!actorMember || !channel.permissionsFor(actorMember)?.has(PermissionFlagsBits.ManageChannels)) {
            return { code: 'forbidden' };
        }
        return { channel, actorMember };
    }

    /** Close the channel to @everyone (deny Connect) or open it again. */
    async setLocked(guild, channelId, locked, actor, source) {
        const { channel, code } = await this.authorizeChannel(guild, channelId, actor);
        if (code) return { ok: false, code };
        if (!this.botHas(guild, PermissionFlagsBits.ManageChannels, channel)
            || !this.botHas(guild, PermissionFlagsBits.ManageRoles, channel)) {
            return { ok: false, code: 'bot_cannot_channel' };
        }

        // null clears our deny without touching other overwrites of @everyone
        await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: locked ? false : null },
            { reason: discordReason(locked ? 'Канал закрыт' : 'Канал открыт', actor) });
        await AuditLogService.log({
            guildId: guild.id,
            action: locked ? 'voice.channel_locked' : 'voice.channel_unlocked',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [],
            source,
            details: { channelId, channelName: channel.name }
        });
        return { ok: true };
    }

    /** Rename and/or change the user limit (0 = no limit). */
    async editChannel(guild, channelId, { name, userLimit }, actor, source) {
        const { channel, code } = await this.authorizeChannel(guild, channelId, actor);
        if (code) return { ok: false, code };
        if (!this.botHas(guild, PermissionFlagsBits.ManageChannels, channel)) return { ok: false, code: 'bot_cannot_channel' };

        const patch = {};
        if (name !== undefined) {
            const clean = String(name).trim().slice(0, MAX_CHANNEL_NAME);
            if (!clean) return { ok: false, code: 'invalid_name' };
            if (clean !== channel.name) patch.name = clean;
        }
        if (userLimit !== undefined) {
            const limit = Number(userLimit);
            if (!Number.isInteger(limit) || limit < 0 || limit > 99) return { ok: false, code: 'invalid_limit' };
            if (limit !== channel.userLimit) patch.userLimit = limit;
        }
        if (Object.keys(patch).length === 0) return { ok: true, unchanged: true };

        // discord.js would silently wait out Discord's rename limit (up to 10 min) — refuse instead
        if (patch.name) {
            const now = Date.now();
            const recent = (this.renames.get(channelId) || []).filter(at => now - at < RENAME_WINDOW_MS);
            if (recent.length >= RENAMES_PER_WINDOW) return { ok: false, code: 'rename_rate_limited' };
            this.renames.set(channelId, [...recent, now]);
        }

        const before = { name: channel.name, userLimit: channel.userLimit };
        await channel.edit({ ...patch, reason: discordReason('Настройки канала', actor) });
        await AuditLogService.log({
            guildId: guild.id,
            action: 'voice.channel_edited',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [],
            source,
            details: { channelId, channelName: patch.name || before.name, before, after: { ...before, ...patch } }
        });
        return { ok: true };
    }
}

module.exports = new VoiceService();
module.exports.voiceTargetProblem = voiceTargetProblem;
module.exports.dealTeams = dealTeams;
module.exports.isVoice = isVoice;
module.exports.MAX_TARGETS = MAX_TARGETS;
