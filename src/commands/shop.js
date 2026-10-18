const { InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { buildShop } = require('../modules/economy/shop');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Магазин личных ролей участников')
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(await buildShop(interaction.guild, interaction.user.id));
    }
};
