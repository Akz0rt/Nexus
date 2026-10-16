const { Events } = require('discord.js');
const cron = require('node-cron');
const config = require('../../config');
const ActivityService = require('../../services/ActivityService');
const ActivitySyncService = require('../../services/ActivitySyncService');
const VoiceActivityService = require('../../services/VoiceActivityService');
const state = require('../../state');

const activeVoiceSessions = new Map();

function voiceSessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

module.exports = {
    name: 'activity',

    register(client) {
        client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
            try {
                const user = newState.member?.user || oldState.member?.user;
                if (!user || user.bot) return;

                const guildId = newState.guild?.id || oldState.guild?.id;
                const userId = user.id;
                if (!guildId || !userId) return;

                const oldChannelId = oldState.channelId;
                const newChannelId = newState.channelId;
                const key = voiceSessionKey(guildId, userId);
                const now = Date.now();


                // User joins a voice channel
                if (!oldChannelId && newChannelId) {
                    activeVoiceSessions.set(key, { startedAt: now, channelId: newChannelId });
                    const member = newState.member || oldState.member;
                    await VoiceActivityService.upsertSession({
                        guildId,
                        userId,
                        displayName: member?.displayName || user.username,
                        avatarURL: user.displayAvatarURL({ size: 128, extension: 'png' }),
                        startedAt: now,
                        channelId: newChannelId
                    });
                    return;
                }


                // User leaves a voice channel
                if (oldChannelId && !newChannelId) {
                    const session = activeVoiceSessions.get(key);
                    activeVoiceSessions.delete(key);
                    if (!session?.startedAt) return;
                    const member = newState.member || oldState.member;
                    await VoiceActivityService.updateSession({
                        guildId,
                        userId,
                        startedAt: session.startedAt,
                        endedAt: now,
                        displayName: member?.displayName || user.username,
                        avatarURL: user.displayAvatarURL({ size: 128, extension: 'png' })
                    });
                    return;
                }

                // User switches voice channel
                if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
                    const session = activeVoiceSessions.get(key);
                    const member = newState.member || oldState.member;
                    if (session?.startedAt) {
                        await VoiceActivityService.updateSession({
                            guildId,
                            userId,
                            startedAt: session.startedAt,
                            endedAt: now,
                            displayName: member?.displayName || user.username,
                            avatarURL: user.displayAvatarURL({ size: 128, extension: 'png' })
                        });
                    }
                    activeVoiceSessions.set(key, { startedAt: now, channelId: newChannelId });
                    await VoiceActivityService.upsertSession({
                        guildId,
                        userId,
                        displayName: member?.displayName || user.username,
                        avatarURL: user.displayAvatarURL({ size: 128, extension: 'png' }),
                        startedAt: now,
                        channelId: newChannelId
                    });
                }
            } catch (error) {
                console.error('VoiceStateUpdate handling error:', error?.message || error);
            }
        });
    },

    async onReady() {
        // Run activity sync immediately after startup
        if (state.guild) {
            try {
                ActivitySyncService.setActiveVoiceSessions(activeVoiceSessions);
                const startupSync = await ActivitySyncService.run(state.guild, 'startup');
                console.log('Activity sync (startup):', startupSync);
            } catch (err) {
                console.error('Activity startup sync error:', err.message || err);
            }
        }

        // Periodic activity sync from Discord message history
        const interval = Math.max(1, Math.min(59, config.activitySyncIntervalMinutes || 5));
        cron.schedule(`*/${interval} * * * *`, async () => {
            if (!state.guild) return;
            try {
                ActivitySyncService.setActiveVoiceSessions(activeVoiceSessions);
                const periodicSync = await ActivitySyncService.run(state.guild, 'scheduled');
                if (!periodicSync.skipped) {
                    console.log('Activity sync (scheduled):', periodicSync);
                }
            } catch (err) {
                console.error('Activity scheduled sync error:', err.message || err);
            }
        });

        // Clean up old activity data (older than 30 days) — run daily at midnight UTC
        cron.schedule('0 0 * * *', async () => {
            try {
                await ActivityService.cleanupOldData();
            } catch (err) {
                console.error('Activity cleanup error:', err.message);
            }
        });
    }
};
