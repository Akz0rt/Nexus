const { ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const GuildSettingsService = require('../services/GuildSettingsService');
const games = require('../modules/economy/games');
const { describe, number } = require('../modules/economy/messages');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('duel')
        .setDescription('Вызвать на дуэль: победитель забирает 95% ставки')
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Кого вызываете').setRequired(true))
        .addIntegerOption(option => option.setName('ставка').setDescription(`От ${games.MIN_BET} до ${number(games.MAX_BET)}`)
            .setRequired(true).setMinValue(games.MIN_BET).setMaxValue(games.MAX_BET)),

    async execute(interaction) {
        if (!(await GuildSettingsService.get(interaction.guildId)).economy.gamesEnabled) {
            await interaction.reply({ content: 'Игры на этом сервере выключены.', flags: MessageFlags.Ephemeral });
            return;
        }
        const opponent = interaction.options.getMember('участник');
        if (!opponent) {
            await interaction.reply({ content: 'Этого человека нет на сервере.', flags: MessageFlags.Ephemeral });
            return;
        }
        const bet = interaction.options.getInteger('ставка');
        const result = await games.challenge(interaction.guildId, interaction.member, opponent, bet);
        if (!result.ok) {
            await interaction.reply({ content: describe(result), flags: MessageFlags.Ephemeral });
            return;
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`eco:duel:yes:${result.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`eco:duel:no:${result.id}`).setLabel('Отказаться').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
            content: `⚔️ <@${interaction.user.id}> вызывает <@${opponent.id}> на дуэль! Ставка **${number(bet)}** монет, победителю — ${number(games.winnings(bet))}.\nВызов действует до <t:${Math.floor(result.expiresAt / 1000)}:T>.`,
            components: [row],
            allowedMentions: { users: [opponent.id] }
        });
    }
};
