const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');
const { DEFAULT_REASONS, DEFAULT_ESCALATION } = require('../modules/moderation/templates');

const GUILD_SETTINGS_CONTAINER = 'guild_settings';
const CACHE_TTL_MS = 60 * 1000;

// Per-guild settings keys and their env fallbacks (env applies to the default guild only)
const ENV_DEFAULTS = {
    unverifiedRoleId: () => config.unverifiedRoleId,
    maleRoleId: () => config.maleRoleId,
    femaleRoleId: () => config.femaleRoleId,
    verifyQueueChannelId: () => config.verifyQueueChannelId
};

function parseBool(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value).toLowerCase() === 'true';
}

class GuildSettingsService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
        this.cache = new Map(); // guildId -> { at, value }
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({
            id: GUILD_SETTINGS_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(GUILD_SETTINGS_CONTAINER);
        this.initialized = true;
    }

    // Raw guild document from Cosmos (null if absent or DB unavailable)
    async readDoc(guildId) {
        try {
            await this.initialize();
            const { resource } = await this.container.item(guildId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            console.error(`GuildSettingsService.readDoc(${guildId}) error:`, error.message || error);
            return null;
        }
    }

    isDefaultGuild(guildId) {
        // With no GUILD_ID configured the bot is single-server, so env applies everywhere
        return !config.guildId || config.guildId === guildId;
    }

    // Resolution order: guild doc → env (default guild only) → undefined
    resolve(guildId, doc) {
        const useEnv = this.isDefaultGuild(guildId);
        const result = { guildId };

        for (const [key, envFn] of Object.entries(ENV_DEFAULTS)) {
            const docValue = doc?.[key];
            result[key] = docValue !== undefined && docValue !== ''
                ? docValue
                : (useEnv ? envFn() || undefined : undefined);
        }

        const docModules = doc?.modules || {};
        const envVerification = useEnv ? parseBool(config.moduleVerificationEnabled) : undefined;
        const verification = docModules.verification ?? envVerification ?? Boolean(result.unverifiedRoleId);
        result.modules = { ...docModules, verification };

        // Give @unverified on join ourselves (skipped if a third-party bot already did). On by default.
        const envAssign = useEnv ? parseBool(config.assignUnverifiedOnJoin) : undefined;
        result.assignUnverifiedOnJoin = doc?.assignUnverifiedOnJoin ?? envAssign ?? true;

        // Moderation: reason templates and warn escalation (edited from the panel's Settings later)
        const moderation = doc?.moderation || {};
        result.moderation = {
            reasons: Array.isArray(moderation.reasons) && moderation.reasons.length ? moderation.reasons : DEFAULT_REASONS,
            escalation: Array.isArray(moderation.escalation) ? moderation.escalation : DEFAULT_ESCALATION
        };

        return result;
    }

    async get(guildId) {
        const cached = this.cache.get(guildId);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

        const doc = await this.readDoc(guildId);
        const value = this.resolve(guildId, doc);
        this.cache.set(guildId, { at: Date.now(), value });
        return value;
    }

    async update(guildId, patch) {
        await this.initialize();

        const existing = (await this.readDoc(guildId)) || {};
        const updated = { ...existing, ...patch, id: guildId, guildId };
        for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) delete updated[field];

        await this.container.items.upsert(updated);
        this.cache.delete(guildId);
        return updated;
    }
}

module.exports = new GuildSettingsService();
