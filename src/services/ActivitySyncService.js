const { ChannelType, PermissionsBitField } = require('discord.js');
const ActivityService = require('./ActivityService');
const SyncMetadataService = require('./SyncMetadataService');
const VoiceActivityService = require('./VoiceActivityService');
const config = require('../config');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

class ActivitySyncService {
    constructor() {
        this.running = new Set(); // guildIds being synced: servers sync side by side, each once at a time
        this.activeVoiceSessions = null;
    }

    setActiveVoiceSessions(sessions) {
        this.activeVoiceSessions = sessions;
    }

    async run(guild, reason = 'scheduled') {
        if (!guild) {
            return { skipped: true, reason: 'no_guild' };
        }

        if (this.running.has(guild.id)) {
            return { skipped: true, reason: 'already_running' };
        }

        this.running.add(guild.id);
        const runStartedAt = new Date().toISOString();
        let channelsProcessed = 0;
        let messagesProcessed = 0;
        let duplicatesSkipped = 0;
        let errorsCount = 0;

        try {
            await SyncMetadataService.upsertSummary(guild.id, {
                lastRunAt: runStartedAt,
                isRunning: true,
                runReason: reason
            });

            const channels = guild.channels.cache.filter(ch => this._isTrackedChannel(ch));

            for (const channel of channels.values()) {
                try {
                    const result = await this._syncChannel(channel, guild.id);
                    channelsProcessed += 1;
                    messagesProcessed += result.processed;
                    duplicatesSkipped += result.duplicates;
                } catch (error) {
                    errorsCount += 1;
                    await this._setChannelError(channel, guild.id, error);
                }
            }

            // Update interim voice activity measurements
            if (this.activeVoiceSessions) {
                try {
                    const voiceUpdate = await VoiceActivityService.updateAllActiveSessions(
                        this.activeVoiceSessions,
                        guild.id
                    );
                    if (voiceUpdate.updated > 0) {
                        console.log(`Voice activity: updated ${voiceUpdate.updated} interim sessions`);
                    }
                } catch (voiceErr) {
                    console.error('Activity sync: error updating interim voice sessions:', voiceErr?.message || voiceErr);
                }
            }

            await SyncMetadataService.upsertSummary(guild.id, {
                lastRunAt: runStartedAt,
                lastSuccessAt: new Date().toISOString(),
                isRunning: false,
                runReason: reason,
                channelsProcessed,
                messagesProcessed,
                duplicatesSkipped,
                errorsCount,
                error: null
            });

            return {
                skipped: false,
                channelsProcessed,
                messagesProcessed,
                duplicatesSkipped,
                errorsCount
            };
        } catch (error) {
            await SyncMetadataService.upsertSummary(guild.id, {
                lastRunAt: runStartedAt,
                isRunning: false,
                runReason: reason,
                channelsProcessed,
                messagesProcessed,
                duplicatesSkipped,
                errorsCount,
                error: error.message || String(error)
            });
            throw error;
        } finally {
            this.running.delete(guild.id);
        }
    }

    async getStatus(guildId) {
        const summary = await SyncMetadataService.getSummary(guildId);
        return {
            isRunning: Boolean(summary?.isRunning),
            lastRunAt: summary?.lastRunAt || null,
            lastSuccessAt: summary?.lastSuccessAt || null,
            channelsProcessed: summary?.channelsProcessed || 0,
            messagesProcessed: summary?.messagesProcessed || 0,
            duplicatesSkipped: summary?.duplicatesSkipped || 0,
            errorsCount: summary?.errorsCount || 0,
            error: summary?.error || null
        };
    }

    _isTrackedChannel(channel) {
        if (!channel) return false;
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;

        const permissions = channel.permissionsFor(channel.client.user?.id);
        if (!permissions) return false;

        return permissions.has(PermissionsBitField.Flags.ViewChannel)
            && permissions.has(PermissionsBitField.Flags.ReadMessageHistory);
    }

    async _syncChannel(channel, guildId) {
        const state = await SyncMetadataService.getChannelState(channel.id) || {
            channelId: channel.id,
            guildId,
            channelName: channel.name,
            lastProcessedMessageId: null,
            backfillBeforeMessageId: null,
            backfillComplete: false,
            lastSyncAt: null,
            lastError: null
        };

        const now = Date.now();
        const cutoffTs = now - (config.activityBackfillDays * ONE_DAY_MS);

        let processed = 0;
        let duplicates = 0;

        if (!state.backfillComplete) {
            const backfill = await this._runBackfill(channel, state, cutoffTs);
            processed += backfill.processed;
            duplicates += backfill.duplicates;
        }

        if (state.backfillComplete) {
            const incremental = await this._runIncremental(channel, state);
            processed += incremental.processed;
            duplicates += incremental.duplicates;
        }

        state.channelName = channel.name;
        state.lastSyncAt = new Date().toISOString();
        state.lastError = null;
        state.processedInLastRun = processed;
        state.skippedDuplicatesInLastRun = duplicates;

        await SyncMetadataService.upsertChannelState(state);
        return { processed, duplicates };
    }

    async _runBackfill(channel, state, cutoffTs) {
        let pages = 0;
        let processed = 0;
        let duplicates = 0;
        let before = state.backfillBeforeMessageId || undefined;
        let foundWithinWindow = false;

        while (pages < config.activityBackfillPagesPerRun) {
            const batch = await channel.messages.fetch({ limit: 100, before });
            if (!batch.size) {
                state.backfillComplete = true;
                state.backfillBeforeMessageId = null;
                break;
            }

            const messages = Array.from(batch.values());
            if (!state.lastProcessedMessageId && messages[0]) {
                state.lastProcessedMessageId = messages[0].id;
            }

            for (const msg of messages) {
                if (!this._isTrackableMessage(msg)) continue;
                if (msg.createdTimestamp < cutoffTs) {
                    state.backfillComplete = true;
                    state.backfillBeforeMessageId = null;
                    break;
                }

                foundWithinWindow = true;
                const ok = await ActivityService.recordMessageById({
                    guildId: channel.guild.id,
                    userId: msg.author.id,
                    displayName: msg.member?.displayName || msg.author.username,
                    avatarURL: msg.author.displayAvatarURL({ size: 128, extension: 'png' }),
                    messageId: msg.id,
                    channelId: msg.channelId,
                    timestamp: msg.createdTimestamp
                });

                if (ok) processed += 1;
                else duplicates += 1;
            }

            if (state.backfillComplete) break;

            const oldest = messages[messages.length - 1];
            before = oldest.id;
            state.backfillBeforeMessageId = before;
            pages += 1;
        }

        if (!foundWithinWindow && pages < config.activityBackfillPagesPerRun && !before) {
            state.backfillComplete = true;
            state.backfillBeforeMessageId = null;
        }

        return { processed, duplicates };
    }

    async _runIncremental(channel, state) {
        let pages = 0;
        let processed = 0;
        let duplicates = 0;
        let after = state.lastProcessedMessageId || undefined;

        while (pages < config.activityIncrementalPagesPerRun) {
            const options = { limit: 100 };
            if (after) options.after = after;

            const batch = await channel.messages.fetch(options);
            if (!batch.size) break;

            const messagesAsc = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            for (const msg of messagesAsc) {
                if (!this._isTrackableMessage(msg)) continue;

                const ok = await ActivityService.recordMessageById({
                    guildId: channel.guild.id,
                    userId: msg.author.id,
                    displayName: msg.member?.displayName || msg.author.username,
                    avatarURL: msg.author.displayAvatarURL({ size: 128, extension: 'png' }),
                    messageId: msg.id,
                    channelId: msg.channelId,
                    timestamp: msg.createdTimestamp
                });

                if (ok) processed += 1;
                else duplicates += 1;
            }

            after = messagesAsc[messagesAsc.length - 1].id;
            state.lastProcessedMessageId = after;
            pages += 1;
        }

        return { processed, duplicates };
    }

    _isTrackableMessage(msg) {
        if (!msg) return false;
        if (!msg.guild) return false;
        if (!msg.author) return false;
        if (msg.author.bot) return false;
        if (msg.system) return false;
        return true;
    }

    async _setChannelError(channel, guildId, error) {
        const state = await SyncMetadataService.getChannelState(channel.id) || {
            channelId: channel.id,
            guildId,
            channelName: channel.name,
            lastProcessedMessageId: null,
            backfillBeforeMessageId: null,
            backfillComplete: false,
            lastSyncAt: null
        };

        state.lastError = `${new Date().toISOString()} ${error.message || error}`;
        await SyncMetadataService.upsertChannelState(state);
    }
}

module.exports = new ActivitySyncService();
