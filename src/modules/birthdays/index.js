const config = require('../../config');
const SchedulerService = require('../../services/SchedulerService');
const NotificationService = require('../../services/NotificationService');

async function fetchChannelById(client, channelId, envName) {
    if (!channelId) {
        console.warn(`${envName} is not set`);
        return null;
    }

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased?.()) {
            console.warn(`${envName} (${channelId}) is not a text channel`);
            return null;
        }
        return channel;
    } catch (error) {
        console.error(`Failed to fetch channel for ${envName} (${channelId}):`, error.message || error);
        return null;
    }
}

module.exports = {
    name: 'birthdays',

    register() {},

    async onReady(client) {
        // Fetch channels directly from API to avoid cache-miss on startup
        const announceChannel = await fetchChannelById(client, config.birthdayChannel, 'BIRTHDAY_CHANNEL_ID');
        const congratsChannel = await fetchChannelById(client, config.congratsChannel, 'CONGRATS_CHANNEL_ID');

        NotificationService.setChannels(announceChannel, congratsChannel);

        if (announceChannel || congratsChannel) {
            console.log('Notification channels configured successfully');
        } else {
            console.error('No notification channels found. Birthday checks will still run, but messages cannot be sent.');
        }

        // Always start scheduler so daily DB checks are not skipped
        SchedulerService.start();
    }
};
