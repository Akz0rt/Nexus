const cron = require('node-cron');
const config = require('../../config');
const ActivityService = require('../../services/ActivityService');
const ActivitySyncService = require('../../services/ActivitySyncService');
const state = require('../../state');

module.exports = {
    name: 'activity',

    // Voice time is counted every minute by the economy module (same rules as the exp)
    register() {},

    async onReady() {
        // Run activity sync immediately after startup
        if (state.guild) {
            try {
                const startupSync = await ActivitySyncService.run(state.guild, 'startup');
                console.log('Activity sync (startup):', startupSync);
            } catch (err) {
                console.error('Activity startup sync error:', err.message || err);
            }
        }

        // Periodic activity sync from Discord message history
        const interval = Math.max(1, Math.min(59, config.activitySyncIntervalMinutes || 5));
        cron.schedule(`*/${interval} * * * *`, async () => {
            if (!state.guild) return;
            try {
                const periodicSync = await ActivitySyncService.run(state.guild, 'scheduled');
                if (!periodicSync.skipped) {
                    console.log('Activity sync (scheduled):', periodicSync);
                }
            } catch (err) {
                console.error('Activity scheduled sync error:', err.message || err);
            }
        });

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
