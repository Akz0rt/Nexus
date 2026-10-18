const { MessageFlags } = require('discord.js');
const ReportService = require('./ReportService');

const SNOWFLAKE_RE = /^\d{17,20}$/;

const REPLY_TEXT = {
    reason_required: 'Напишите, что не так с сообщением.',
    self: 'На своё сообщение пожаловаться нельзя.',
    target_bot: 'На сообщения ботов не жалуются — напишите модераторам.',
    duplicate: 'Вы уже пожаловались на это сообщение. Модераторы его посмотрят.',
    rate_limited: `Слишком много жалоб подряд: не больше ${ReportService.HOURLY_LIMIT} в час. Попробуйте позже.`,
    message_not_found: 'Сообщение уже удалено.'
};

// Modal from the «Пожаловаться» context menu: report:modal:<channelId>:<messageId>
async function handleInteraction(interaction) {
    const [, action, channelId, messageId] = String(interaction.customId).split(':');
    if (!interaction.isModalSubmit() || action !== 'modal' || !interaction.guild) return;
    if (!SNOWFLAKE_RE.test(channelId || '') || !SNOWFLAKE_RE.test(messageId || '')) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.guild.channels.cache.get(channelId);
    const message = await channel?.messages?.fetch(messageId).catch(() => null);
    const result = message
        ? await ReportService.create(message, interaction.user, interaction.fields.getTextInputValue('reason'))
        : { ok: false, code: 'message_not_found' };

    await interaction.editReply(result.ok
        ? 'Жалоба отправлена модераторам. Спасибо! Автор сообщения о ней не узнает.'
        : (REPLY_TEXT[result.code] || 'Не удалось отправить жалобу.'));
}

module.exports = {
    name: 'reports',
    interactionPrefix: 'report',
    handleInteraction,
    register() {}
};
