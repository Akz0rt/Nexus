const { Events } = require('discord.js');
const config = require('../../config');
const CosmosDBService = require('../../services/CosmosDBService');
const GuildSettingsService = require('../../services/GuildSettingsService');
const SchedulerService = require('../../services/SchedulerService');

/**
 * Time and timezone from Settings (Azure variables on the main server until saved there).
 * Called at startup, when the bot joins a server and after Settings are saved — no restart needed.
 */
async function applySettings(guild, { initialCheck = false } = {}) {
    const settings = await GuildSettingsService.get(guild.id);
    // Always schedule so daily DB checks are not skipped; a server without channels just has nobody to post to
    SchedulerService.start(guild, { checkTime: settings.birthdayCheckTime, timezone: settings.timezone, initialCheck });
}

/**
 * The old list was shared by the whole bot; it is copied once to GUILD_ID. Without
 * GUILD_ID it isn't guessed while the bot is on several servers (Diagnostics says so).
 */
async function migrateLegacy(client) {
    const target = config.guildId || (client.guilds.cache.size === 1 ? client.guilds.cache.firstKey() : null);
    if (!target || !client.guilds.cache.has(target)) {
        console.warn('Birthdays: old shared list not copied — set GUILD_ID to the server it belongs to');
        return;
    }
    await CosmosDBService.migrateLegacy(target).catch(error =>
        console.error('Birthdays: copying the old list failed (will retry on next start):', error.message || error));
}

module.exports = {
    name: 'birthdays',
    applySettings,

    register(client) {
        client.on(Events.GuildCreate, guild => {
            applySettings(guild, { initialCheck: true }).catch(error =>
                console.error(`Birthdays: scheduling ${guild.id} failed:`, error.message || error));
        });
        client.on(Events.GuildDelete, guild => SchedulerService.stop(guild.id));
    },

    async onReady(client) {
        await migrateLegacy(client);
        for (const guild of client.guilds.cache.values()) {
            await applySettings(guild, { initialCheck: true }).catch(error =>
                console.error(`Birthdays: scheduling ${guild.id} failed:`, error.message || error));
        }
    }
};
