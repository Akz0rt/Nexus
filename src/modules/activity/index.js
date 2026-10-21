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

const LEGACY_TARGET_MARKER = 'legacy-activity-target';

/**
 * The server the old, unassigned counts came from: the only one the channel sync records
 * named before every server was synced, if that is GUILD_ID (or GUILD_ID is unset).
 * Remembered the first time, so a retry after later syncs still knows it. Never guessed.
 */
async function legacyTarget() {
    const remembered = await SyncMetadataService.getMarker(LEGACY_TARGET_MARKER);
    if (remembered) return remembered.guildId || null;
    const sources = [...new Set(await SyncMetadataService.listSyncedGuildIds())];
    const target = sources.length === 1 && (!config.guildId || sources[0] === config.guildId) ? sources[0] : null;
    if (!target) console.warn(`Activity: old counts came from ${sources.join(', ') || 'no server'}, GUILD_ID ${config.guildId || 'not set'} — not assigned`);
    await SyncMetadataService.setMarker(LEGACY_TARGET_MARKER, { guildId: target, sources, at: new Date().toISOString() });
    return target;
}

module.exports = {
    name: 'activity',
    legacyTarget,

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
            await ActivityService.migrateLegacy(await legacyTarget());
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
