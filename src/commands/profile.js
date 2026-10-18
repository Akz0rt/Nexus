const { EmbedBuilder, InteractionContextType, SlashCommandBuilder } = require('discord.js');
const EconomyService = require('../modules/economy/EconomyService');
const curve = require('../modules/economy/curve');

const BAR_CELLS = 12;

function progressBar(exp, cost) {
    const filled = Math.min(BAR_CELLS, Math.floor((exp / cost) * BAR_CELLS));
    return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)}`;
}

const number = n => Number(n || 0).toLocaleString('ru-RU');

function formatHours(seconds) {
    return `${number(Math.floor((seconds || 0) / 3600))} ч`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Уровень и баланс')
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Чей профиль (по умолчанию ваш)')),

    async execute(interaction) {
        await interaction.deferReply();
        const user = interaction.options.getUser('участник') || interaction.user;
        const member = interaction.options.getMember('участник') || (user.id === interaction.user.id ? interaction.member : null);
        const account = await EconomyService.get(interaction.guildId, user.id);
        const name = member?.displayName || user.globalName || user.username;
        if (!account) {
            await interaction.editReply({ content: `У ${name} пока нет опыта и монет.`, allowedMentions: { parse: [] } });
            return;
        }

        const cost = curve.levelCost(account.level);
        const top = account.level >= curve.MAX_LEVEL;
        const levelText = account.prestige ? `**${account.level}** ★${account.prestige}` : `**${account.level}**`;
        const [levelRank, moneyRank] = await Promise.all([
            EconomyService.rank(interaction.guildId, account, 'level'),
            EconomyService.rank(interaction.guildId, account, 'money')
        ]);
        const embed = new EmbedBuilder()
            .setColor(0x2ec4ff)
            .setAuthor({ name, iconURL: user.displayAvatarURL({ size: 64 }) })
            .addFields(
                { name: 'Уровень', value: `${levelText} · ${levelRank}-е место`, inline: true },
                { name: 'Баланс', value: `**${number(account.money)}** монет · ${moneyRank}-е место`, inline: true },
                { name: top ? `До престижа ★${(account.prestige || 0) + 1}` : `До ${account.level + 1} уровня`, value: `${progressBar(account.exp, cost)} ${number(account.exp)} / ${number(cost)}` },
                { name: 'В голосе', value: formatHours(account.voiceSeconds), inline: true },
                { name: 'Сообщений', value: number(account.messages), inline: true }
            );
        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
};
