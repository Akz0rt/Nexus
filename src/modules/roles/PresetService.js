const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');

const PRESETS_CONTAINER = 'role_presets';

/**
 * Named sets of roles ("Ивентер", "Хелпер"): one document per preset,
 * shared by every moderator of the guild.
 */
class PresetService {
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
            id: PRESETS_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(PRESETS_CONTAINER);
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

    async get(guildId, presetId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(presetId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    /**
     * Create (no id) or replace a preset.
     * @param {{ id?: string, guildId: string, name: string, roleIds: string[], actorId: string }} preset
     */
    async save(preset) {
        await this.initialize();
        const now = new Date().toISOString();
        const existing = preset.id ? await this.get(preset.guildId, preset.id) : null;
        const doc = {
            id: existing?.id || crypto.randomUUID(),
            guildId: preset.guildId,
            name: preset.name,
            roleIds: preset.roleIds,
            createdBy: existing?.createdBy || preset.actorId,
            createdAt: existing?.createdAt || now,
            updatedBy: preset.actorId,
            updatedAt: now
        };
        await this.container.items.upsert(doc);
        return doc;
    }

    async remove(guildId, presetId) {
        await this.initialize();
        try {
            await this.container.item(presetId, guildId).delete();
            return true;
        } catch (error) {
            if (error.code === 404) return false;
            throw error;
        }
    }
}

module.exports = new PresetService();
