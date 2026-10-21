const { SlashCommandBuilder, EmbedBuilder, InteractionContextType } = require('discord.js');
const CosmosDBService = require('../services/CosmosDBService');
const { formatDate, getDaysUntilBirthday } = require('../utils/dateUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthdays-coming')
        .setDescription('List birthdays coming up in the next 7 days')
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        try {
            const birthdays = await CosmosDBService.getAllBirthdays(interaction.guildId);
            const birthdayList = Object.entries(birthdays);
            
            // Filter birthdays within next 7 days
            const upcomingBirthdays = birthdayList
                .map(([userId, data]) => ({
                    userId,
                    ...data,
                    daysUntil: getDaysUntilBirthday(data.month, data.day)
                }))
                .filter(birthday => birthday.daysUntil <= 7)
                .sort((a, b) => a.daysUntil - b.daysUntil);

            if (upcomingBirthdays.length === 0) {
                return await interaction.reply('No birthdays coming up in the next 7 days! 🎂');
            }

            const embed = new EmbedBuilder()
                .setColor('#FF69B4')
                .setTitle('🎂 Upcoming Birthdays')
                .setDescription('Birthdays in the next 7 days:');

            for (const birthday of upcomingBirthdays) {
                const date = new Date(2000, birthday.month - 1, birthday.day);
                const formattedDate = formatDate(date);
                // Someone who left the server is skipped instead of failing the whole list
                const member = await interaction.guild.members.fetch(birthday.userId).catch(() => null);
                if (!member) continue;
                const displayName = member.displayName || member.user.username;
                
                let description = `${formattedDate}`;
                if (birthday.daysUntil === 0) {
                    description += ' (Today! 🎉)';
                } else if (birthday.daysUntil === 1) {
                    description += ' (Tomorrow! 🎈)';
                } else {
                    description += ` (in ${birthday.daysUntil} days)`;
                }

                embed.addFields({
                    name: `${displayName}`,
                    value: `<@${birthday.userId}> - ${description}`
                });
            }

            if (!embed.data.fields?.length) {
                return await interaction.reply('No birthdays coming up in the next 7 days! 🎂');
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in birthdays command:', error);
            await interaction.reply('There was an error fetching the birthdays!');
        }
    },
};