const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');
const { WARN_TTL_DAYS } = require('./templates');

const WARNINGS_CONTAINER = 'warnings';
const WARN_TTL_SECONDS = WARN_TTL_DAYS * 24 * 60 * 60;

/**
 * Warns: one document per warn. Cosmos deletes a warn when it expires (TTL),
 * so every stored warn that hasn't passed expiresAt is active.
 */
class WarningService {
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
            id: WARNINGS_CONTAINER,
            partitionKey: { paths: ['/guildId'] },
            defaultTtl: WARN_TTL_SECONDS
        });

        this.container = database.container(WARNINGS_CONTAINER);
        this.initialized = true;
    }

    /**
     * @param {{ guildId: string, userId: string, reason: string, actorId: string|null,
     *           actorTag: string|null, source: string }} warn
     */
    async add(warn) {
        await this.initialize();
        const now = Date.now();
        const doc = {
            id: crypto.randomUUID(),
            guildId: warn.guildId,
            userId: warn.userId,
            reason: warn.reason,
            actorId: warn.actorId || null,
            actorTag: warn.actorTag || null,
            source: warn.source,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + WARN_TTL_SECONDS * 1000).toISOString()
        };
        await this.container.items.create(doc);
        return doc;
    }

    /** Active warns of a guild (or of one member), newest first. */
    async listActive(guildId, userId = null) {
        await this.initialize();
        const parameters = [
            { name: '@guildId', value: guildId },
            { name: '@now', value: new Date().toISOString() }
        ];
        let query = 'SELECT * FROM c WHERE c.guildId = @guildId AND c.expiresAt > @now';
        if (userId) {
            query += ' AND c.userId = @userId';
            parameters.push({ name: '@userId', value: userId });
        }
        query += ' ORDER BY c.createdAt DESC';
        const { resources } = await this.container.items.query({ query, parameters }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async get(guildId, warnId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(warnId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async remove(guildId, warnId) {
        await this.initialize();
        try {
            await this.container.item(warnId, guildId).delete();
            return true;
        } catch (error) {
            if (error.code === 404) return false;
            throw error;
        }
    }
}

module.exports = new WarningService();
