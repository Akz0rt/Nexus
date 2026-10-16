const GuildSettingsService = require('../../services/GuildSettingsService');
const { formatDuration } = require('./templates');

/** Texts for failed moderation results (shared by slash commands and buttons). */
const ERROR_TEXT = {
    reason_required: 'Укажи причину.',
    forbidden: 'У тебя нет прав на это действие.',
    member_not_found: 'Этого человека нет на сервере.',
    user_not_found: 'Пользователь с таким ID не найден.',
    self: 'Себя наказать нельзя.',
    target_protected: 'Владельца сервера и ботов наказывать нельзя.',
    target_higher: 'Его высшая роль не ниже твоей — это может сделать только старший.',
    bot_cannot: 'У бота не хватает прав или его роль ниже роли этого человека.',
    not_muted: 'У него нет мута.',
    not_banned: 'Он не забанен.',
    already_banned: 'Он уже забанен.',
    invalid_duration: 'Неизвестный срок.',
    warning_not_found: 'Варн уже снят или сгорел.'
};

function describeError(result) {
    return ERROR_TEXT[result.code] || 'Не удалось выполнить действие.';
}

function describeEscalation(escalation) {
    if (!escalation) return '';
    if (escalation.action === 'timeout') {
        return escalation.ok
            ? `\nАвтоматически: мут на ${formatDuration(escalation.durationMs)}.`
            : '\nАвтоматический мут не выдан: у человека уже мут дольше или боту не хватает прав.';
    }
    if (escalation.action === 'propose_ban') {
        return escalation.ok
            ? '\nВ канал модераторов ушло предложение забанить.'
            : '\nНе удалось отправить предложение бана в канал модераторов.';
    }
    return '';
}

/** Autocomplete for the "reason" option: templates matching what's typed, plus the typed text. */
async function autocompleteReason(interaction) {
    const typed = String(interaction.options.getFocused() || '').trim();
    const settings = await GuildSettingsService.get(interaction.guildId);
    const needle = typed.toLowerCase();
    const choices = settings.moderation.reasons
        .filter(reason => !needle || reason.toLowerCase().includes(needle))
        .map(reason => ({ name: reason, value: reason }));
    if (typed && !choices.some(choice => choice.value.toLowerCase() === needle)) {
        choices.unshift({ name: typed.slice(0, 100), value: typed.slice(0, 100) });
    }
    await interaction.respond(choices.slice(0, 25));
}

function actorOf(interaction) {
    return { id: interaction.user.id, tag: interaction.user.tag };
}

module.exports = { ERROR_TEXT, describeError, describeEscalation, autocompleteReason, actorOf };
