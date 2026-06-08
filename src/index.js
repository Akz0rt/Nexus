// Polyfill for crypto in Azure App Service when using WEBSITE_RUN_FROM_PACKAGE
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = require('node:crypto').webcrypto;
}

const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const SchedulerService = require('./services/SchedulerService');
const NotificationService = require('./services/NotificationService');
const AIService = require('./services/AIService');
const ActivityService = require('./services/ActivityService');
const ActivitySyncService = require('./services/ActivitySyncService');
const VoiceActivityService = require('./services/VoiceActivityService');
const state = require('./state');
const cron = require('node-cron');
const { startServer } = require('./server');

const activeVoiceSessions = new Map();

function voiceSessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates
        // MessageContent and GuildPresences removed for compatibility with bots lacking privileged intents
    ]
});

// Create a collection for commands
client.commands = new Collection();

// Load commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    client.commands.set(command.data.name, command);
}

client.once(Events.ClientReady, async () => {
    console.log('Discord bot is ready! 🎉');
    
    const fetchChannelById = async (channelId, envName) => {
        if (!channelId) {
            console.warn(`${envName} is not set`);
            return null;
        }

        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased?.()) {
                console.warn(`${envName} (${channelId}) is not a text channel`);
                return null;
            }
            return channel;
        } catch (error) {
            console.error(`Failed to fetch channel for ${envName} (${channelId}):`, error.message || error);
            return null;
        }
    };

    // Fetch channels directly from API to avoid cache-miss on startup
    const announceChannel = await fetchChannelById(config.birthdayChannel, 'BIRTHDAY_CHANNEL_ID');
    const congratsChannel = await fetchChannelById(config.congratsChannel, 'CONGRATS_CHANNEL_ID');

    NotificationService.setChannels(announceChannel, congratsChannel);

    if (announceChannel || congratsChannel) {
        console.log('Notification channels configured successfully');
    } else {
        console.error('No notification channels found. Birthday checks will still run, but messages cannot be sent.');
    }

    // Expose guild to the web dashboard and sync services
    state.guild = client.guilds.cache.first() || null;
    state.client = client;

    // Always start scheduler so daily DB checks are not skipped
    SchedulerService.start();

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

});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ 
                content: 'There was an error executing this command!',
                ephemeral: true 
            });
        } else {
            await interaction.reply({ 
                content: 'There was an error executing this command!',
                ephemeral: true 
            });
        }
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Only respond in the dedicated AI channel — ignore everything else,
    // even direct @mentions. Slash commands are unaffected (handled separately).
    if (!config.aiChannelId || message.channelId !== config.aiChannelId) return;

    let userContent = message.content
        .replace(`<@${client.user.id}>`, '')
        .replace(`<@!${client.user.id}>`, '')
        .trim();

    if (!userContent) {
        await message.reply('Привет! Чем могу помочь?');
        return;
    }

    await message.channel.sendTyping();

    try {
        const member = await message.guild.members.fetch(message.author.id);
        const displayName = member.displayName || message.author.username;

        let authorGender = null;
        if (config.maleRoleId && member.roles.cache.has(config.maleRoleId)) {
            authorGender = 'male';
        } else if (config.femaleRoleId && member.roles.cache.has(config.femaleRoleId)) {
            authorGender = 'female';
        }

        const aiResponse = await AIService.processMessage(
            userContent,
            message.author.id,
            displayName,
            message.channelId,
            message.guild,
            authorGender
        );

        if (aiResponse.length > 2000) {
            const firstChunk = aiResponse.slice(0, 1990);
            const splitAt = firstChunk.lastIndexOf('\n') > 1500
                ? firstChunk.lastIndexOf('\n') : 1990;
            await message.reply(aiResponse.slice(0, splitAt));
            await message.channel.send(aiResponse.slice(splitAt));
        } else {
            await message.reply(aiResponse);
        }
    } catch (error) {
        console.error('Error processing AI message:', error);
        await message.reply('Произошла ошибка, попробуй ещё раз.');
    }
});

// Start the admin web dashboard (also handles /health for Azure)
startServer();

// Global process error handlers to keep the container alive long enough for diagnostics
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', err => {
    console.error('Uncaught Exception thrown:', err);
});

// Discord client error handlers
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.on('warn', info => {
    console.warn('Discord client warning:', info);
});

client.once('shardError', error => {
    console.error('A websocket connection encountered an error:', error);
});

// Log in to Discord (catch failures so the process doesn't crash silently)
client.login(config.token).catch(err => {
    console.error('Failed to login to Discord:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received: shutting down');
    try { await client.destroy(); } catch (e) { console.error(e); }
    server.close(() => process.exit(0));

    // Force exit if shutdown hangs
    setTimeout(() => process.exit(1), 5000).unref();
});

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