const { CosmosClient } = require('@azure/cosmos');
const config = require('../../config');

const TEMP_BANS_CONTAINER = 'temp_bans';

/**
 * Temporary bans waiting for their automatic unban: one document per (guildId, userId).
 * Discord itself has no ban expiry, so the bot unbans when unbanAt passes.
 */
class TempBanService {
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
            id: TEMP_BANS_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(TEMP_BANS_CONTAINER);
        this.initialized = true;
    }

    /** @param {{ guildId, userId, unbanAt, reason, actorId, actorTag }} ban */
    async set(ban) {
        await this.initialize();
        const doc = { ...ban, id: ban.userId, createdAt: new Date().toISOString() };
        await this.container.items.upsert(doc);
        return doc;
    }

    async remove(guildId, userId) {
        await this.initialize();
        try {
            await this.container.item(userId, guildId).delete();
            return true;
        } catch (error) {
            if (error.code === 404) return false;
            throw error;
        }
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.unbanAt ASC',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Bans whose time is up, across all guilds. */
    async listDue(now = new Date()) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.unbanAt <= @now',
            parameters: [{ name: '@now', value: now.toISOString() }]
        }).fetchAll();
        return resources;
    }
}

module.exports = new TempBanService();
