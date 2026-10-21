const cron = require('node-cron');
const GuildSettingsService = require('../../services/GuildSettingsService');

/**
 * The server banner: every minute each server with the banner on is checked; the
 * publisher itself waits out the chosen interval and skips when nothing changed.
 */
async function tick(client) {
    const { publisher } = require('../../banner/publisher');
    for (const guild of client.guilds.cache.values()) {
        try {
            const { banner } = await GuildSettingsService.get(guild.id);
            if (!banner.enabled) continue;
            const result = await publisher.publish(guild);
            if (result.ok) console.log(`Banner: published on ${guild.id} (${result.entry.mode}${result.downgraded ? `, still: ${result.downgraded}` : ''})`);
            else if (!result.skipped) console.warn(`Banner: not published on ${guild.id}: ${result.code} — ${result.message}`);
        } catch (error) {
            console.error(`Banner: check of ${guild.id} failed:`, error.message || error);
        }
    }
}

module.exports = {
    name: 'banner',
    tick,

    register() {},

    async onReady(client) {
        let busy = false;
        cron.schedule('* * * * *', async () => {
            // A long GIF build must not stack up minute after minute
            if (busy) return;
            busy = true;
            try {
                await tick(client);
            } finally {
                busy = false;
            }
        });
    }
};
