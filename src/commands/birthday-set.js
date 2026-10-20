const { SlashCommandBuilder } = require('@discordjs/builders');
const { 
    ComponentType, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const CosmosDBService = require('../services/CosmosDBService');
const { isValidDate } = require('../utils/dateUtils');
const NotificationService = require('../services/NotificationService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday-set')
        .setDescription('Указать свой день рождения'),

    async execute(interaction) {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('birthday_datepicker')
                    .setLabel('Указать дату')
                    .setStyle(ButtonStyle.Primary)
            );

        const response = await interaction.reply({
            content: 'Нажмите кнопку, чтобы указать свой день рождения:',
            components: [row],
            flags: ['Ephemeral']
        });

        try {
            const buttonInteraction = await response.awaitMessageComponent({
                componentType: ComponentType.Button,
                time: 60000,
                filter: i => i.user.id === interaction.user.id
            });

            // Create date picker modal
            const modal = new ModalBuilder()
                .setCustomId('birthday_modal')
                .setTitle('Ваш день рождения');

            const dateInput = new TextInputBuilder()
                .setCustomId('birthday_date')
                .setLabel('Дата (ДД/ММ)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Например, 25/12')
                .setRequired(true);

            const actionRow = new ActionRowBuilder().addComponents(dateInput);
            modal.addComponents(actionRow);

            await buttonInteraction.showModal(modal);

            const modalSubmit = await buttonInteraction.awaitModalSubmit({
                time: 60000,
                filter: i => i.user.id === interaction.user.id
            });

            const dateString = modalSubmit.fields.getTextInputValue('birthday_date');
            const [inputDay, inputMonth] = dateString.split('/').map(num => parseInt(num));

            if (!isValidDate(inputMonth, inputDay)) {
                await modalSubmit.reply({
                    content: 'Такой даты нет. Введите её в формате ДД/ММ, например 25/12.',
                    flags: ['Ephemeral']
                });
                return;
            }

            await CosmosDBService.setBirthday(interaction.user.id, inputMonth, inputDay);
            
            // Send confirmation to the user
            await modalSubmit.reply({
                content: `Готово: ваш день рождения — ${String(inputDay).padStart(2, '0')}.${String(inputMonth).padStart(2, '0')} 🎂`,
                flags: ['Ephemeral']
            });

            // Announce it in the channel from Settings → «Дни рождения»
            const birthdayChannel = NotificationService.announceChannel;
            if (birthdayChannel) {
                // Saved already: a channel the bot can't write to only loses the announcement
                await birthdayChannel.send({
                    content: `${interaction.user} указал(а) день рождения — поздравим ${String(inputDay).padStart(2, '0')}.${String(inputMonth).padStart(2, '0')}! 🎉`,
                    allowedMentions: { parse: [] }
                }).catch(error => console.error('birthday-set: announcement failed:', error.message || error));
            }

        } catch (error) {
            if (error.code === 'INTERACTION_COLLECTOR_ERROR') {
                await interaction.followUp({
                    content: 'Время вышло — запустите /birthday-set ещё раз.',
                    flags: ['Ephemeral']
                });
            } else {
                console.error('Error in birthday-set command:', error);
                await interaction.followUp({
                    content: 'Не получилось сохранить день рождения. Попробуйте ещё раз чуть позже.',
                    flags: ['Ephemeral']
                });
            }
        }
    },
};