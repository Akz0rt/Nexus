const { InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const GuildSettingsService = require('../services/GuildSettingsService');
const games = require('../modules/economy/games');
const { describe, number } = require('../modules/economy/messages');

const SIDES = { heads: 'Орёл', tails: 'Решка' };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Орёл или решка против бота: выигрыш — 95% ставки')
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption(option => option.setName('ставка').setDescription(`От ${games.MIN_BET} до ${number(games.MAX_BET)}`)
            .setRequired(true).setMinValue(games.MIN_BET).setMaxValue(games.MAX_BET))
        .addStringOption(option => option.setName('сторона').setDescription('На что ставите').setRequired(true)
            .addChoices({ name: 'Орёл', value: 'heads' }, { name: 'Решка', value: 'tails' })),

    async execute(interaction) {
        if (!(await GuildSettingsService.get(interaction.guildId)).economy.gamesEnabled) {
            await interaction.reply({ content: 'Игры на этом сервере выключены.', flags: MessageFlags.Ephemeral });
            return;
        }
        const bet = interaction.options.getInteger('ставка');
        const side = interaction.options.getString('сторона');
        const result = await games.coinflip(interaction.guildId, interaction.member, bet, side);
        if (!result.ok) {
            await interaction.reply({ content: describe(result), flags: MessageFlags.Ephemeral });
            return;
        }
        const outcome = result.won
            ? `выиграл **${number(result.amount)}**`
            : `проиграл **${number(-result.amount)}**`;
        await interaction.reply({
            content: `🪙 ${SIDES[result.landed]}! <@${interaction.user.id}> ${outcome} · баланс ${number(result.balance)}`,
            allowedMentions: { parse: [] }
        });
    }
};
