const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../config');
const EventBus = require('./EventBus');

const AUDIT_LOG_CONTAINER = 'audit_log';
const TTL_30_DAYS = 30 * 24 * 60 * 60; // 2,592,000 seconds

const FILTER_CLAUSES = {
    action: 'c.action = @action',
    actorId: 'c.actorId = @actorId',
    targetId: 'ARRAY_CONTAINS(c.targetIds, @targetId)',
    source: 'c.source = @source',
    since: 'c.createdAt >= @since',
    until: 'c.createdAt < @until'
};

/** Parameterised Cosmos query for the given filters (empty filters are ignored). */
function buildAuditQuery(filters) {
    const where = ['c.guildId = @guildId'];
    const parameters = [{ name: '@guildId', value: filters.guildId }];
    for (const [key, clause] of Object.entries(FILTER_CLAUSES)) {
        const value = filters[key];
        if (value === undefined || value === null || value === '') continue;
        // "message.*" — every action of a group
        if (key === 'action' && String(value).endsWith('.*')) {
            where.push('STARTSWITH(c.action, @action)');
            parameters.push({ name: '@action', value: String(value).slice(0, -1) });
            continue;
        }
        where.push(clause);
        parameters.push({ name: `@${key}`, value: String(value) });
    }
    // Leave a whole group out, e.g. the frequent message log on the start screen
    if (filters.excludePrefix) {
        where.push('NOT STARTSWITH(c.action, @excludePrefix)');
        parameters.push({ name: '@excludePrefix', value: String(filters.excludePrefix) });
    }
    return {
        query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.createdAt DESC`,
        parameters
    };
}

/**
 * Action log stored only in Cosmos DB (shown in the panel later, not mirrored to Discord).
 */
class AuditLogService {
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
            id: AUDIT_LOG_CONTAINER,
            partitionKey: { paths: ['/guildId'] },
            defaultTtl: TTL_30_DAYS
        });

        this.container = database.container(AUDIT_LOG_CONTAINER);

        try {
            const { resource: containerDef } = await this.container.read();
            if (containerDef.defaultTtl !== TTL_30_DAYS) {
                await this.container.replace({ ...containerDef, defaultTtl: TTL_30_DAYS });
                console.log('AuditLogService: updated TTL on audit_log container');
            }
        } catch (e) {
            console.warn('AuditLogService: could not patch TTL on audit_log container:', e.message);
        }

        this.initialized = true;
    }

    /**
     * Record an action. Never throws — logging must not break the action itself.
     * @param {{ guildId: string, action: string, actorId?: string|null, actorTag?: string|null,
     *           targetIds?: string[], reason?: string|null, source: 'discord'|'bot'|'panel'|'auto',
     *           details?: object }} entry
     */
    async log(entry) {
        const doc = {
            id: crypto.randomUUID(),
            guildId: entry.guildId,
            action: entry.action,
            actorId: entry.actorId || null,
            actorTag: entry.actorTag || null,
            targetIds: entry.targetIds || [],
            reason: entry.reason || null,
            source: entry.source,
            details: entry.details || {},
            createdAt: new Date().toISOString()
        };

        try {
            await this.initialize();
            await this.container.items.create(doc);
        } catch (error) {
            console.error('AuditLogService: failed to write audit_log:', error.message || error);
        }

        // Open panels must see the action even if the DB write failed
        try {
            EventBus.emit('audit', doc);
        } catch (error) {
            console.error('AuditLogService: event listener failed:', error.message || error);
        }

        return doc;
    }

    /** One entry, or null */
    async get(guildId, entryId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(entryId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    /** Mark an entry as undone from the journal (who and when), so the button doesn't come back */
    async markUndone(entry, actor, { outdated = false } = {}) {
        await this.initialize();
        const updated = { ...entry, undoneBy: actor.id, undoneByTag: actor.tag || null, undoneAt: new Date().toISOString(), ...(outdated ? { outdated: true } : {}) };
        for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) delete updated[field];
        await this.container.items.upsert(updated);
        return updated;
    }

    /**
     * Newest-first page of log entries.
     * @param {{ guildId: string, action?: string, actorId?: string, targetId?: string,
     *           source?: string, since?: string, until?: string }} filters
     * @param {{ limit?: number, cursor?: string }} [page]
     * @returns {Promise<{ items: object[], cursor: string|null }>}
     */
    async query(filters, { limit = 50, cursor } = {}) {
        await this.initialize();
        const iterator = this.container.items.query(buildAuditQuery(filters), {
            partitionKey: filters.guildId,
            maxItemCount: Math.min(Math.max(limit, 1), 200),
            continuationToken: cursor || undefined
        });
        const { resources, continuationToken } = await iterator.fetchNext();
        return { items: resources || [], cursor: continuationToken || null };
    }

    /**
     * How many entries of each action every moderator has since a moment — for the
     * moderator stats. Entries without an actor (bot, auto) don't count.
     * @returns {Promise<Array<{ actorId: string, action: string, n: number }>>}
     */
    async countByActor(guildId, sinceIso) {
        await this.initialize();
        // Counted here rather than with GROUP BY: a month of moderator actions is small.
        // The message log is left out: its "actor" is the message author.
        const { resources } = await this.container.items.query({
            query: 'SELECT c.actorId, c.action FROM c ' +
                'WHERE c.guildId = @guildId AND c.createdAt >= @since AND IS_STRING(c.actorId) ' +
                "AND NOT STARTSWITH(c.action, 'message.')",
            parameters: [{ name: '@guildId', value: guildId }, { name: '@since', value: sinceIso }]
        }, { partitionKey: guildId }).fetchAll();
        const counts = new Map();
        for (const { actorId, action } of resources) {
            const key = `${actorId}\n${action}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts].map(([key, n]) => {
            const [actorId, action] = key.split('\n');
            return { actorId, action, n };
        });
    }
}

module.exports = new AuditLogService();
module.exports.buildAuditQuery = buildAuditQuery;
