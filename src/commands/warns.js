const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const WarningService = require('../modules/moderation/WarningService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warns')
        .setDescription('Активные варны участника')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Чьи').setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('участник');
        const warns = await WarningService.listActive(interaction.guildId, user.id);

        if (warns.length === 0) {
            await interaction.editReply({ content: `У <@${user.id}> нет активных варнов.`, allowedMentions: { parse: [] } });
            return;
        }

        const timestamp = iso => `<t:${Math.floor(Date.parse(iso) / 1000)}:d>`;
        const lines = warns.map(warn =>
            `• ${warn.reason} — ${warn.actorId ? `<@${warn.actorId}>` : 'бот'}, ${timestamp(warn.createdAt)}, сгорит ${timestamp(warn.expiresAt)}`);
        await interaction.editReply({
            content: `Активные варны <@${user.id}> (${warns.length}):\n${lines.join('\n')}`.slice(0, 2000),
            allowedMentions: { parse: [] }
        });
    }
};
