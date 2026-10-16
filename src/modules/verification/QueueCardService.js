const { CosmosClient } = require('@azure/cosmos');
const config = require('../../config');

const QUEUE_CARDS_CONTAINER = 'queue_cards';

/**
 * Cards of the verification queue: one document per (guildId, userId).
 * status: pending | approved | kicked | left | closed
 */
class QueueCardService {
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
            id: QUEUE_CARDS_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(QUEUE_CARDS_CONTAINER);
        this.initialized = true;
    }

    async get(guildId, userId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(userId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async listPending(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND c.status = "pending"',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Cards closed with one of the statuses since the given ISO time, newest first. */
    async listHandled(guildId, statuses, sinceIso) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND ARRAY_CONTAINS(@statuses, c.status) ' +
                'AND c.handledAt >= @since ORDER BY c.handledAt DESC',
            parameters: [
                { name: '@guildId', value: guildId },
                { name: '@statuses', value: statuses },
                { name: '@since', value: sinceIso }
            ]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async upsert(card) {
        await this.initialize();
        const doc = { ...card, id: card.userId };
        for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) delete doc[field];
        await this.container.items.upsert(doc);
        return doc;
    }
}

module.exports = new QueueCardService();
