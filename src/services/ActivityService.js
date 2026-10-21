const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');

const ACTIVITY_CONTAINER = 'activity';
const ACTIVITY_MESSAGES_CONTAINER = 'activity_messages';
const TTL_35_DAYS = 35 * 24 * 60 * 60; // 3,024,000 seconds

class ActivityService {
    constructor() {
        this.client = null;
        this.container = null;
        this.messagesContainer = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);

        // Create activity containers if they don't exist, then ensure TTL is set.
        // container.replace() is needed because createIfNotExists skips existing containers.
        await database.containers.createIfNotExists({
            id: ACTIVITY_CONTAINER,
            partitionKey: { paths: ['/userId'] },
            defaultTtl: TTL_35_DAYS
        });

        await database.containers.createIfNotExists({
            id: ACTIVITY_MESSAGES_CONTAINER,
            partitionKey: { paths: ['/channelId'] },
            defaultTtl: TTL_35_DAYS
        });

        this.container = database.container(ACTIVITY_CONTAINER);
        this.messagesContainer = database.container(ACTIVITY_MESSAGES_CONTAINER);

        // Patch TTL on existing containers that were created before TTL was introduced.
        try {
            const { resource: actDef } = await this.container.read();
            if (actDef.defaultTtl !== TTL_35_DAYS) {
                await this.container.replace({ ...actDef, defaultTtl: TTL_35_DAYS });
                console.log('ActivityService: updated TTL on activity container');
            }
        } catch (e) {
            console.warn('ActivityService: could not patch TTL on activity container:', e.message);
        }

        try {
            const { resource: msgDef } = await this.messagesContainer.read();
            if (msgDef.defaultTtl !== TTL_35_DAYS) {
                await this.messagesContainer.replace({ ...msgDef, defaultTtl: TTL_35_DAYS });
                console.log('ActivityService: updated TTL on activity_messages container');
            }
        } catch (e) {
            console.warn('ActivityService: could not patch TTL on activity_messages container:', e.message);
        }
        this.initialized = true;
    }

    /**
     * Record activity for a message id. Returns false when the same message was already counted.
     * Every server counts on its own: one document per server, member and day.
     * @param {{ guildId: string, userId: string, displayName: string, avatarURL: string|null, messageId?: string, channelId?: string, timestamp?: number }} params
     * @returns {Promise<boolean>}
     */
    async recordMessageById(params) {
        if (!params.guildId) throw new Error('recordMessageById: guildId is required');
        await this.initialize();

        const timestamp = params.timestamp || Date.now();
        const date = new Date(timestamp).toISOString().split('T')[0];
        const docId = `${params.guildId}-${params.userId}-${date}`;

        if (params.messageId && params.channelId) {
            const dedupInserted = await this._insertDedupMessage({
                guildId: params.guildId,
                channelId: params.channelId,
                messageId: params.messageId,
                userId: params.userId,
                date
            });

            if (!dedupInserted) {
                return false;
            }
        }

        try {
            const { resource } = await this.container.item(docId, params.userId).read();
            const base = resource || {
                id: docId,
                guildId: params.guildId,
                userId: params.userId,
                date,
                displayName: params.displayName,
                avatarURL: params.avatarURL,
                messageCount: 0,
                lastMessageTime: timestamp
            };

            base.messageCount = (base.messageCount || 0) + 1;
            base.lastMessageTime = timestamp;
            base.displayName = params.displayName;
            base.avatarURL = params.avatarURL;
            base.ttl = TTL_35_DAYS;

            delete base._rid;
            delete base._self;
            delete base._etag;
            delete base._attachments;
            delete base._ts;

            await this.container.items.upsert(base);
            return true;
        } catch (error) {
            if (error.code === 404) {
                const newRecord = {
                    id: docId,
                    guildId: params.guildId,
                    userId: params.userId,
                    date,
                    displayName: params.displayName,
                    avatarURL: params.avatarURL,
                    messageCount: 1,
                    lastMessageTime: timestamp,
                    ttl: TTL_35_DAYS
                };

                await this.container.items.create(newRecord);
                return true;
            }

            console.error('ActivityService.recordMessageById error:', error);
            throw error;
        }
    }

    async _insertDedupMessage({ guildId, channelId, messageId, userId, date }) {
        try {
            await this.messagesContainer.items.create({
                id: `${channelId}-${messageId}`,
                guildId,
                channelId,
                messageId,
                userId,
                date,
                createdAt: Date.now(),
                ttl: TTL_35_DAYS
            });
            return true;
        } catch (error) {
            if (error.code === 409) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Get top active users of a server for a period
     * @param {string} guildId
     * @param {number|string} periodOrDays - Number of days or period key: day|week|month
     * @returns {Array} Array of { userId, displayName, avatarURL, messageCount }
     */
    async getTopUsersByPeriod(guildId, periodOrDays = 'week') {
        await this.initialize();
        const cutoffString = this._getCutoffDateString(periodOrDays);

        try {
            const query = `
                SELECT c.userId, c.displayName, c.avatarURL, c.messageCount, c.lastMessageTime
                FROM c
                WHERE c.guildId = @guildId AND c.date >= @cutoffDate
            `;

            const { resources } = await this.container.items
                .query({ query, parameters: [{ name: '@guildId', value: guildId }, { name: '@cutoffDate', value: cutoffString }] })
                .fetchAll();

            const aggregated = this._aggregateTopUsers(resources);
            if (aggregated.length > 0) return aggregated;

            return this._getTopUsersFromDedup(guildId, cutoffString);
        } catch (error) {
            console.error('ActivityService.getTopUsersByPeriod error:', error?.message || error);
            throw error;
        }
    }

    /**
     * Messages per day of a server for the last N days (for the server chart), summed here
     * rather than with GROUP BY. Days without messages are missing.
     * @returns {Promise<Array<{ date: string, messages: number }>>}
     */
    async getDailyTotals(guildId, days = 30) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT c.date, c.messageCount FROM c WHERE c.guildId = @guildId AND c.date >= @cutoffDate',
            parameters: [{ name: '@guildId', value: guildId }, { name: '@cutoffDate', value: this._getCutoffDateString(days) }]
        }).fetchAll();
        const byDate = new Map();
        for (const { date, messageCount } of resources) byDate.set(date, (byDate.get(date) || 0) + Number(messageCount || 0));
        return [...byDate].map(([date, messages]) => ({ date, messages })).sort((a, b) => a.date.localeCompare(b.date));
    }

    /** When the member last wrote on this server (kept 35 days), or null */
    async lastMessageAt(guildId, userId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT TOP 1 c.lastMessageTime FROM c WHERE c.userId = @userId AND c.guildId = @guildId ORDER BY c.date DESC',
            parameters: [{ name: '@userId', value: userId }, { name: '@guildId', value: guildId }]
        }, { partitionKey: userId }).fetchAll();
        const at = resources[0]?.lastMessageTime;
        return at ? new Date(at).toISOString() : null;
    }

    _getCutoffDateString(periodOrDays) {
        const now = new Date();

        if (typeof periodOrDays === 'number' && Number.isFinite(periodOrDays)) {
            const cutoff = new Date(now);
            cutoff.setDate(cutoff.getDate() - periodOrDays);
            return cutoff.toISOString().split('T')[0];
        }

        const period = String(periodOrDays || 'week');
        const cutoff = new Date(now);

        if (period === 'day') {
            cutoff.setDate(cutoff.getDate() - 1);
        } else if (period === 'week') {
            cutoff.setDate(cutoff.getDate() - 7);
        } else if (period === 'month') {
            cutoff.setMonth(cutoff.getMonth() - 1);
        } else {
            cutoff.setDate(cutoff.getDate() - 7);
        }

        return cutoff.toISOString().split('T')[0];
    }

    /**
     * Get top users of a server for an exact recent time window using per-message dedup docs.
     * @param {string} guildId
     * @param {number} windowMs
     * @returns {Promise<Array<{userId:string, displayName:null, avatarURL:null, totalMessages:number}>>}
     */
    async getTopUsersByRecentWindow(guildId, windowMs) {
        await this.initialize();

        const cutoffTs = Date.now() - windowMs;
        const query = `
            SELECT c.userId
            FROM c
            WHERE c.guildId = @guildId AND c.createdAt >= @cutoffTs
        `;

        const { resources } = await this.messagesContainer.items
            .query({ query, parameters: [{ name: '@guildId', value: guildId }, { name: '@cutoffTs', value: cutoffTs }] })
            .fetchAll();

        if (!resources || resources.length === 0) {
            return [];
        }

        const byUser = new Map();
        for (const row of resources) {
            byUser.set(row.userId, (byUser.get(row.userId) || 0) + 1);
        }

        return Array.from(byUser.entries())
            .map(([userId, totalMessages]) => ({
                userId,
                displayName: null,
                avatarURL: null,
                totalMessages
            }))
            .sort((a, b) => b.totalMessages - a.totalMessages);
    }

    _aggregateTopUsers(resources) {
        const byUser = new Map();
        for (const row of resources || []) {
            const prev = byUser.get(row.userId);
            if (!prev) {
                byUser.set(row.userId, {
                    userId: row.userId,
                    displayName: row.displayName,
                    avatarURL: row.avatarURL,
                    totalMessages: row.messageCount || 0,
                    lastMessageTime: row.lastMessageTime || 0
                });
                continue;
            }

            prev.totalMessages += row.messageCount || 0;
            if ((row.lastMessageTime || 0) >= (prev.lastMessageTime || 0)) {
                prev.lastMessageTime = row.lastMessageTime || prev.lastMessageTime;
                prev.displayName = row.displayName || prev.displayName;
                prev.avatarURL = row.avatarURL || prev.avatarURL;
            }
        }

        return Array.from(byUser.values()).sort((a, b) => b.totalMessages - a.totalMessages);
    }

    async _getTopUsersFromDedup(guildId, cutoffString) {
        const dedupQuery = `
            SELECT c.userId
            FROM c
            WHERE c.guildId = @guildId AND c.date >= @cutoffDate
        `;

        const { resources } = await this.messagesContainer.items
            .query({ query: dedupQuery, parameters: [{ name: '@guildId', value: guildId }, { name: '@cutoffDate', value: cutoffString }] })
            .fetchAll();

        if (!resources || resources.length === 0) {
            return [];
        }

        const byUser = new Map();
        for (const row of resources) {
            byUser.set(row.userId, (byUser.get(row.userId) || 0) + 1);
        }

        return Array.from(byUser.entries())
            .map(([userId, totalMessages]) => ({
                userId,
                displayName: null,
                avatarURL: null,
                totalMessages
            }))
            .sort((a, b) => b.totalMessages - a.totalMessages);
    }

    async getPeriodDebugStats(guildId, periodOrDays = 'week') {
        await this.initialize();
        const cutoffString = this._getCutoffDateString(periodOrDays);

        let resolvedDays = null;
        if (typeof periodOrDays === 'number' && Number.isFinite(periodOrDays)) {
            resolvedDays = periodOrDays;
        } else {
            resolvedDays = { day: 1, week: 7, month: 30 }[String(periodOrDays)] ?? 7;
        }

        const activityQuery = `
            SELECT c.userId, c.messageCount
            FROM c
            WHERE c.guildId = @guildId AND c.date >= @cutoffDate
        `;

        const dedupQuery = `
            SELECT c.userId
            FROM c
            WHERE c.guildId = @guildId AND c.date >= @cutoffDate
        `;

        const parameters = [{ name: '@guildId', value: guildId }, { name: '@cutoffDate', value: cutoffString }];
        const [{ resources: activityRows }, { resources: dedupRows }] = await Promise.all([
            this.container.items.query({ query: activityQuery, parameters }).fetchAll(),
            this.messagesContainer.items.query({ query: dedupQuery, parameters }).fetchAll()
        ]);

        const activityUsers = new Set();
        let totalActivityMessages = 0;
        for (const row of activityRows) {
            if (row.userId) activityUsers.add(row.userId);
            totalActivityMessages += Number(row.messageCount || 0);
        }

        const dedupUsers = new Set();
        for (const row of dedupRows) {
            if (row.userId) dedupUsers.add(row.userId);
        }

        return {
            days: resolvedDays,
            cutoffDate: cutoffString,
            activityDocs: activityRows.length,
            dedupDocs: dedupRows.length,
            distinctUsersFromActivity: activityUsers.size,
            distinctUsersFromDedup: dedupUsers.size,
            totalActivityMessages
        };
    }

    /**
     * Counts collected before servers were told apart carry no server; they go to the server
     * they were collected from (chosen by the activity module). Safe to repeat: only
     * unassigned documents are touched. Per-message dedup docs aren't touched: they expire
     * in 35 days and only back a fallback.
     * @param {string|null} target the server, or null when it can't be told (nothing is guessed)
     */
    async migrateLegacy(target) {
        await this.initialize();
        const { resources } = await this.container.items
            .query('SELECT c.id, c.userId FROM c WHERE NOT IS_DEFINED(c.guildId)')
            .fetchAll();
        if (resources.length === 0) return { migrated: 0 };

        if (!target) {
            console.warn(`ActivityService: ${resources.length} old activity record(s) left unassigned — the server they came from is unclear (shown nowhere until they expire)`);
            return { migrated: 0, skipped: resources.length };
        }

        let migrated = 0;
        for (const doc of resources) {
            try {
                await this.container.item(doc.id, doc.userId).patch([{ op: 'add', path: '/guildId', value: target }]);
                migrated++;
            } catch (error) {
                if (error.code !== 404) console.error(`ActivityService: migrating ${doc.id} failed:`, error.message || error);
            }
        }
        console.log(`ActivityService: assigned ${migrated} old activity record(s) to ${target}`);
        return { migrated };
    }

    /**
     * Clean up activity records older than 30 days
     */
    async cleanupOldData() {
        await this.initialize();

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 30);
        const cutoffString = cutoffDate.toISOString().split('T')[0];

        try {
            const query = `SELECT c.id, c.userId FROM c WHERE c.date < @cutoffDate`;

            const { resources } = await this.container.items
                .query({ query, parameters: [{ name: '@cutoffDate', value: cutoffString }] })
                .fetchAll();

            for (const doc of resources) {
                await this.container.item(doc.id, doc.userId).delete();
            }

            const dedupQuery = `SELECT c.id, c.channelId FROM c WHERE c.date < @cutoffDate`;
            const { resources: dedupResources } = await this.messagesContainer.items
                .query({ query: dedupQuery, parameters: [{ name: '@cutoffDate', value: cutoffString }] })
                .fetchAll();

            for (const doc of dedupResources) {
                await this.messagesContainer.item(doc.id, doc.channelId).delete();
            }

            console.log(`ActivityService: cleaned up ${resources.length} activity and ${dedupResources.length} dedup records`);
        } catch (error) {
            console.error('ActivityService.cleanupOldData error:', error);
            // Don't throw - cleanup is not critical
        }
    }
}

module.exports = new ActivityService();
