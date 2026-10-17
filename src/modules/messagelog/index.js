const { AuditLogEvent, Events, PermissionFlagsBits } = require('discord.js');
const AuditLogService = require('../../services/AuditLogService');

const MAX_TEXT = 2000;
const MAX_ATTACHMENTS = 10;
const MAX_AUTHORS = 50;
// Discord writes its audit-log entry a moment after the delete event
const AUDIT_LOG_DELAY_MS = 1500;
const FRESH_ENTRY_MS = 15 * 1000;
const SEEN_LIMIT = 500;

/**
 * Deleted and edited messages go to the journal. Only messages the bot has seen
 * (discord.js keeps up to 200 per channel for 24 h, see src/index.js) can be
 * logged: older ones, or ones sent before a restart, have no known text.
 */

function clip(text) {
    const value = String(text || '');
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function attachmentNames(message) {
    return [...(message.attachments?.values() || [])].slice(0, MAX_ATTACHMENTS).map(file => file.name || 'файл');
}

function channelDetails(channel) {
    return { channelId: channel?.id || null, channelName: channel?.name || null };
}

/** Messages worth logging: from people, in a server, with text or files. */
function loggable(message) {
    if (!message?.guild || message.partial) return false;
    if (!message.author || message.author.bot || message.system) return false;
    return Boolean(message.content) || (message.attachments?.size || 0) > 0;
}

// Discord merges repeated deletes by one moderator into one audit-log entry and
// bumps its count, so "new entry, or count went up since we last looked" means
// that moderator just deleted something.
const seenCounts = new Map(); // audit entry id -> count

function rememberCount(id, count) {
    if (seenCounts.size >= SEEN_LIMIT) seenCounts.clear();
    seenCounts.set(id, count);
}

/**
 * Who deleted, if it was someone other than the author (needs View Audit Log).
 * @param {(entry) => boolean} matches
 */
async function findDeleter(guild, type, matches) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
    await new Promise(resolve => setTimeout(resolve, AUDIT_LOG_DELAY_MS));
    try {
        const logs = await guild.fetchAuditLogs({ type, limit: 5 });
        let found = null;
        for (const entry of logs.entries.values()) {
            const count = entry.extra?.count ?? 1;
            const previous = seenCounts.get(entry.id);
            rememberCount(entry.id, count);
            const fresh = previous === undefined
                ? Date.now() - entry.createdTimestamp < FRESH_ENTRY_MS
                : count > previous;
            if (!found && fresh && matches(entry)) found = entry.executor || null;
        }
        return found;
    } catch (error) {
        console.error('Message log: reading the audit log failed:', error.message || error);
        return null;
    }
}

async function onDelete(message) {
    if (!loggable(message)) return;
    const deleter = await findDeleter(message.guild, AuditLogEvent.MessageDelete, entry =>
        entry.target?.id === message.author.id && entry.extra?.channel?.id === message.channelId);
    await AuditLogService.log({
        guildId: message.guild.id,
        action: 'message.deleted',
        actorId: deleter?.id || null,
        actorTag: deleter?.tag || deleter?.username || null,
        targetIds: [message.author.id],
        source: 'discord',
        details: {
            ...channelDetails(message.channel),
            messageId: message.id,
            content: clip(message.content),
            attachments: attachmentNames(message),
            sentAt: message.createdAt?.toISOString() || null
        }
    });
}

async function onEdit(oldMessage, newMessage) {
    if (!loggable(oldMessage) || newMessage.partial) return;
    // Link previews and embeds loading in fire an update too; only text changes count
    if (oldMessage.content === newMessage.content) return;
    await AuditLogService.log({
        guildId: newMessage.guild.id,
        action: 'message.edited',
        actorId: newMessage.author.id,
        actorTag: newMessage.author.tag || newMessage.author.username,
        targetIds: [newMessage.author.id],
        source: 'discord',
        details: {
            ...channelDetails(newMessage.channel),
            messageId: newMessage.id,
            content: clip(oldMessage.content),
            newContent: clip(newMessage.content),
            url: newMessage.url || null
        }
    });
}

/** A purge: one entry with the count, no texts. */
async function onBulkDelete(messages, channel) {
    if (!channel?.guild) return;
    const authors = [...new Set([...messages.values()]
        .filter(message => message.author && !message.author.bot)
        .map(message => message.author.id))].slice(0, MAX_AUTHORS);
    const deleter = await findDeleter(channel.guild, AuditLogEvent.MessageBulkDelete, entry =>
        (entry.target?.id || entry.targetId) === channel.id);
    await AuditLogService.log({
        guildId: channel.guild.id,
        action: 'message.bulk_deleted',
        actorId: deleter?.id || null,
        actorTag: deleter?.tag || deleter?.username || null,
        targetIds: authors,
        source: 'discord',
        details: { ...channelDetails(channel), count: messages.size }
    });
}

function guard(fn) {
    return (...args) => fn(...args).catch(error => console.error('Message log error:', error.message || error));
}

module.exports = {
    name: 'messagelog',
    loggable,

    register(client) {
        client.on(Events.MessageDelete, guard(onDelete));
        client.on(Events.MessageUpdate, guard(onEdit));
        client.on(Events.MessageBulkDelete, guard(onBulkDelete));
    },

    // For tests
    onDelete,
    onEdit,
    onBulkDelete,
    findDeleter
};
