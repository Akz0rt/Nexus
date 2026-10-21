const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');
const state = require('../state');
const { DEFAULT_REASONS, DEFAULT_ESCALATION, DEFAULT_PUNISH_TEMPLATES } = require('../modules/moderation/templates');
const { resolveBanner } = require('../banner/settings');

const GUILD_SETTINGS_CONTAINER = 'guild_settings';
const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_SLOWMODE_SECONDS = 30;
const DEFAULT_YOUNG_ACCOUNT_DAYS = 7;

// Per-guild settings keys and their env fallbacks (env applies to the default guild only)
const ENV_DEFAULTS = {
    unverifiedRoleId: () => config.unverifiedRoleId,
    maleRoleId: () => config.maleRoleId,
    femaleRoleId: () => config.femaleRoleId,
    verifyQueueChannelId: () => config.verifyQueueChannelId,
    // Birthdays: when to congratulate and where
    birthdayCheckTime: () => config.checkTime,
    birthdayCongratsChannelId: () => config.congratsChannel,
    birthdayAnnounceChannelId: () => config.birthdayChannel,
    // The channel where the AI assistant answers
    aiChannelId: () => config.aiChannelId
};

// Keys the panel may switch off on purpose: a saved '' means «none», not «use Azure»
const CLEARABLE = new Set(['birthdayCongratsChannelId', 'birthdayAnnounceChannelId', 'aiChannelId']);
const DEFAULT_CHECK_TIME = '00:00';

/** True for an IANA zone this Node knows («Europe/Moscow»), false for anything else */
function isValidTimezone(zone) {
    if (!zone || typeof zone !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/**
 * The main server: GUILD_ID, or without it the lowest server id (the same one after
 * every restart). Azure variables are its settings; other servers start empty.
 */
function mainGuildId(client = state.client) {
    if (config.guildId) return config.guildId;
    const ids = [...(client?.guilds?.cache.keys() || [])];
    return ids.length ? ids.reduce((low, id) => (BigInt(id) < BigInt(low) ? id : low)) : null;
}

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

    // The old global settings doc (BANNER_MODE and the like), {} when unavailable
    async readLegacy() {
        try {
            return await require('./SettingsService').getSettings();
        } catch (error) {
            console.error('GuildSettingsService.readLegacy error:', error.message || error);
            return {};
        }
    }

    isDefaultGuild(guildId) {
        // Azure variables belong to the main server only, never to every server
        return Boolean(guildId) && mainGuildId() === guildId;
    }

    // Resolution order: guild doc → env (default guild only) → undefined.
    // `legacy` is the old global settings doc, read only for the main server's banner
    resolve(guildId, doc, legacy = null) {
        const useEnv = this.isDefaultGuild(guildId);
        const result = { guildId };

        for (const [key, envFn] of Object.entries(ENV_DEFAULTS)) {
            const docValue = doc?.[key];
            result[key] = docValue !== undefined && (docValue !== '' || CLEARABLE.has(key))
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

        // Every server has its own calendar: birthdays, «today» in stats. Azure TIMEZONE until set
        result.timezone = isValidTimezone(doc?.timezone) ? doc.timezone
            : (isValidTimezone(config.timezone) ? config.timezone : 'UTC');
        result.birthdayCheckTime = result.birthdayCheckTime || DEFAULT_CHECK_TIME;

        // Booster accounts: their marker role (made by the bot on the first booster pass)
        result.boosterRoleId = doc?.boosterRoleId || null;

        // Queue flags: an account younger than this is «новый аккаунт»
        const youngDays = doc?.verification?.youngAccountDays;
        result.verification = { youngAccountDays: Number.isInteger(youngDays) ? youngDays : DEFAULT_YOUNG_ACCOUNT_DAYS };

        // Moderation: reason templates and warn escalation (edited from the panel's Settings later)
        const moderation = doc?.moderation || {};
        result.moderation = {
            reasons: Array.isArray(moderation.reasons) && moderation.reasons.length ? moderation.reasons : DEFAULT_REASONS,
            escalation: Array.isArray(moderation.escalation) ? moderation.escalation : DEFAULT_ESCALATION,
            templates: Array.isArray(moderation.templates) ? moderation.templates : DEFAULT_PUNISH_TEMPLATES
        };

        // Lockdown: start channels that get slowmode, and the current state (to undo it exactly)
        const lockdown = doc?.lockdown || {};
        result.lockdown = {
            channelIds: Array.isArray(lockdown.channelIds) ? lockdown.channelIds : [],
            slowmodeSeconds: Number.isInteger(lockdown.slowmodeSeconds) ? lockdown.slowmodeSeconds : DEFAULT_SLOWMODE_SECONDS
        };
        result.lockdownState = doc?.lockdownState || null;

        // Economy: off until turned on in the app (so it never runs alongside the old economy bot),
        // the channel for level-up announcements and the roles given at levels
        const economy = doc?.economy || {};
        result.economy = {
            enabled: economy.enabled === true,
            channelId: economy.channelId || null,
            levelRoles: Array.isArray(economy.levelRoles) ? economy.levelRoles : [],
            payEnabled: economy.payEnabled !== false,
            gamesEnabled: economy.gamesEnabled !== false,
            // Personal roles: rented; new ones go right above the anchor role
            personalRoles: {
                enabled: economy.personalRoles?.enabled === true,
                anchorRoleId: economy.personalRoles?.anchorRoleId || null,
                createPrice: Number.isInteger(economy.personalRoles?.createPrice) ? economy.personalRoles.createPrice : 3000,
                rentPrice: Number.isInteger(economy.personalRoles?.rentPrice) ? economy.personalRoles.rentPrice : 1000,
                periodDays: Number.isInteger(economy.personalRoles?.periodDays) ? economy.personalRoles.periodDays : 30,
                maxActive: Number.isInteger(economy.personalRoles?.maxActive) ? economy.personalRoles.maxActive : 3
            }
        };

        // Server banner: its own group; the main server falls back to the old global settings
        result.banner = resolveBanner(doc?.banner, useEnv ? legacy : null);

        // Which env-backed keys come from env rather than the guild doc (shown in Settings)
        result.fromEnv = useEnv ? Object.keys(ENV_DEFAULTS).filter(key =>
            (doc?.[key] === undefined || (doc[key] === '' && !CLEARABLE.has(key))) && ENV_DEFAULTS[key]() && result[key] !== undefined) : [];

        return result;
    }

    async get(guildId) {
        const cached = this.cache.get(guildId);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

        const doc = await this.readDoc(guildId);
        const legacy = !doc?.banner && this.isDefaultGuild(guildId) ? await this.readLegacy() : null;
        const value = this.resolve(guildId, doc, legacy);
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
module.exports.DEFAULT_SLOWMODE_SECONDS = DEFAULT_SLOWMODE_SECONDS;
module.exports.mainGuildId = mainGuildId;
module.exports.isValidTimezone = isValidTimezone;
