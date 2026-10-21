const cron = require('node-cron');
const { Events } = require('discord.js');
const config = require('../../config');
const ActivityService = require('../../services/ActivityService');
const ActivitySyncService = require('../../services/ActivitySyncService');
const SyncMetadataService = require('../../services/SyncMetadataService');

/** Every server's message history, one server after another (each counts for itself) */
async function syncAll(client, reason) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const result = await ActivitySyncService.run(guild, reason);
            if (!result.skipped) console.log(`Activity sync (${reason}) ${guild.id}:`, result);
        } catch (err) {
            console.error(`Activity ${reason} sync error in ${guild.id}:`, err.message || err);
        }
    }
}

module.exports = {
    name: 'activity',

    // Voice time is counted every minute by the economy module (same rules as the exp)
    register(client) {
        // A server the bot just joined starts collecting right away
        client.on(Events.GuildCreate, guild => {
            ActivitySyncService.run(guild, 'joined').catch(err =>
                console.error(`Activity sync error in new server ${guild.id}:`, err.message || err));
        });
    },

    async onReady(client) {
        // Counts from before servers were told apart: to the server they were collected from
        try {
            await ActivityService.migrateLegacy(await SyncMetadataService.listSyncedGuildIds(), config.guildId || null);
        } catch (err) {
            console.error('Activity: assigning old records failed (will retry on next start):', err.message || err);
        }

        // Run activity sync immediately after startup
        await syncAll(client, 'startup');

        // Periodic activity sync from Discord message history
        const interval = Math.max(1, Math.min(59, config.activitySyncIntervalMinutes || 5));
        cron.schedule(`*/${interval} * * * *`, () => syncAll(client, 'scheduled'));

        // Clean up old activity data (older than 30 days) — run daily at midnight UTC
        cron.schedule('0 0 * * *', async () => {
            try {
                await ActivityService.cleanupOldData();
            } catch (err) {
                console.error('Activity cleanup error:', err.message);
            }
        });
    }
};
