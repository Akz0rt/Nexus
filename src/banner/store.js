const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');

/**
 * Where the banner's files live: the uploaded background and the last banners (picture +
 * thumbnail) on the App Service disk (/home survives restarts and deploys), their
 * descriptions in Cosmos (container banner, /guildId):
 *   state       — what is on the server now, the last publish, the last error, leaders by day
 *   background  — the uploaded background
 *   h-<id>      — one published banner (the last HISTORY_SIZE are kept)
 */

const CONTAINER = 'banner';
const HISTORY_SIZE = 10;

function storageRoot() {
    if (process.env.BANNER_STORAGE_DIR) return process.env.BANNER_STORAGE_DIR;
    // On App Service /home is the persistent share; site/wwwroot is replaced by every deploy
    if (process.env.WEBSITE_SITE_NAME && process.env.HOME) return path.join(process.env.HOME, 'data', 'nexus-banner');
    return path.join(__dirname, '..', '..', 'data', 'banner');
}

const EXTENSIONS = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

class BannerStore {
    constructor() {
        this.container = null;
        this.initialized = false;
        this.root = null;
    }

    async initialize() {
        if (this.initialized) return;
        const client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.container = database.container(CONTAINER);
        this.initialized = true;
    }

    // ---- files ----

    file(guildId, name) {
        if (!/^\d+$/.test(String(guildId)) || !/^[\w.-]+$/.test(name)) throw new Error('bad banner file name');
        return path.join(this.root || storageRoot(), String(guildId), name);
    }

    async writeFile(guildId, name, buffer) {
        const target = this.file(guildId, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buffer);
    }

    async readFile(guildId, name) {
        try {
            return await fs.readFile(this.file(guildId, name));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async deleteFile(guildId, name) {
        if (!name) return;
        await fs.rm(this.file(guildId, name), { force: true }).catch(() => {});
    }

    // ---- documents ----

    async readDoc(guildId, id) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(id, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async writeDoc(guildId, doc) {
        await this.initialize();
        const clean = { ...doc, guildId };
        for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) delete clean[field];
        await this.container.items.upsert(clean);
        return clean;
    }

    async getState(guildId) {
        return (await this.readDoc(guildId, 'state')) || { id: 'state', kind: 'state', guildId };
    }

    /** Merges into the saved state */
    async updateState(guildId, patch) {
        const state = await this.getState(guildId);
        return this.writeDoc(guildId, { ...state, ...patch, id: 'state', kind: 'state' });
    }

    // ---- background ----

    async getBackground(guildId) {
        const meta = await this.readDoc(guildId, 'background');
        if (!meta) return null;
        const buffer = await this.readFile(guildId, meta.file);
        return buffer ? { meta, buffer } : null;
    }

    /**
     * Replace the background (already checked and brought to 960×540).
     * @returns the new background's description
     */
    async saveBackground(guildId, { buffer, type, name, animated, actorId = null }) {
        const previous = await this.readDoc(guildId, 'background');
        const id = crypto.randomUUID().slice(0, 12);
        const file = `background-${id}.${EXTENSIONS[type] || 'bin'}`;
        await this.writeFile(guildId, file, buffer);
        const meta = await this.writeDoc(guildId, {
            id: 'background', kind: 'background', backgroundId: id, file, type,
            name: String(name || file).slice(0, 120), bytes: buffer.length, animated: Boolean(animated),
            uploadedAt: new Date().toISOString(), uploadedBy: actorId
        });
        if (previous?.file && previous.file !== file) await this.deleteFile(guildId, previous.file);
        return meta;
    }

    // ---- history ----

    async listHistory(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: "SELECT * FROM c WHERE c.guildId = @guildId AND c.kind = 'history' ORDER BY c.createdAt DESC",
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources || [];
    }

    async getHistory(guildId, historyId) {
        if (!/^[\w-]+$/.test(String(historyId))) return null;
        const entry = await this.readDoc(guildId, `h-${historyId}`);
        return entry?.kind === 'history' ? entry : null;
    }

    /** Save a published banner and drop the ones past the last HISTORY_SIZE */
    async addHistory(guildId, { buffer, type, thumbnail, ...details }) {
        const historyId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
        const file = `banner-${historyId}.${EXTENSIONS[type] || 'bin'}`;
        const thumb = `banner-${historyId}-thumb.png`;
        await this.writeFile(guildId, file, buffer);
        if (thumbnail) await this.writeFile(guildId, thumb, thumbnail);
        const entry = await this.writeDoc(guildId, {
            ...details, id: `h-${historyId}`, kind: 'history', historyId, file, thumb: thumbnail ? thumb : null,
            type, bytes: buffer.length, createdAt: details.createdAt || new Date().toISOString()
        });

        const all = await this.listHistory(guildId);
        for (const old of all.slice(HISTORY_SIZE)) {
            await this.deleteFile(guildId, old.file);
            await this.deleteFile(guildId, old.thumb);
            await this.container.item(old.id, guildId).delete().catch(() => {});
        }
        return entry;
    }
}

module.exports = new BannerStore();
module.exports.BannerStore = BannerStore;
module.exports.HISTORY_SIZE = HISTORY_SIZE;
module.exports.storageRoot = storageRoot;
