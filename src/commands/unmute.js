const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const ModerationService = require('../modules/moderation/ModerationService');
const { describeError, actorOf } = require('../modules/moderation/commandText');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Снять мут')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('С кого').setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('участник');
        const result = await ModerationService.unmute(interaction.guild, user.id, actorOf(interaction), 'discord');

        await interaction.editReply({
            content: result.ok ? `Мут с <@${user.id}> снят.` : describeError(result),
            allowedMentions: { parse: [] }
        });
    }
};
