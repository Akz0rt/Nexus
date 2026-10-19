const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const SHOWN_GOING = 30;
const COLORS = { scheduled: 0xffb020, done: 0x2ec4ff, cancelled: 0x5a6472 };
const NOTES = { done: 'Ивент начался — запись закрыта.', cancelled: 'Ивент отменён.' };

function stamp(iso, style) {
    return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/** The event card in Discord: embed + «Иду» / «Не иду» while sign-up is open. */
function buildEventMessage(event) {
    const going = event.going || [];
    const shown = going.slice(0, SHOWN_GOING).map(id => `<@${id}>`).join(', ');
    const embed = new EmbedBuilder()
        .setColor(COLORS[event.status] || COLORS.scheduled)
        .setTitle(event.status === 'cancelled' ? `~~${event.title}~~` : event.title)
        .addFields({ name: 'Когда', value: `${stamp(event.startsAt, 'F')}${event.durationMinutes ? `–${stamp(event.endsAt, 't')}` : ''} · ${stamp(event.startsAt, 'R')}` });
    if (event.description) embed.setDescription(event.description);
    if (event.voiceChannelId) embed.addFields({ name: 'Где', value: `<#${event.voiceChannelId}>`, inline: true });
    if (event.repeatWeekly) embed.addFields({ name: 'Повтор', value: 'каждую неделю', inline: true });
    embed.addFields({
        name: `Идут · ${going.length}`,
        value: going.length ? shown + (going.length > SHOWN_GOING ? ` и ещё ${going.length - SHOWN_GOING}` : '') : 'пока никого'
    });
    if (NOTES[event.status]) embed.setFooter({ text: NOTES[event.status] });

    const components = event.status === 'scheduled'
        ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`event:join:${event.id}`).setLabel('Иду').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`event:leave:${event.id}`).setLabel('Не иду').setStyle(ButtonStyle.Secondary)
        )]
        : [];
    // Mentions inside the embed never ping
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

module.exports = { buildEventMessage, stamp };
