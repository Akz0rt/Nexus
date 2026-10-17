/** Texts for /move and /voice replies. */

const ERROR_TEXT = {
    forbidden: 'У тебя нет прав на это действие.',
    bot_missing_permission: 'Боту не хватает прав: нужны «Перемещать участников», «Отключать участникам микрофон» и «Отключать участникам звук».',
    channel_not_found: 'Голосовой канал не найден.',
    channel_forbidden: 'У тебя нет доступа к этому каналу.',
    bot_cannot_channel: 'У бота нет доступа к этому каналу.',
    nobody: 'Некого трогать: в канале никого нет или всё уже сделано.',
    invalid_targets: 'Некого перемещать.',
    need_two_channels: 'Для команд нужно хотя бы два канала.',
    not_enough_channels: 'В этой категории не хватает пустых голосовых каналов. Укажи каналы вручную.',
    not_in_voice: 'Зайди в голосовой канал или укажи, откуда переносить.',
    squad_not_found: 'Такого состава нет.',
    nothing_to_gather: 'Нечего собирать: не знаю, куда разошлись команды. Перенеси их через /move.'
};

/** Why one member was skipped, after their name. */
const FAILURE_TEXT = {
    not_in_voice: 'не в голосе',
    target_higher: 'роль не ниже твоей',
    target_protected: 'владелец сервера',
    member_not_found: 'нет на сервере',
    bot_cannot: 'боту не хватает прав',
    dm_closed: 'закрыты личные сообщения',
    failed: 'ошибка Discord'
};

function describeError(result) {
    return ERROR_TEXT[result.code] || 'Не удалось выполнить действие.';
}

/** "Перемещено 7 из 8. Не вышло: Bob — не в голосе." */
function describeBulk(result, verb) {
    const total = result.done.length + result.failed.length;
    const lines = [`${verb} ${result.done.length} из ${total}.`];
    const byCode = new Map();
    for (const failure of result.failed) {
        if (!byCode.has(failure.code)) byCode.set(failure.code, []);
        byCode.get(failure.code).push(failure.name || failure.userId);
    }
    for (const [code, names] of byCode) {
        const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` и ещё ${names.length - 3}` : '');
        lines.push(`Не вышло: ${shown} — ${FAILURE_TEXT[code] || code}.`);
    }
    return lines.join('\n');
}

module.exports = { ERROR_TEXT, describeError, describeBulk };
