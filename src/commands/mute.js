const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const ModerationService = require('../modules/moderation/ModerationService');
const { MUTE_DURATIONS } = require('../modules/moderation/templates');
const { describeError, autocompleteReason, actorOf } = require('../modules/moderation/commandText');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Выдать мут (тайм-аут); человеку придёт сообщение с причиной')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option.setName('участник').setDescription('Кому').setRequired(true))
        .addStringOption(option => option
            .setName('срок')
            .setDescription('На сколько')
            .setRequired(true)
            .addChoices(...Object.entries(MUTE_DURATIONS).map(([value, { label }]) => ({ name: label, value }))))
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
        const duration = interaction.options.getString('срок');
        const reason = interaction.options.getString('причина');
        const result = await ModerationService.mute(interaction.guild, user.id, duration, reason, actorOf(interaction), 'discord');

        await interaction.editReply({
            content: result.ok
                ? `Мут для <@${user.id}> на ${MUTE_DURATIONS[duration].label}: ${reason}.`
                : describeError(result),
            allowedMentions: { parse: [] }
        });
    }
};
