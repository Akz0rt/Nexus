const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../config');

const PANEL_SESSIONS_CONTAINER = 'panel_sessions';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CACHE_TTL_MS = 60 * 1000;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Desktop-app sessions. The client holds an opaque bearer token; only its
 * SHA-256 is stored, so a leaked DB doesn't leak usable tokens.
 */
class PanelSessionService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
        this.cache = new Map(); // tokenHash -> { at, session }
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({
            id: PANEL_SESSIONS_CONTAINER,
            partitionKey: { paths: ['/id'] },
            defaultTtl: SESSION_TTL_SECONDS
        });

        this.container = database.container(PANEL_SESSIONS_CONTAINER);
        this.initialized = true;
    }

    /** @returns {Promise<{ token: string, session: object }>} */
    async create(user) {
        await this.initialize();
        const token = crypto.randomBytes(32).toString('base64url');
        const session = {
            id: hashToken(token),
            userId: user.id,
            username: user.username,
            globalName: user.global_name || null,
            avatar: user.avatar || null,
            createdAt: new Date().toISOString()
        };
        await this.container.items.create(session);
        return { token, session };
    }

    async get(token) {
        if (!token) return null;
        const id = hashToken(token);

        const cached = this.cache.get(id);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.session;

        await this.initialize();
        let session = null;
        try {
            const { resource } = await this.container.item(id, id).read();
            session = resource || null;
        } catch (error) {
            if (error.code !== 404) throw error;
        }
        // Cosmos TTL deletes lazily — enforce expiry ourselves too
        if (session && Date.now() - Date.parse(session.createdAt) > SESSION_TTL_SECONDS * 1000) {
            session = null;
        }

        if (session) this.cache.set(id, { at: Date.now(), session });
        return session;
    }

    async delete(token) {
        if (!token) return;
        const id = hashToken(token);
        this.cache.delete(id);
        await this.initialize();
        try {
            await this.container.item(id, id).delete();
        } catch (error) {
            if (error.code !== 404) throw error;
        }
    }
}

module.exports = new PanelSessionService();
module.exports.hashToken = hashToken;
