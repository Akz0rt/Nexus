const config = require('../../config');
const GuildSettingsService = require('../../services/GuildSettingsService');
const SchedulerService = require('../../services/SchedulerService');
const NotificationService = require('../../services/NotificationService');

async function fetchChannelById(client, channelId, label) {
    if (!channelId) {
        console.warn(`${label} is not set`);
        return null;
    }

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased?.()) {
            console.warn(`${label} (${channelId}) is not a text channel`);
            return null;
        }
        return channel;
    } catch (error) {
        console.error(`Failed to fetch channel for ${label} (${channelId}):`, error.message || error);
        return null;
    }
}

/**
 * Birthdays are one list for the bot: they belong to the main server — GUILD_ID, or
 * without it the lowest server id (the same one after every restart, joins and leaves aside)
 */
function birthdayGuildId(client) {
    if (config.guildId) return config.guildId;
    const ids = [...(client?.guilds?.cache.keys() || [])];
    return ids.length ? ids.reduce((low, id) => (BigInt(id) < BigInt(low) ? id : low)) : null;
}

/**
 * Time and channels from Settings → «Дни рождения» (Azure variables until saved there).
 * Called at startup and again after Settings are saved — no restart needed.
 */
async function applySettings(client, { initialCheck = false } = {}) {
    const guildId = birthdayGuildId(client);
    const settings = guildId ? await GuildSettingsService.get(guildId) : {};
    // Fetch channels directly from API to avoid cache-miss on startup
    const announceChannel = await fetchChannelById(client, settings.birthdayAnnounceChannelId, 'Birthday announce channel');
    const congratsChannel = await fetchChannelById(client, settings.birthdayCongratsChannelId, 'Birthday congrats channel');
    NotificationService.setChannels(announceChannel, congratsChannel);

    if (announceChannel || congratsChannel) {
        console.log('Notification channels configured successfully');
    } else {
        console.error('No notification channels found. Birthday checks will still run, but messages cannot be sent.');
    }

    // Always schedule so daily DB checks are not skipped
    SchedulerService.start({ checkTime: settings.birthdayCheckTime || config.checkTime, initialCheck });
}

module.exports = {
    name: 'birthdays',
    birthdayGuildId,
    applySettings,

    register() {},

    async onReady(client) {
        await applySettings(client, { initialCheck: true });
    }
};
