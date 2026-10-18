const cron = require('node-cron');
const { MessageFlags } = require('discord.js');
const EventService = require('./EventService');
const { buildEventMessage } = require('./card');

// «Иду» / «Не иду» under an event card: event:join|leave:<eventId>
async function handleInteraction(interaction) {
    const [, action, eventId] = String(interaction.customId).split(':');
    if (!interaction.isButton() || !interaction.guild || !['join', 'leave'].includes(action) || !eventId) return;

    const result = await EventService.setGoing(interaction.guild.id, eventId, interaction.user.id, action === 'join');
    if (!result.ok) {
        // A closed event: refresh the card so the buttons disappear
        if (result.event) await interaction.update(buildEventMessage(result.event)).catch(() => {});
        const text = result.code === 'event_closed' ? 'Запись на этот ивент уже закрыта.' : 'Этого ивента больше нет.';
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.update(buildEventMessage(result.event));
    const text = action === 'join'
        ? (result.changed ? 'Вы записаны. Напомню за 15 минут до начала.' : 'Вы уже записаны.')
        : (result.changed ? 'Запись отменена.' : 'Вы и не были записаны.');
    await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
}

module.exports = {
    name: 'events',
    interactionPrefix: 'event',
    handleInteraction,

    register() {},

    async onReady(client) {
        const tick = async () => {
            try {
                await EventService.processDue(client);
            } catch (error) {
                console.error('Events: due check failed:', error.message || error);
            }
        };
        await tick();
        cron.schedule('* * * * *', tick);
    }
};
