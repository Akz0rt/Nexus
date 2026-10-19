const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const config = require('../../../config');
const AuditLogService = require('../../../services/AuditLogService');
const ActivityService = require('../../../services/ActivityService');
const CosmosDBService = require('../../../services/CosmosDBService');
const VoiceService = require('../../../modules/voice/VoiceService');
const MemberNoteService = require('../../../modules/members/MemberNoteService');
const BoosterPassService = require('../../../modules/boosters/BoosterPassService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const WarningService = require('../../../modules/moderation/WarningService');
const TempRoleService = require('../../../modules/roles/TempRoleService');
const { roleProblem } = require('../../../services/RoleService');
const { canSeeEntry } = require('../visibility');
const { describeMember, flagContext, serializeCard, userRef } = require('../serialize');
const { actorOf, sendResult } = require('../result');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_NICK = 32;

/** Why the viewer can't take a role away: above the bot, above the viewer, an integration's, or no Manage Roles */
function roleLock(guild, viewer, role, manageRoles) {
    if (role.managed) return 'managed';
    if (!role.editable) return 'bot';
    if (!manageRoles) return 'no_permission';
    return roleProblem(guild, viewer, role) ? 'higher' : null;
}

// A missing database (or another server than the activity one) leaves the fact empty
const quiet = promise => promise.catch(() => null);

// "<@123>", "<@!123>" or a bare ID → ID
function extractId(query) {
    const match = /^<@!?(\d{17,20})>$/.exec(query);
    if (match) return match[1];
    return SNOWFLAKE_RE.test(query) ? query : null;
}

// GET /members/search?q= — nickname, server nickname, ID or @mention
router.get('/search', async (req, res, next) => {
    try {
        const query = String(req.query.q || '').trim();
        if (query.length < 2) return res.json({ items: [] });

        const guild = req.guild;
        const found = new Map();
        // Cache is complete after one full fetch; the GuildMembers intent keeps it current
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();

        const id = extractId(query);
        if (id) {
            const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
            if (member) found.set(member.id, member);
        }

        const needle = query.toLowerCase();
        for (const member of guild.members.cache.values()) {
            if (found.size >= 20) break;
            const names = [member.user.username, member.user.globalName, member.nickname];
            if (names.some(name => name && name.toLowerCase().includes(needle))) found.set(member.id, member);
        }

        res.json({ items: [...found.values()].map(describeMember) });
    } catch (error) {
        next(error);
    }
});

// GET /members/:userId — member card
router.get('/:userId', async (req, res, next) => {
    try {
        const guild = req.guild;
        const { userId } = req.params;
        if (!SNOWFLAKE_RE.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'member_not_found' });

        const viewer = guild.members.cache.get(req.session.userId);
        const has = flag => Boolean(viewer?.permissions.has(flag));
        const manageRoles = has(PermissionFlagsBits.ManageRoles);
        const temporary = new Map((await TempRoleService.listForUser(guild.id, userId)).map(grant => [grant.roleId, grant.expiresAt]));
        const roles = member.roles.cache
            .filter(role => role.id !== guild.id) // @everyone
            .sort((a, b) => b.position - a.position)
            .map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor,
                managed: role.managed,
                // May the viewer take it away (and give it): below their and the bot's highest role
                editable: manageRoles && !roleProblem(guild, viewer, role),
                lock: roleLock(guild, viewer, role, manageRoles),
                expiresAt: temporary.get(role.id) || null
            }));

        const voice = member.voice?.channel
            ? {
                id: member.voice.channel.id,
                name: member.voice.channel.name,
                serverMute: Boolean(member.voice.serverMute),
                serverDeaf: Boolean(member.voice.serverDeaf),
                since: VoiceService.inChannelSince(guild.id, userId)
            }
            : null;

        // Messages are collected for the main server only
        const activityHere = !config.guildId || config.guildId === guild.id;
        const [history, card, warnings, notes, lastMessageAt, birthday, boosterPass] = await Promise.all([
            AuditLogService.query({ guildId: guild.id, targetId: userId }, { limit: 50 })
                .then(r => r.items.filter(entry => canSeeEntry(guild, viewer, entry))),
            QueueCardService.get(guild.id, userId),
            WarningService.listActive(guild.id, userId),
            quiet(MemberNoteService.list(guild.id, userId)),
            activityHere ? quiet(ActivityService.lastMessageAt(userId)) : null,
            quiet(CosmosDBService.getBirthday(userId)),
            BoosterPassService.has(guild.id, userId) ? quiet(BoosterPassService.get(guild.id, userId)) : null
        ]);

        const mutedUntil = (member.communicationDisabledUntilTimestamp || 0) > Date.now()
            ? new Date(member.communicationDisabledUntilTimestamp).toISOString()
            : null;

        // Which punishment, voice and role buttons the viewer gets (the services re-check on every action)
        const can = {
            roles: manageRoles,
            warn: has(PermissionFlagsBits.ModerateMembers),
            mute: has(PermissionFlagsBits.ModerateMembers),
            kick: has(PermissionFlagsBits.KickMembers),
            ban: has(PermissionFlagsBits.BanMembers),
            move: has(PermissionFlagsBits.MoveMembers),
            voiceMute: has(PermissionFlagsBits.MuteMembers),
            deafen: has(PermissionFlagsBits.DeafenMembers),
            nick: has(PermissionFlagsBits.ManageNicknames)
        };

        res.json({
            member: { ...describeMember(member, await flagContext(guild, new Map([[member.id, card?.kickCount || 0]]))), nickname: member.nickname || null },
            roles,
            voice,
            card: serializeCard(card),
            history,
            lastMessageAt,
            booster: boosterPass
                ? { until: boosterPass.until, note: boosterPass.note || null, boostingSince: member.premiumSince ? member.premiumSince.toISOString() : null }
                : null,
            birthday: birthday ? { month: birthday.month, day: birthday.day } : null,
            // null: the notes couldn't be loaded
            notes: notes && notes.map(note => ({
                id: note.id,
                text: note.text,
                author: userRef(guild, note.authorId),
                createdAt: note.createdAt,
                canDelete: note.authorId === req.session.userId || req.panelRole === 'senior'
            })),
            moderation: {
                mutedUntil,
                warnings: warnings.map(warn => ({
                    id: warn.id,
                    reason: warn.reason,
                    actor: warn.actorId ? userRef(guild, warn.actorId) : null,
                    createdAt: warn.createdAt,
                    expiresAt: warn.expiresAt
                })),
                can
            }
        });
    } catch (error) {
        next(error);
    }
});

const NOTE_STATUSES = { note_not_found: 404, not_note_author: 403 };

// POST /members/:userId/notes { text }
router.post('/:userId/notes', async (req, res, next) => {
    try {
        if (!SNOWFLAKE_RE.test(req.params.userId)) return res.status(400).json({ error: 'invalid_user_id' });
        const result = await MemberNoteService.add(req.guild.id, req.params.userId, req.body?.text, actorOf(req));
        if (!result.ok) return sendResult(res, result, NOTE_STATUSES);
        const { note } = result;
        res.json({ ok: true, note: { id: note.id, text: note.text, author: userRef(req.guild, note.authorId), createdAt: note.createdAt, canDelete: true } });
    } catch (error) {
        next(error);
    }
});

// DELETE /members/:userId/notes/:noteId — the author or an administrator
router.delete('/:userId/notes/:noteId', async (req, res, next) => {
    try {
        const result = await MemberNoteService.remove(req.guild.id, req.params.userId, req.params.noteId, actorOf(req), req.panelRole === 'senior');
        sendResult(res, result, NOTE_STATUSES);
    } catch (error) {
        next(error);
    }
});

// PUT /members/:userId/nickname { nickname } — empty resets it to the account name
router.put('/:userId/nickname', async (req, res, next) => {
    try {
        const guild = req.guild;
        const viewer = guild.members.cache.get(req.session.userId) || await guild.members.fetch(req.session.userId).catch(() => null);
        if (!viewer?.permissions.has(PermissionFlagsBits.ManageNicknames)) return res.status(403).json({ error: 'forbidden' });
        if (!SNOWFLAKE_RE.test(req.params.userId)) return res.status(400).json({ error: 'invalid_user_id' });
        if (req.body?.nickname != null && typeof req.body.nickname !== 'string') return res.status(400).json({ error: 'invalid_nickname' });
        const nickname = (req.body?.nickname || '').trim();
        if (nickname.length > MAX_NICK) return res.status(400).json({ error: 'nickname_too_long' });

        const member = await guild.members.fetch(req.params.userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'member_not_found' });
        if (member.id === guild.ownerId) return res.status(403).json({ error: 'target_owner' });
        if (viewer.id !== guild.ownerId && member.id !== viewer.id && member.roles.highest.position >= viewer.roles.highest.position) {
            return res.status(403).json({ error: 'target_higher' });
        }
        if (!member.manageable) return res.status(403).json({ error: 'bot_cannot' });

        const before = member.nickname || null;
        const actor = actorOf(req);
        await member.setNickname(nickname || null, `Панель: ${actor.tag}`);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'member.nickname',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [member.id],
            source: 'panel',
            details: { before, after: nickname || null }
        });
        res.json({ ok: true, nickname: nickname || null, displayName: member.displayName });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.extractId = extractId;
