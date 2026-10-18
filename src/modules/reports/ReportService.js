const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');

const REPORTS_CONTAINER = 'reports';
const TTL_90_DAYS = 90 * 24 * 60 * 60;
const MAX_TEXT = 2000;
const MAX_REASON = 400;
const MAX_REPLY = 1500;
const HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

const OPEN = ['open', 'taken'];
const CLOSED = ['resolved', 'rejected'];

function clip(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Member reports on messages ("Пожаловаться" in the message context menu).
 * Only moderators in the app see them; the reported member is never told.
 * Kept 90 days.
 */
class ReportService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({
            id: REPORTS_CONTAINER,
            partitionKey: { paths: ['/guildId'] },
            defaultTtl: TTL_90_DAYS
        });

        this.container = database.container(REPORTS_CONTAINER);
        this.initialized = true;
    }

    async get(guildId, reportId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(reportId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async save(report) {
        await this.initialize();
        await this.container.items.upsert(report);
        return report;
    }

    /** @param {'open'|'closed'} group */
    async list(guildId, group = 'open') {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND ARRAY_CONTAINS(@statuses, c.status) ORDER BY c.createdAt DESC',
            parameters: [
                { name: '@guildId', value: guildId },
                { name: '@statuses', value: group === 'closed' ? CLOSED : OPEN }
            ]
        }, { partitionKey: guildId, maxItemCount: 200 }).fetchNext();
        return resources || [];
    }

    /** Reports by one member in the last hour, and whether they already reported this message. */
    async recentBy(guildId, reporterId, messageId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT c.messageId, c.createdAt FROM c WHERE c.guildId = @guildId AND c.reporterId = @reporterId',
            parameters: [{ name: '@guildId', value: guildId }, { name: '@reporterId', value: reporterId }]
        }, { partitionKey: guildId }).fetchAll();
        const since = new Date(Date.now() - HOUR_MS).toISOString();
        return {
            lastHour: resources.filter(r => r.createdAt >= since).length,
            duplicate: resources.some(r => r.messageId === messageId)
        };
    }

    /**
     * A member reports a message.
     * @param {import('discord.js').Message} message
     * @param {import('discord.js').User} reporter
     */
    async create(message, reporter, reason) {
        const guild = message.guild;
        if (!guild) return { ok: false, code: 'not_in_guild' };
        const text = String(reason || '').trim();
        if (!text) return { ok: false, code: 'reason_required' };
        if (message.author?.id === reporter.id) return { ok: false, code: 'self' };
        if (message.author?.bot) return { ok: false, code: 'target_bot' };

        const recent = await this.recentBy(guild.id, reporter.id, message.id);
        if (recent.duplicate) return { ok: false, code: 'duplicate' };
        if (recent.lastHour >= HOURLY_LIMIT) return { ok: false, code: 'rate_limited' };

        const report = {
            id: crypto.randomUUID(),
            guildId: guild.id,
            reporterId: reporter.id,
            targetId: message.author.id,
            channelId: message.channelId,
            messageId: message.id,
            messageUrl: message.url || null,
            content: clip(message.content, MAX_TEXT),
            attachments: [...(message.attachments?.values() || [])].slice(0, 10).map(file => file.name || 'файл'),
            sentAt: message.createdAt?.toISOString() || null,
            reason: clip(text, MAX_REASON),
            status: 'open',
            takenBy: null,
            resolvedBy: null,
            resolution: null,
            repliedAt: null,
            createdAt: new Date().toISOString()
        };
        await this.save(report);
        await this.log(guild.id, 'report.created', report, { id: reporter.id, tag: reporter.tag || reporter.username }, 'discord');
        return { ok: true, report };
    }

    async log(guildId, action, report, actor, source, extra = {}) {
        await AuditLogService.log({
            guildId,
            action,
            actorId: actor?.id || null,
            actorTag: actor?.tag || null,
            targetIds: [report.targetId],
            source,
            // No message text here: the journal is visible more widely than the report
            details: { reportId: report.id, channelId: report.channelId, ...extra }
        });
    }

    async change(guildId, reportId, actor, fn) {
        const report = await this.get(guildId, String(reportId));
        if (!report) return { ok: false, code: 'report_not_found' };
        const result = fn(report);
        if (result) return result;
        report.updatedAt = new Date().toISOString();
        await this.save(report);
        return { ok: true, report };
    }

    async take(guildId, reportId, actor, source) {
        const result = await this.change(guildId, reportId, actor, report => {
            if (CLOSED.includes(report.status)) return { ok: false, code: 'report_closed' };
            report.status = 'taken';
            report.takenBy = actor.id;
            return null;
        });
        if (result.ok) await this.log(guildId, 'report.taken', result.report, actor, source);
        return result;
    }

    /** @param {'resolved'|'rejected'} status */
    async close(guildId, reportId, status, note, actor, source) {
        const result = await this.change(guildId, reportId, actor, report => {
            if (CLOSED.includes(report.status)) return { ok: false, code: 'report_closed' };
            report.status = status;
            report.resolvedBy = actor.id;
            report.resolvedAt = new Date().toISOString();
            report.resolution = clip(String(note || '').trim(), MAX_REASON) || null;
            if (!report.takenBy) report.takenBy = actor.id;
            return null;
        });
        if (result.ok) {
            await this.log(guildId, status === 'resolved' ? 'report.resolved' : 'report.rejected', result.report, actor, source,
                result.report.resolution ? { note: result.report.resolution } : {});
        }
        return result;
    }

    /** The bot DMs the reporter a moderator's answer. */
    async reply(guild, reportId, text, actor, source) {
        const message = String(text || '').trim();
        if (!message) return { ok: false, code: 'reason_required' };
        const report = await this.get(guild.id, String(reportId));
        if (!report) return { ok: false, code: 'report_not_found' };

        const user = await guild.client.users.fetch(report.reporterId).catch(() => null);
        if (!user) return { ok: false, code: 'user_not_found' };
        try {
            await user.send({
                content: `Ответ модераторов сервера «${guild.name}» на вашу жалобу:\n\n${clip(message, MAX_REPLY)}`,
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            return { ok: false, code: 'dm_closed' };
        }
        report.repliedAt = new Date().toISOString();
        report.repliedBy = actor.id;
        await this.save(report);
        await this.log(guild.id, 'report.replied', report, actor, source);
        return { ok: true, report };
    }
}

module.exports = new ReportService();
module.exports.HOURLY_LIMIT = HOURLY_LIMIT;
