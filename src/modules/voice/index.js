const { ChannelType, Events } = require('discord.js');
const EventBus = require('../../services/EventBus');
const VoiceService = require('./VoiceService');
const { isVoice } = require('./VoiceService');

/**
 * Voice board: keeps "in channel since" and tells open panel apps that the
 * board changed (they refetch it). The actions live in VoiceService.
 */
module.exports = {
    name: 'voice',

    register(client) {
        client.on(Events.VoiceStateUpdate, (oldState, newState) => {
            const guildId = newState.guild?.id || oldState.guild?.id;
            const userId = newState.id || oldState.id;
            if (!guildId || !userId) return;
            if (oldState.channelId !== newState.channelId) VoiceService.noteChannel(guildId, userId, newState.channelId);
            EventBus.emit('voice', { guildId, userId, channelId: newState.channelId || null });
        });

        // Channels appearing, disappearing, renamed, locked or moved between categories
        const onChannel = channel => {
            if (channel.guild && (isVoice(channel) || channel.type === ChannelType.GuildCategory)) {
                EventBus.emit('voice', { guildId: channel.guild.id, channels: true });
            }
        };
        client.on(Events.ChannelCreate, onChannel);
        client.on(Events.ChannelDelete, onChannel);
        client.on(Events.ChannelUpdate, (oldChannel, newChannel) => onChannel(newChannel));
    }
};
