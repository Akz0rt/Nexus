const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const AuditLogService = require('../../../services/AuditLogService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const WarningService = require('../../../modules/moderation/WarningService');
const TempRoleService = require('../../../modules/roles/TempRoleService');
const { roleProblem } = require('../../../services/RoleService');
const { canSeeEntry } = require('../visibility');
const { describeMember, serializeCard, userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;

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
                expiresAt: temporary.get(role.id) || null
            }));

        const voice = member.voice?.channel
            ? {
                id: member.voice.channel.id,
                name: member.voice.channel.name,
                serverMute: Boolean(member.voice.serverMute),
                serverDeaf: Boolean(member.voice.serverDeaf)
            }
            : null;

        const [history, card, warnings] = await Promise.all([
            AuditLogService.query({ guildId: guild.id, targetId: userId }, { limit: 50 })
                .then(r => r.items.filter(entry => canSeeEntry(guild, viewer, entry))),
            QueueCardService.get(guild.id, userId),
            WarningService.listActive(guild.id, userId)
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
            deafen: has(PermissionFlagsBits.DeafenMembers)
        };

        res.json({
            member: describeMember(member),
            roles,
            voice,
            card: serializeCard(card),
            history,
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

module.exports = router;
module.exports.extractId = extractId;
