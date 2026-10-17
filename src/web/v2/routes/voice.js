const express = require('express');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const VoiceService = require('../../../modules/voice/VoiceService');
const SquadService = require('../../../modules/voice/SquadService');
const { isVoice } = require('../../../modules/voice/VoiceService');
const { panelRoleFromPermissions } = require('../access');
const { actorOf, sendResult } = require('../result');
const { userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const STATUS = {
    invalid_targets: 400,
    invalid_action: 400,
    invalid_name: 400,
    invalid_limit: 400,
    need_two_channels: 400,
    forbidden: 403,
    channel_forbidden: 403,
    target_protected: 403,
    target_higher: 403,
    channel_not_found: 404,
    squad_not_found: 404,
    nobody: 409,
    bot_missing_permission: 409,
    bot_cannot_channel: 409,
    rename_rate_limited: 429
};

const SNOWFLAKE_RE = /^\d{17,20}$/;

function describeTile(guild, member) {
    const voice = member.voice;
    return {
        id: member.id,
        displayName: member.displayName,
        avatarURL: member.user.displayAvatarURL({ size: 64, extension: 'png' }),
        bot: member.user.bot,
        selfMute: Boolean(voice.selfMute),
        selfDeaf: Boolean(voice.selfDeaf),
        serverMute: Boolean(voice.serverMute),
        serverDeaf: Boolean(voice.serverDeaf),
        streaming: Boolean(voice.streaming),
        video: Boolean(voice.selfVideo),
        since: VoiceService.inChannelSince(guild.id, member.id),
        moderator: panelRoleFromPermissions(member.permissions) !== 'none',
        mutedUntil: (member.communicationDisabledUntilTimestamp || 0) > Date.now()
            ? new Date(member.communicationDisabledUntilTimestamp).toISOString()
            : null,
        topRoles: member.roles.cache
            .filter(role => role.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .first(3)
            .map(role => ({ name: role.name, color: role.hexColor }))
    };
}

function describeChannel(guild, channel) {
    const everyone = channel.permissionOverwrites.cache.get(guild.id);
    return {
        id: channel.id,
        name: channel.name,
        stage: channel.type === ChannelType.GuildStageVoice,
        userLimit: channel.userLimit || 0,
        locked: Boolean(everyone?.deny.has(PermissionFlagsBits.Connect)),
        members: [...channel.members.values()]
            .map(member => describeTile(guild, member))
            .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'))
    };
}

/** Voice channels grouped by category, in the server's own order. */
function describeBoard(guild) {
    const voiceChannels = [...guild.channels.cache.values()]
        .filter(isVoice)
        .sort((a, b) => a.rawPosition - b.rawPosition);
    const categories = new Map();
    for (const channel of voiceChannels) {
        const key = channel.parentId || '';
        if (!categories.has(key)) {
            categories.set(key, {
                id: channel.parentId || null,
                name: channel.parent?.name || 'Без категории',
                position: channel.parent ? channel.parent.rawPosition : -1,
                channels: []
            });
        }
        categories.get(key).channels.push(describeChannel(guild, channel));
    }
    return [...categories.values()]
        .sort((a, b) => a.position - b.position)
        .map(({ position, ...category }) => category);
}

function idList(value) {
    return Array.isArray(value) ? value.map(String).filter(id => SNOWFLAKE_RE.test(id)) : null;
}

function validChannel(req, res, next) {
    if (!SNOWFLAKE_RE.test(req.params.channelId)) return res.status(400).json({ error: 'invalid_channel_id' });
    next();
}

// Every handler below follows the same shape
const handle = run => async (req, res, next) => {
    try {
        sendResult(res, await run(req, actorOf(req)), STATUS);
    } catch (error) {
        next(error);
    }
};

// GET /voice — the board, plus which actions the viewer may use
router.get('/', (req, res) => {
    const guild = req.guild;
    const viewer = guild.members.cache.get(req.session.userId);
    const has = flag => Boolean(viewer?.permissions.has(flag));
    res.json({
        categories: describeBoard(guild),
        myChannelId: viewer?.voice?.channelId || null,
        can: {
            move: has(PermissionFlagsBits.MoveMembers),
            mute: has(PermissionFlagsBits.MuteMembers),
            deafen: has(PermissionFlagsBits.DeafenMembers),
            timeout: has(PermissionFlagsBits.ModerateMembers),
            roles: has(PermissionFlagsBits.ManageRoles),
            channels: has(PermissionFlagsBits.ManageChannels)
        }
    });
});

// POST /voice/move — { userIds, channelId } or { moves: [{ userId, channelId }], kind: 'undo'|'split' }
router.post('/move', handle((req, actor) => {
    const body = req.body || {};
    if (Array.isArray(body.moves)) {
        const kind = ['undo', 'split'].includes(body.kind) ? body.kind : 'move';
        const moves = body.moves
            .filter(move => SNOWFLAKE_RE.test(String(move?.userId)) && SNOWFLAKE_RE.test(String(move?.channelId)))
            .map(move => ({ userId: String(move.userId), channelId: String(move.channelId) }));
        const details = kind === 'split' && SNOWFLAKE_RE.test(String(body.sourceChannelId))
            ? { sourceChannelId: String(body.sourceChannelId) }
            : {};
        return VoiceService.moveEach(req.guild, moves, actor, 'panel', { kind, details });
    }
    return VoiceService.move(req.guild, idList(body.userIds), String(body.channelId || ''), actor, 'panel');
}));

// POST /voice/gather — { channelId, fromChannelIds }: everyone from those channels into channelId
router.post('/gather', handle((req, actor) =>
    VoiceService.gather(req.guild, String(req.body?.channelId || ''), idList(req.body?.fromChannelIds) || [], actor, 'panel')));

// --- Squads ----------------------------------------------------------------------

router.get('/squads', async (req, res, next) => {
    try {
        const guild = req.guild;
        const squads = await SquadService.list(guild.id);
        res.json({
            items: squads.map(squad => ({
                id: squad.id,
                name: squad.name,
                members: squad.memberIds.map(id => userRef(guild, id)),
                updatedAt: squad.updatedAt
            }))
        });
    } catch (error) {
        next(error);
    }
});

router.post('/squads', handle((req, actor) =>
    VoiceService.saveSquad(req.guild, { name: req.body?.name, memberIds: idList(req.body?.memberIds) }, actor, 'panel')));

router.put('/squads/:squadId', handle((req, actor) =>
    VoiceService.saveSquad(req.guild, { id: req.params.squadId, name: req.body?.name, memberIds: idList(req.body?.memberIds) }, actor, 'panel')));

router.delete('/squads/:squadId', handle((req, actor) =>
    VoiceService.deleteSquad(req.guild, req.params.squadId, actor, 'panel')));

router.post('/squads/:squadId/gather', handle((req, actor) =>
    VoiceService.gatherSquad(req.guild, req.params.squadId, String(req.body?.channelId || ''), actor, 'panel')));

// --- Channels --------------------------------------------------------------------

// POST /voice/channels/:channelId/mute-all — { on, exceptIds }
router.post('/channels/:channelId/mute-all', validChannel, handle((req, actor) =>
    VoiceService.muteChannel(req.guild, req.params.channelId, req.body?.on !== false, actor, 'panel', {
        exceptIds: idList(req.body?.exceptIds) || []
    })));

// POST /voice/channels/:channelId/lock — { locked }
router.post('/channels/:channelId/lock', validChannel, handle((req, actor) =>
    VoiceService.setLocked(req.guild, req.params.channelId, req.body?.locked !== false, actor, 'panel')));

// PATCH /voice/channels/:channelId — { name?, userLimit? }
router.patch('/channels/:channelId', validChannel, handle((req, actor) =>
    VoiceService.editChannel(req.guild, req.params.channelId, {
        name: req.body?.name,
        userLimit: req.body?.userLimit
    }, actor, 'panel')));

// POST /voice/{mute|unmute|deafen|undeafen|disconnect} — { userIds }
router.post('/:action', handle((req, actor) =>
    VoiceService.apply(req.guild, req.params.action, idList(req.body?.userIds), actor, 'panel')));

module.exports = router;
module.exports.describeBoard = describeBoard;
