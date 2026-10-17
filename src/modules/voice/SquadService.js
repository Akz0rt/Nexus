const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');

const SQUADS_CONTAINER = 'voice_squads';

/**
 * Saved groups of members ("Мафия, пятница"): one document per squad,
 * shared by every moderator of the guild.
 */
class SquadService {
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
            id: SQUADS_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(SQUADS_CONTAINER);
        this.initialized = true;
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.name ASC',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async get(guildId, squadId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(squadId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    /**
     * Create (no id) or replace a squad.
     * @param {{ id?: string, guildId: string, name: string, memberIds: string[], actorId: string }} squad
     */
    async save(squad) {
        await this.initialize();
        const now = new Date().toISOString();
        const existing = squad.id ? await this.get(squad.guildId, squad.id) : null;
        const doc = {
            id: existing?.id || crypto.randomUUID(),
            guildId: squad.guildId,
            name: squad.name,
            memberIds: squad.memberIds,
            createdBy: existing?.createdBy || squad.actorId,
            createdAt: existing?.createdAt || now,
            updatedBy: squad.actorId,
            updatedAt: now
        };
        await this.container.items.upsert(doc);
        return doc;
    }

    async remove(guildId, squadId) {
        await this.initialize();
        try {
            await this.container.item(squadId, guildId).delete();
            return true;
        } catch (error) {
            if (error.code === 404) return false;
            throw error;
        }
    }
}

module.exports = new SquadService();
