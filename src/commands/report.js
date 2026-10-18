const {
    ActionRowBuilder, ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

// Right-click a message → Apps → «Пожаловаться». The modal is handled by the reports module.
module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Пожаловаться')
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const message = interaction.targetMessage;
        await interaction.showModal(new ModalBuilder()
            .setCustomId(`report:modal:${message.channelId}:${message.id}`)
            .setTitle('Жалоба модераторам')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Что не так с этим сообщением?')
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(400)
                    .setRequired(true)
            )));
    }
};
