const { PermissionFlagsBits } = require('discord.js');
const state = require('../../state');

/**
 * Journal entries about messages carry the message text, so a moderator sees
 * them only for channels they can read themselves. Everything else is visible
 * to every panel user. If the channel is gone, only administrators see them.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember|null|undefined} viewer
 */
function canSeeEntry(guild, viewer, entry) {
    if (!String(entry?.action || '').startsWith('message.')) return true;
    if (!viewer) return false;
    const channel = guild.channels.cache.get(entry.details?.channelId);
    if (!channel) return Boolean(viewer.permissions?.has(PermissionFlagsBits.Administrator));
    const permissions = channel.permissionsFor(viewer);
    return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory));
}

/** Same check by ids, for the live stream (looks the guild and member up in the bot's cache). */
function canUserSee(guildId, userId, entry) {
    if (!String(entry?.action || '').startsWith('message.')) return true;
    const guild = state.client?.guilds?.cache.get(guildId);
    if (!guild) return false;
    return canSeeEntry(guild, guild.members.cache.get(userId), entry);
}

module.exports = { canSeeEntry, canUserSee };
