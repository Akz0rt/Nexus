const express = require('express');
const { ChannelType } = require('discord.js');
const EventService = require('../../../modules/events/EventService');
const VoiceService = require('../../../modules/voice/VoiceService');
const { actorOf, sendResult } = require('../result');
const { userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const STATUS = {
    invalid_title: 400,
    invalid_time: 400,
    invalid_name: 400,
    invalid_targets: 400,
    channel_not_found: 404,
    event_not_found: 404,
    squad_not_found: 404,
    forbidden: 403,
    channel_forbidden: 403,
    event_closed: 409,
    bot_cannot_channel: 409,
    bot_missing_permission: 409,
    nobody_going: 409
};

function describeEvent(guild, event) {
    return {
        id: event.id,
        title: event.title,
        description: event.description,
        startsAt: event.startsAt,
        channel: { id: event.channelId, name: guild.channels.cache.get(event.channelId)?.name || null },
        voiceChannel: event.voiceChannelId
            ? { id: event.voiceChannelId, name: guild.channels.cache.get(event.voiceChannelId)?.name || null }
            : null,
        repeatWeekly: Boolean(event.repeatWeekly),
        status: event.status,
        going: (event.going || []).map(id => userRef(guild, id)),
        remindedAt: event.remindedAt,
        squadId: event.squadId || null,
        createdBy: userRef(guild, event.createdBy),
        hasMessage: Boolean(event.messageId)
    };
}

const handle = run => async (req, res, next) => {
    try {
        const result = await run(req, actorOf(req));
        if (!result.ok) return res.status(STATUS[result.code] || 400).json({ error: result.code, field: result.field || null });
        res.json({ ...result, event: result.event ? describeEvent(req.guild, result.event) : undefined });
    } catch (error) {
        next(error);
    }
};

// GET /meetups?group=upcoming|past — plus the channels the form offers
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const group = req.query.group === 'past' ? 'past' : 'upcoming';
        const events = await EventService.list(guild.id, group);
        const channels = [...guild.channels.cache.values()]
            .filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type))
            .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
            .map(c => ({
                id: c.id,
                name: c.name,
                category: c.parent?.name || null,
                voice: c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
            }));
        res.json({ group, items: events.map(e => describeEvent(guild, e)), channels });
    } catch (error) {
        next(error);
    }
});

router.post('/', handle((req, actor) => EventService.create(req.guild, req.body || {}, actor, 'panel')));

router.put('/:eventId', handle((req, actor) => EventService.update(req.guild, req.params.eventId, req.body || {}, actor, 'panel')));

router.post('/:eventId/cancel', handle((req, actor) => EventService.cancel(req.guild, req.params.eventId, actor, 'panel')));

/** Save (or refresh) a voice squad from those going; reused by «Собрать». */
async function squadFromEvent(guild, eventId, actor) {
    const event = await EventService.get(guild.id, eventId);
    if (!event) return { ok: false, code: 'event_not_found' };
    if (!(event.going || []).length) return { ok: false, code: 'nobody_going' };
    const date = new Date(event.startsAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const result = await VoiceService.saveSquad(guild, {
        id: event.squadId || undefined,
        name: `${event.title} · ${date}`.slice(0, 100),
        memberIds: event.going
    }, actor, 'panel');
    // The saved squad was deleted meanwhile: make a new one
    const saved = result.code === 'squad_not_found'
        ? await VoiceService.saveSquad(guild, { name: `${event.title} · ${date}`.slice(0, 100), memberIds: event.going }, actor, 'panel')
        : result;
    if (!saved.ok) return saved;
    if (event.squadId !== saved.squad.id) {
        event.squadId = saved.squad.id;
        await EventService.save(event);
    }
    return { ok: true, event, squad: saved.squad };
}

// POST /meetups/:id/squad — those going become a squad on the voice board
router.post('/:eventId/squad', handle(async (req, actor) => {
    const result = await squadFromEvent(req.guild, req.params.eventId, actor);
    return result.ok ? { ok: true, event: result.event, squadId: result.squad.id } : result;
}));

// POST /meetups/:id/gather — { channelId? }: move those going into the event's voice channel, DM the rest
router.post('/:eventId/gather', async (req, res, next) => {
    try {
        const actor = actorOf(req);
        const made = await squadFromEvent(req.guild, req.params.eventId, actor);
        if (!made.ok) return sendResult(res, made, STATUS);
        const channelId = String(req.body?.channelId || made.event.voiceChannelId || '');
        const result = await VoiceService.gatherSquad(req.guild, made.squad.id, channelId, actor, 'panel');
        sendResult(res, result, STATUS);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
