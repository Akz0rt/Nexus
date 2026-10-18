const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');
const curve = require('./curve');

const ACCOUNTS_CONTAINER = 'economy';
const TX_CONTAINER = 'economy_tx';
const MAX_RETRIES = 8;
const MAX_ADJUST = 10_000_000;
const LEFT_RETENTION_DAYS = 90; // an account of someone who left is deleted after this
// Accounts of people still on the server (someone who left has leftAt set)
const PRESENT = 'NOT IS_STRING(c.leftAt)';

const COSMOS_FIELDS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

function blankAccount(guildId, userId) {
    const now = new Date().toISOString();
    return {
        id: userId, guildId, userId,
        username: null, displayName: null,
        level: 1, exp: 0, prestige: 0, totalExp: 0, money: 0,
        voiceSeconds: 0, messages: 0,
        leftAt: null,
        createdAt: now, updatedAt: now
    };
}

/**
 * The key an account is kept under while its owner is away: an HMAC of the server
 * and user id, so the record names no one, yet the same person coming back maps to it.
 */
function anonymousId(guildId, userId) {
    const secret = config.economyAnonSecret || config.cosmosKey || 'economy';
    return `anon-${crypto.createHmac('sha256', secret).update(`${guildId}:${userId}`).digest('hex').slice(0, 40)}`;
}

/** A member's identity to keep on the account. */
function identityOf(member) {
    if (!member) return {};
    const user = member.user || member;
    return { username: user.username || null, displayName: member.displayName || user.globalName || user.username || null };
}

/**
 * Levels and coins. One document per member (container `economy`, partition
 * /guildId); every change of balance other than activity coins goes to the
 * `economy_tx` journal. Writes are read-modify-replace guarded by the etag, so
 * two credits at once never lose each other's coins.
 *
 * Someone who leaves the server is obfuscated at once: the account and its journal
 * move to an anonymous key (no user id, no name) and drop out of the tops. Coming back
 * within 90 days restores them; after that they are deleted. Warnings, the moderation
 * log and activity stats are not touched.
 */
class EconomyService {
    constructor() {
        this.client = null;
        this.accounts = null;
        this.transactions = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        this.client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: ACCOUNTS_CONTAINER, partitionKey: { paths: ['/guildId'] } });
        await database.containers.createIfNotExists({ id: TX_CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.accounts = database.container(ACCOUNTS_CONTAINER);
        this.transactions = database.container(TX_CONTAINER);
        this.initialized = true;
    }

    // ---- storage (replaced by fakes in tests) ----

    /** @returns {Promise<{ doc: object, etag: string } | null>} */
    async readRaw(guildId, userId) {
        await this.initialize();
        try {
            const { resource } = await this.accounts.item(userId, guildId).read();
            return resource ? { doc: resource, etag: resource._etag } : null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async upsertRaw(doc) {
        await this.initialize();
        const clean = { ...doc };
        for (const field of COSMOS_FIELDS) delete clean[field];
        await this.accounts.items.upsert(clean);
    }

    async removeRaw(guildId, id) {
        await this.initialize();
        await this.accounts.item(id, guildId).delete().catch(error => { if (error.code !== 404) throw error; });
    }

    async transactionsOf(guildId, ownerId) {
        await this.initialize();
        const { resources } = await this.transactions.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND c.userId = @userId',
            parameters: [{ name: '@guildId', value: guildId }, { name: '@userId', value: ownerId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Move a journal from one owner key to another (on leaving and on coming back). */
    async rekeyTransactions(guildId, fromId, toId) {
        const entries = await this.transactionsOf(guildId, fromId);
        for (const entry of entries) {
            const clean = { ...entry, userId: toId };
            for (const field of COSMOS_FIELDS) delete clean[field];
            await this.transactions.items.upsert(clean);
        }
        return entries.length;
    }

    async deleteTransactions(guildId, ownerId) {
        const entries = await this.transactionsOf(guildId, ownerId);
        for (const { id } of entries) {
            await this.transactions.item(id, guildId).delete().catch(error => { if (error.code !== 404) throw error; });
        }
        return entries.length;
    }

    /** An account and its journal, by the key it is stored under. */
    async deleteAccount(guildId, id) {
        await this.removeRaw(guildId, id);
        return this.deleteTransactions(guildId, id);
    }

    /** Create (etag null) or replace if unchanged since read; throws { code: 409 | 412 } on a race. */
    async writeRaw(doc, etag) {
        await this.initialize();
        const clean = { ...doc };
        for (const field of COSMOS_FIELDS) delete clean[field];
        if (etag) {
            await this.accounts.item(clean.id, clean.guildId).replace(clean, { accessCondition: { type: 'IfMatch', condition: etag } });
        } else {
            await this.accounts.items.create(clean);
        }
    }

    async addTransactions(entries) {
        if (entries.length === 0) return;
        await this.initialize();
        for (const entry of entries) await this.transactions.items.upsert(entry);
    }

    // ---- reads ----

    async get(guildId, userId) {
        const raw = await this.readRaw(guildId, userId);
        return raw ? raw.doc : null;
    }

    /** Top accounts by level (all-time exp) or by balance. */
    async top(guildId, by = 'level', limit = 10) {
        await this.initialize();
        const field = by === 'money' ? 'money' : 'totalExp';
        const { resources } = await this.accounts.items.query({
            query: `SELECT TOP @limit * FROM c WHERE c.guildId = @guildId AND ${PRESENT} ORDER BY c.${field} DESC`,
            parameters: [{ name: '@guildId', value: guildId }, { name: '@limit', value: limit }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** 1-based place in the top by level or by balance. */
    async rank(guildId, account, by = 'level') {
        await this.initialize();
        const field = by === 'money' ? 'money' : 'totalExp';
        const { resources } = await this.accounts.items.query({
            query: `SELECT VALUE COUNT(1) FROM c WHERE c.guildId = @guildId AND ${PRESENT} AND c.${field} > @value`,
            parameters: [{ name: '@guildId', value: guildId }, { name: '@value', value: account[field] || 0 }]
        }, { partitionKey: guildId }).fetchAll();
        return (resources[0] || 0) + 1;
    }

    async totals(guildId) {
        await this.initialize();
        const { resources } = await this.accounts.items.query({
            query: `SELECT COUNT(1) AS accounts, SUM(c.money) AS money FROM c WHERE c.guildId = @guildId AND ${PRESENT}`,
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return { accounts: resources[0]?.accounts || 0, money: resources[0]?.money || 0 };
    }

    async listTransactions(guildId, userId, limit = 50) {
        await this.initialize();
        const { resources } = await this.transactions.items.query({
            query: 'SELECT TOP @limit * FROM c WHERE c.guildId = @guildId AND c.userId = @userId ORDER BY c.createdAt DESC',
            parameters: [{ name: '@guildId', value: guildId }, { name: '@userId', value: userId }, { name: '@limit', value: limit }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    // ---- writes ----

    /**
     * Change an account with a retry on concurrent writes. `change(doc)` edits the
     * doc in place, or returns { ok: false, code } to give up without writing.
     */
    async mutate(guildId, userId, change) {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const raw = await this.readRaw(guildId, userId);
            const doc = raw ? { ...raw.doc } : blankAccount(guildId, userId);
            const verdict = change(doc);
            if (verdict && verdict.ok === false) return verdict;
            doc.totalExp = curve.totalOf(doc.level, doc.exp, doc.prestige || 0);
            doc.updatedAt = new Date().toISOString();
            try {
                await this.writeRaw(doc, raw ? raw.etag : null);
                return { ok: true, account: doc, ...(verdict || {}) };
            } catch (error) {
                if (error.code !== 412 && error.code !== 409) throw error;
            }
        }
        throw new Error(`Economy: too many concurrent writes for ${guildId}/${userId}`);
    }

    transaction(guildId, userId, { amount, balance, kind, cause, actorId = null, source = 'bot', createdAt }) {
        return {
            id: crypto.randomUUID(), guildId, userId, amount, balance, kind, cause, actorId, source,
            createdAt: createdAt || new Date().toISOString()
        };
    }

    /**
     * Activity: exp and coins (and the counters). Reaching a level or a prestige adds
     * its reward in the same write. @returns {{ account, reached: number[], prestiges: number, rewards: number }}
     */
    async credit(guildId, member, { exp = 0, money = 0, voiceSeconds = 0, messages = 0 }) {
        const userId = member.id;
        const identity = identityOf(member);
        const result = await this.mutate(guildId, userId, doc => {
            const next = curve.addExp({ level: doc.level, exp: doc.exp, prestige: doc.prestige || 0 }, exp);
            Object.assign(doc, identity, {
                leftAt: null, // earning, so on the server
                level: next.level,
                exp: next.exp,
                prestige: next.prestige,
                money: doc.money + money + next.rewards,
                voiceSeconds: doc.voiceSeconds + voiceSeconds,
                messages: doc.messages + messages
            });
            return { reached: next.reached, prestiges: next.prestiges, rewards: next.rewards };
        });
        // Journal the rewards with the balance right after each one
        let balance = result.account.money - result.rewards;
        const rewards = [
            ...result.reached.map(level => ({ amount: curve.levelReward(level), kind: 'level', cause: `Уровень ${level}` })),
            ...Array.from({ length: result.prestiges }, (_, k) => ({
                amount: curve.PRESTIGE_REWARD, kind: 'prestige', cause: `Престиж ★${result.account.prestige - result.prestiges + k + 1}`
            }))
        ];
        const entries = rewards.filter(reward => reward.amount > 0).map(reward => {
            balance += reward.amount;
            return this.transaction(guildId, userId, { ...reward, balance });
        });
        await this.addTransactions(entries);
        return result;
    }

    /**
     * Left the server: the account and its journal move to the anonymous key at once,
     * without the user id and name. Nothing to do without an account.
     */
    async markLeft(guildId, userId) {
        const raw = await this.readRaw(guildId, userId);
        if (!raw) return null;
        const anonId = anonymousId(guildId, userId);
        const doc = {
            ...raw.doc, id: anonId, userId: null, username: null, displayName: null,
            leftAt: raw.doc.leftAt || new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        await this.upsertRaw(doc);
        await this.rekeyTransactions(guildId, userId, anonId);
        await this.removeRaw(guildId, userId);
        return doc;
    }

    /** Ids of the accounts of people counted as on the server. */
    async presentIds(guildId) {
        await this.initialize();
        const { resources } = await this.accounts.items.query({
            query: `SELECT VALUE c.userId FROM c WHERE c.guildId = @guildId AND ${PRESENT}`,
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Came back before the account was deleted: everything is where they left it. */
    async markReturned(guildId, member) {
        const anonId = anonymousId(guildId, member.id);
        const raw = await this.readRaw(guildId, anonId);
        if (!raw) return null;
        // Earned something already since coming back (a fresh account): add it on top
        const fresh = (await this.readRaw(guildId, member.id))?.doc;
        const doc = {
            ...raw.doc, ...identityOf(member), id: member.id, userId: member.id, leftAt: null,
            money: raw.doc.money + (fresh?.money || 0),
            voiceSeconds: (raw.doc.voiceSeconds || 0) + (fresh?.voiceSeconds || 0),
            messages: (raw.doc.messages || 0) + (fresh?.messages || 0),
            updatedAt: new Date().toISOString()
        };
        Object.assign(doc, curve.addExp({ level: doc.level, exp: doc.exp, prestige: doc.prestige || 0 }, fresh?.totalExp || 0));
        delete doc.reached; delete doc.prestiges; delete doc.rewards;
        doc.totalExp = curve.totalOf(doc.level, doc.exp, doc.prestige);
        await this.upsertRaw(doc);
        await this.rekeyTransactions(guildId, anonId, member.id);
        await this.removeRaw(guildId, anonId);
        return doc;
    }

    /** Delete the accounts (and journals) of people away for longer than the retention. */
    async purgeLeft(now = Date.now()) {
        await this.initialize();
        const cutoff = new Date(now - LEFT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { resources } = await this.accounts.items.query({
            query: 'SELECT c.guildId, c.id FROM c WHERE IS_STRING(c.leftAt) AND c.leftAt < @cutoff',
            parameters: [{ name: '@cutoff', value: cutoff }]
        }).fetchAll();
        for (const { guildId, id } of resources) await this.deleteAccount(guildId, id);
        return resources.length;
    }

    /**
     * Give (amount > 0) or take (amount < 0) coins by hand from the app; the
     * balance never goes below zero.
     */
    async adjust(guild, userId, amount, reason, actor, source = 'panel') {
        if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUST) return { ok: false, code: 'invalid_amount' };
        const cause = String(reason || '').trim().slice(0, 200);
        if (!cause) return { ok: false, code: 'invalid_reason' };
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        const existing = await this.get(guild.id, userId);
        if (!member && !existing) return { ok: false, code: 'member_not_found' };

        const result = await this.mutate(guild.id, userId, doc => {
            if (doc.money + amount < 0) return { ok: false, code: 'insufficient_funds' };
            Object.assign(doc, identityOf(member), { money: doc.money + amount });
            return null;
        });
        if (!result.ok) return result;
        await this.addTransactions([this.transaction(guild.id, userId, {
            amount, balance: result.account.money, kind: 'adjust', cause, actorId: actor.id, source
        })]);
        await AuditLogService.log({
            guildId: guild.id, action: amount > 0 ? 'economy.given' : 'economy.taken',
            actorId: actor.id, actorTag: actor.tag, targetIds: [userId], source,
            details: { amount: Math.abs(amount), balance: result.account.money, reason: cause }
        });
        return result;
    }
}

module.exports = new EconomyService();
module.exports.identityOf = identityOf;
module.exports.blankAccount = blankAccount;
module.exports.LEFT_RETENTION_DAYS = LEFT_RETENTION_DAYS;
module.exports.anonymousId = anonymousId;
