const { InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const GuildSettingsService = require('../services/GuildSettingsService');
const games = require('../modules/economy/games');
const { describe, number } = require('../modules/economy/messages');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Перевести монеты другому участнику (без комиссии)')
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Кому').setRequired(true))
        .addIntegerOption(option => option.setName('сумма').setDescription('Сколько монет').setRequired(true).setMinValue(1))
        .addStringOption(option => option.setName('комментарий').setDescription('За что (увидит получатель)').setMaxLength(100)),

    async execute(interaction) {
        if (!(await GuildSettingsService.get(interaction.guildId)).economy.payEnabled) {
            await interaction.reply({ content: 'Переводы на этом сервере выключены.', flags: MessageFlags.Ephemeral });
            return;
        }
        const to = interaction.options.getMember('участник');
        if (!to) {
            await interaction.reply({ content: 'Этого человека нет на сервере.', flags: MessageFlags.Ephemeral });
            return;
        }
        const amount = interaction.options.getInteger('сумма');
        const result = await games.pay(interaction.guildId, interaction.member, to, amount, interaction.options.getString('комментарий'));
        if (!result.ok) {
            await interaction.reply({ content: describe(result), flags: MessageFlags.Ephemeral });
            return;
        }
        const note = interaction.options.getString('комментарий');
        await interaction.reply({
            content: `💸 <@${interaction.user.id}> → <@${to.id}>: **${number(amount)}** монет${note ? ` — ${note}` : ''}`,
            allowedMentions: { users: [to.id] }
        });
    }
};
