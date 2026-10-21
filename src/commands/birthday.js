const { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const CosmosDBService = require('../services/CosmosDBService');
const GuildSettingsService = require('../services/GuildSettingsService');
const { formatDate, getDaysUntilBirthday } = require('../utils/dateUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday')
        .setDescription("Check a user's birthday")
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => 
            option
                .setName('user')
                .setDescription('The user to check birthday for')
                .setRequired(true)),

    async execute(interaction) {
        try {
            const targetUser = interaction.options.getUser('user');
            // This server's list only: a date set on another server isn't shown here
            const birthday = await CosmosDBService.getBirthday(interaction.guildId, targetUser.id);

            if (!birthday) {
                return await interaction.reply({
                    content: `${targetUser.username} has not set their birthday yet.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const date = new Date(2000, birthday.month - 1, birthday.day);
            const formattedDate = formatDate(date);
            const daysUntil = getDaysUntilBirthday(birthday.month, birthday.day);
            const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            const displayName = member?.displayName || targetUser.username;
            
            // Determine pronoun based on this server's roles
            const { maleRoleId, femaleRoleId } = await GuildSettingsService.get(interaction.guildId);
            let pronoun = "their"; // default pronoun
            if (maleRoleId && member?.roles.cache.has(maleRoleId)) {
                pronoun = "his";
            } else if (femaleRoleId && member?.roles.cache.has(femaleRoleId)) {
                pronoun = "her";
            }

            const embed = new EmbedBuilder()
                .setColor('#FF69B4')
                .setTitle(` ${displayName}'s Birthday`)
                .setThumbnail(targetUser.displayAvatarURL())
                .addFields({ 
                    name: 'Birthday', 
                    value: formattedDate, 
                    inline: true 
                });

            if (daysUntil === 0) {
                embed.addFields({
                    name: 'Status',
                    value: ` Today is ${pronoun} birthday!`,
                    inline: true
                });
            } else if (daysUntil === 1) {
                embed.addFields({
                    name: 'Coming Up',
                    value: ` ${displayName}'s birthday is tomorrow!`,
                    inline: true
                });
            } else {
                embed.addFields({
                    name: 'Days Until',
                    value: ` ${daysUntil} days until ${pronoun} birthday`,
                    inline: true
                });
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in birthday command:', error);
            await interaction.reply({
                content: 'There was an error fetching the birthday information!',
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
