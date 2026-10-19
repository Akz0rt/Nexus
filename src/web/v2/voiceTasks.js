const VoiceService = require('../../modules/voice/VoiceService');

/**
 * Background-task specs (TaskService) for the voice board's group actions:
 * what to run, how «Отменить всё» undoes it and how «Повторить для неудачных» retries.
 */

const channelName = (guild, id) => guild.channels.cache.get(id)?.name || 'канал';

/** Send everyone moved by a finished task back where they came from. */
function moveBack(guild, task, actor) {
    const moves = (task.result?.moves || []).filter(move => task.done.includes(move.userId) && move.from);
    if (moves.length === 0) return null;
    return movesSpec(guild, moves.map(move => ({ userId: move.userId, channelId: move.from })), actor, { kind: 'undo', title: 'Возврат на места' });
}

/** Each member into their own channel (undo, split). */
function movesSpec(guild, moves, actor, { kind = 'move', title, details = {} } = {}) {
    return {
        guildId: guild.id,
        kind: 'voice.move',
        title: title || 'Перенос',
        actorId: actor.id,
        exec: hooks => VoiceService.moveEach(guild, moves, actor, 'panel', { kind, details, hooks }),
        revert: kind === 'undo' ? null : (task, who) => moveBack(guild, task, who),
        retry: (ids, who) => movesSpec(guild, moves.filter(move => ids.includes(move.userId)), who, { kind, title, details })
    };
}

/** Everyone in `userIds` into one channel. */
function moveSpec(guild, userIds, channelId, actor) {
    return {
        guildId: guild.id,
        kind: 'voice.move',
        title: `Перенос в «${channelName(guild, channelId)}»`,
        actorId: actor.id,
        exec: hooks => VoiceService.move(guild, userIds, channelId, actor, 'panel', { hooks }),
        revert: (task, who) => moveBack(guild, task, who),
        retry: (ids, who) => moveSpec(guild, ids, channelId, who)
    };
}

function gatherSpec(guild, channelId, fromChannelIds, actor) {
    return {
        guildId: guild.id,
        kind: 'voice.move',
        title: `Сбор в «${channelName(guild, channelId)}»`,
        actorId: actor.id,
        exec: hooks => VoiceService.gather(guild, channelId, fromChannelIds, actor, 'panel', { hooks }),
        revert: (task, who) => moveBack(guild, task, who),
        retry: (ids, who) => moveSpec(guild, ids, channelId, who)
    };
}

function squadGatherSpec(guild, squadId, channelId, actor) {
    return {
        guildId: guild.id,
        kind: 'voice.move',
        title: `Сбор состава в «${channelName(guild, channelId)}»`,
        actorId: actor.id,
        exec: hooks => VoiceService.gatherSquad(guild, squadId, channelId, actor, 'panel', { hooks }),
        note: result => (result.invited?.length ? `в ЛС позвали ${result.invited.length} — их не было в голосе` : null),
        revert: (task, who) => moveBack(guild, task, who),
        // Closed DMs (not in voice, invite failed) are nothing to retry with a move
        retry: (ids, who, task) => {
            const movable = ids.filter(id => !task.failed.some(f => f.userId === id && f.code === 'dm_closed'));
            return movable.length ? moveSpec(guild, movable, channelId, who) : null;
        }
    };
}

// What a member action is called, and which action undoes it (disconnect can't be undone)
const ACTIONS = {
    mute: { title: 'Выключаем микро', undo: 'unmute' },
    unmute: { title: 'Включаем микро', undo: 'mute' },
    deafen: { title: 'Глушим звук', undo: 'undeafen' },
    undeafen: { title: 'Возвращаем звук', undo: 'deafen' },
    disconnect: { title: 'Отключаем от голоса', undo: null }
};

function actionSpec(guild, action, userIds, actor, { title } = {}) {
    const meta = ACTIONS[action] || { title: action, undo: null };
    return {
        guildId: guild.id,
        kind: `voice.${action}`,
        title: title || meta.title,
        actorId: actor.id,
        exec: hooks => VoiceService.apply(guild, action, userIds, actor, 'panel', { hooks }),
        revert: meta.undo ? (task, who) => actionSpec(guild, meta.undo, task.done, who) : null,
        retry: (ids, who) => actionSpec(guild, action, ids, who, { title })
    };
}

function muteChannelSpec(guild, channelId, on, exceptIds, actor) {
    const name = channelName(guild, channelId);
    return {
        guildId: guild.id,
        kind: on ? 'voice.mute' : 'voice.unmute',
        title: on ? `Мут всех в «${name}»` : `Размут всех в «${name}»`,
        actorId: actor.id,
        exec: hooks => VoiceService.muteChannel(guild, channelId, on, actor, 'panel', { exceptIds, hooks }),
        revert: (task, who) => actionSpec(guild, on ? 'unmute' : 'mute', task.done, who),
        retry: (ids, who) => actionSpec(guild, on ? 'mute' : 'unmute', ids, who)
    };
}

module.exports = { moveSpec, movesSpec, gatherSpec, squadGatherSpec, actionSpec, muteChannelSpec, ACTIONS };
