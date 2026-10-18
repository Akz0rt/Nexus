const { EmbedBuilder, InteractionContextType, SlashCommandBuilder } = require('discord.js');
const EconomyService = require('../modules/economy/EconomyService');

const number = n => Number(n || 0).toLocaleString('ru-RU');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('top')
        .setDescription('Топ сервера по уровню или балансу')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(option => option.setName('по').setDescription('Что сравнивать (по умолчанию уровень)')
            .addChoices({ name: 'Уровень', value: 'level' }, { name: 'Баланс', value: 'money' })),

    async execute(interaction) {
        await interaction.deferReply();
        const by = interaction.options.getString('по') === 'money' ? 'money' : 'level';
        const top = await EconomyService.top(interaction.guildId, by, 10);
        if (top.length === 0) {
            await interaction.editReply('Пока никто не набрал ни опыта, ни монет.');
            return;
        }
        const lines = top.map((account, index) => {
            const level = account.prestige ? `${account.level} уровень ★${account.prestige}` : `${account.level} уровень`;
            const value = by === 'money' ? `${number(account.money)} монет` : level;
            return `**${index + 1}.** <@${account.userId}> — ${value}`;
        });
        const embed = new EmbedBuilder()
            .setColor(0xff7a1a)
            .setTitle(by === 'money' ? 'Топ по балансу' : 'Топ по уровню')
            .setDescription(lines.join('\n'));
        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
};
