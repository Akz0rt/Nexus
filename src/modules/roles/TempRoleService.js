const { CosmosClient } = require('@azure/cosmos');
const config = require('../../config');

const TEMP_ROLES_CONTAINER = 'temp_roles';

/**
 * Roles given for a limited time: one document per (guildId, userId, roleId).
 * Discord has no role expiry, so the bot takes the role away when expiresAt passes.
 * An in-memory index of the keys lets member/role events skip Cosmos when
 * nothing temporary is involved (which is almost always).
 */
class TempRoleService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
        this.index = new Set(); // `${guildId}:${userId}:${roleId}`
        this.indexLoaded = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({
            id: TEMP_ROLES_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(TEMP_ROLES_CONTAINER);
        this.initialized = true;
    }

    docId(userId, roleId) {
        return `${userId}:${roleId}`;
    }

    indexKey(guildId, userId, roleId) {
        return `${guildId}:${userId}:${roleId}`;
    }

    /** Fill the index from Cosmos (once, on startup). */
    async loadIndex() {
        await this.initialize();
        const { resources } = await this.container.items.query('SELECT c.guildId, c.userId, c.roleId FROM c').fetchAll();
        this.index = new Set(resources.map(doc => this.indexKey(doc.guildId, doc.userId, doc.roleId)));
        this.indexLoaded = true;
        return this.index.size;
    }

    has(guildId, userId, roleId) {
        return this.index.has(this.indexKey(guildId, userId, roleId));
    }

    /** Temporary role keys of one member, from the index. */
    rolesOf(guildId, userId) {
        const prefix = `${guildId}:${userId}:`;
        return [...this.index].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    }

    /** Members holding a role temporarily, from the index. */
    holdersOf(guildId, roleId) {
        const prefix = `${guildId}:`;
        const suffix = `:${roleId}`;
        return [...this.index]
            .filter(key => key.startsWith(prefix) && key.endsWith(suffix))
            .map(key => key.slice(prefix.length, key.length - suffix.length));
    }

    async get(guildId, userId, roleId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(this.docId(userId, roleId), guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    /** @param {{ guildId, userId, roleId, roleName, expiresAt, actorId, actorTag }} grant */
    async set(grant) {
        await this.initialize();
        const doc = { ...grant, id: this.docId(grant.userId, grant.roleId), createdAt: new Date().toISOString() };
        await this.container.items.upsert(doc);
        this.index.add(this.indexKey(grant.guildId, grant.userId, grant.roleId));
        return doc;
    }

    async remove(guildId, userId, roleId) {
        this.index.delete(this.indexKey(guildId, userId, roleId));
        await this.initialize();
        try {
            await this.container.item(this.docId(userId, roleId), guildId).delete();
            return true;
        } catch (error) {
            if (error.code === 404) return false;
            throw error;
        }
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.expiresAt ASC',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async listForUser(guildId, userId) {
        if (this.indexLoaded && this.rolesOf(guildId, userId).length === 0) return [];
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND c.userId = @userId',
            parameters: [{ name: '@guildId', value: guildId }, { name: '@userId', value: userId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Grants whose time is up, across all guilds. */
    async listDue(now = new Date()) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.expiresAt <= @now',
            parameters: [{ name: '@now', value: now.toISOString() }]
        }).fetchAll();
        return resources;
    }
}

module.exports = new TempRoleService();
