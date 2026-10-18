

const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');

const VOICE_ACTIVITY_CONTAINER = 'voice_activity_sessions';
const TTL_35_DAYS = 35 * 24 * 60 * 60; // 3,024,000 seconds

class VoiceActivityService {
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
            id: VOICE_ACTIVITY_CONTAINER,
            partitionKey: { paths: ['/guildId'] },
            defaultTtl: TTL_35_DAYS
        });

        this.container = database.container(VOICE_ACTIVITY_CONTAINER);

        try {
            const { resource: containerDef } = await this.container.read();
            if (containerDef.defaultTtl !== TTL_35_DAYS) {
                await this.container.replace({ ...containerDef, defaultTtl: TTL_35_DAYS });
                console.log('VoiceActivityService: updated TTL on voice_activity_sessions container');
            }
        } catch (e) {
            console.warn('VoiceActivityService: could not patch TTL on voice_activity_sessions container:', e.message);
        }

        this.initialized = true;
    }

    /**
     * Upsert a session document on join (startedAt, no endedAt)
     */
    async upsertSession({ guildId, userId, displayName, avatarURL, startedAt, channelId }) {
        await this.initialize();
        const docId = `${guildId}-${userId}-${startedAt}`;
        await this.container.items.upsert({
            id: docId,
            guildId,
            userId,
            displayName,
            avatarURL,
            startedAt,
            channelId,
            isActive: true,
            createdAt: Date.now(),
            ttl: TTL_35_DAYS
        });
        return docId;
    }

    /**
     * Update session document on leave/switch (set endedAt, durationSeconds, date)
     */
    async updateSession({ guildId, userId, startedAt, endedAt, displayName, avatarURL }) {
        await this.initialize();
        const docId = `${guildId}-${userId}-${startedAt}`;
        const durationSeconds = Math.round((endedAt - startedAt) / 1000);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
        const date = new Date(endedAt).toISOString().split('T')[0];

        let doc = null;
        try {
            const readResult = await this.container.item(docId, guildId).read();
            doc = readResult.resource || null;
        } catch (error) {
            if (error?.code !== 404) throw error;
        }

        if (!doc) {
            doc = {
                id: docId,
                guildId,
                userId,
                startedAt,
                isActive: true,
                createdAt: Date.now(),
                ttl: TTL_35_DAYS
            };
        }

        doc.endedAt = endedAt;
        doc.durationSeconds = durationSeconds;
        doc.date = date;
        doc.isActive = false;
        doc.lastMeasuredAt = endedAt;
        doc.displayName = displayName;
        doc.avatarURL = avatarURL;
        await this.container.items.upsert(doc);
        return true;
    }


    async getTopUsersByRecentWindow(windowMs) {
        await this.initialize();

        const cutoffTs = Date.now() - windowMs;
        const query = `
            SELECT c.userId, c.displayName, c.avatarURL, c.endedAt, c.durationSeconds
            FROM c
            WHERE c.endedAt >= @cutoffTs
        `;

        const { resources } = await this.container.items
            .query({ query, parameters: [{ name: '@cutoffTs', value: cutoffTs }] })
            .fetchAll();

        return this._aggregateUsers(resources || []);
    }

    async getTopUsersByPeriod(periodOrDays = 'week') {
        await this.initialize();

        const cutoffString = this._getCutoffDateString(periodOrDays);
        const query = `
            SELECT c.userId, c.displayName, c.avatarURL, c.endedAt, c.durationSeconds
            FROM c
            WHERE c.date >= @cutoffDate
        `;

        const { resources } = await this.container.items
            .query({ query, parameters: [{ name: '@cutoffDate', value: cutoffString }] })
            .fetchAll();

        return this._aggregateUsers(resources || []);
    }

    /**
     * Voice minutes per day (by the day a session ended) for the last N days.
     * @returns {Promise<Array<{ date: string, minutes: number }>>}
     */
    async getDailyTotals(days = 30) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT c.date, c.durationSeconds FROM c WHERE c.date >= @cutoffDate',
            parameters: [{ name: '@cutoffDate', value: this._getCutoffDateString(days) }]
        }).fetchAll();
        const byDate = new Map();
        for (const { date, durationSeconds } of resources) {
            if (!date) continue;
            byDate.set(date, (byDate.get(date) || 0) + Number(durationSeconds || 0));
        }
        return [...byDate]
            .map(([date, seconds]) => ({ date, minutes: Math.round(seconds / 60) }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    async getPeriodDebugStats(periodOrDays = 'week') {
        await this.initialize();

        const cutoffDate = this._getCutoffDateString(periodOrDays);
        const query = `
            SELECT c.userId, c.durationSeconds
            FROM c
            WHERE c.date >= @cutoffDate
        `;

        const { resources } = await this.container.items
            .query({ query, parameters: [{ name: '@cutoffDate', value: cutoffDate }] })
            .fetchAll();

        const docs = resources.length;
        const distinctUsers = new Set(resources.map(r => r.userId)).size;
        const totalDurationSeconds = resources.reduce((sum, r) => sum + Number(r.durationSeconds || 0), 0);
        const totalMinutes = Math.round(totalDurationSeconds / 60);

        return {
            cutoffDate,
            docs,
            distinctUsers,
            totalDurationSeconds,
            totalMinutes
        };
    }

    _aggregateUsers(resources) {
        const byUser = new Map();

        for (const record of resources) {
            const userId = record.userId;
            if (!userId) continue;

            const prev = byUser.get(userId);
            if (!prev) {
                byUser.set(userId, {
                    userId,
                    displayName: record.displayName || null,
                    avatarURL: record.avatarURL || null,
                    totalDurationSeconds: Number(record.durationSeconds || 0),
                    lastEndedAt: Number(record.endedAt || 0)
                });
                continue;
            }

            prev.totalDurationSeconds += Number(record.durationSeconds || 0);
            if (Number(record.endedAt || 0) >= prev.lastEndedAt) {
                prev.lastEndedAt = Number(record.endedAt || prev.lastEndedAt);
                prev.displayName = record.displayName || prev.displayName;
                prev.avatarURL = record.avatarURL || prev.avatarURL;
            }
        }

        return Array.from(byUser.values())
            .map(user => ({
                userId: user.userId,
                displayName: user.displayName,
                avatarURL: user.avatarURL,
                totalDurationSeconds: user.totalDurationSeconds,
                totalMinutes: Math.round(user.totalDurationSeconds / 60)
            }))
            .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
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
     * Update all active voice sessions with interim measurements (current time as endedAt)
     * Called during activity sync to capture intermediate durations
     */
    async updateAllActiveSessions(activeSessions, guildId) {
        if (!activeSessions || activeSessions.size === 0) return { updated: 0, errors: 0 };

        await this.initialize();
        const now = Date.now();
        const date = new Date(now).toISOString().split('T')[0];
        let updated = 0;
        let errors = 0;

        for (const [key, session] of activeSessions) {
            try {
                const [keyGuildId, userId] = key.split(':');
                if (keyGuildId !== guildId) continue;

                const { startedAt } = session;
                if (!startedAt) continue;

                const durationSeconds = Math.round((now - startedAt) / 1000);
                if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) continue;

                const docId = `${guildId}-${userId}-${startedAt}`;

                try {
                    const readResult = await this.container.item(docId, guildId).read();
                    let doc = readResult.resource || null;

                    if (!doc) {
                        doc = {
                            id: docId,
                            guildId,
                            userId,
                            startedAt,
                            isActive: true,
                            createdAt: Date.now(),
                            ttl: TTL_35_DAYS
                        };
                    }

                    if (doc.isActive !== false) {
                        doc.endedAt = now;
                        doc.durationSeconds = durationSeconds;
                        doc.date = date;
                        doc.lastMeasuredAt = now;
                        doc.isActive = true;
                        await this.container.items.upsert(doc);
                        updated += 1;
                    }
                } catch (readError) {
                    if (readError?.code === 404) {
                        const doc = {
                            id: docId,
                            guildId,
                            userId,
                            startedAt,
                            endedAt: now,
                            durationSeconds,
                            date,
                            lastMeasuredAt: now,
                            isActive: true,
                            createdAt: Date.now(),
                            ttl: TTL_35_DAYS
                        };
                        await this.container.items.upsert(doc);
                        updated += 1;
                    } else {
                        throw readError;
                    }
                }
            } catch (error) {
                console.error(`VoiceActivityService: error updating interim session for ${key}:`, error?.message || error);
                errors += 1;
            }
        }

        return { updated, errors };
    }
}

module.exports = new VoiceActivityService();
