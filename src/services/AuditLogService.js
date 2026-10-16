const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../config');

const AUDIT_LOG_CONTAINER = 'audit_log';
const TTL_30_DAYS = 30 * 24 * 60 * 60; // 2,592,000 seconds

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

        return doc;
    }
}

module.exports = new AuditLogService();
