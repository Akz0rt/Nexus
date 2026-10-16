const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const ModerationService = require('../modules/moderation/ModerationService');
const { describeError, describeEscalation, autocompleteReason, actorOf } = require('../modules/moderation/commandText');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Выдать варн (человек о нём не узнает)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Кому').setRequired(true))
        .addStringOption(option => option
            .setName('причина')
            .setDescription('Шаблон или своя причина')
            .setRequired(true)
            .setMaxLength(400)
            .setAutocomplete(true)),

    autocomplete: autocompleteReason,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('участник');
        const reason = interaction.options.getString('причина');
        const result = await ModerationService.warn(interaction.guild, user.id, reason, actorOf(interaction), 'discord');

        await interaction.editReply({
            content: result.ok
                ? `Варн выдан <@${user.id}>: ${reason}. Активных варнов: ${result.activeCount}.${describeEscalation(result.escalation)}`
                : describeError(result),
            allowedMentions: { parse: [] }
        });
    }
};
