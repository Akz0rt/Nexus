// Polyfill for crypto in Azure App Service when using WEBSITE_RUN_FROM_PACKAGE
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = require('node:crypto').webcrypto;
}

const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const state = require('./state');
const { registerModules, runReadyHooks, findInteractionHandler } = require('./modules');
const { startServer } = require('./server');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        // Privileged: enable "Server Members Intent" in the Developer Portal, otherwise login fails
        GatewayIntentBits.GuildMembers
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

registerModules(client);

client.once(Events.ClientReady, async () => {
    console.log('Discord bot is ready! 🎉');

    // Expose guild to the web dashboard and sync services
    state.guild = client.guilds.cache.first() || null;
    state.client = client;

    await runReadyHooks(client);
});

async function replyWithError(interaction, content) {
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        console.error('Failed to report interaction error:', error.message || error);
    }
}

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            await replyWithError(interaction, 'There was an error executing this command!');
        }
        return;
    }

    // Buttons/modals owned by a module (customId "<prefix>:..."). Anything else —
    // e.g. collectors inside /birthday-set — is handled where it was created.
    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const mod = findInteractionHandler(interaction.customId);
        if (!mod) return;

        try {
            await mod.handleInteraction(interaction);
        } catch (error) {
            console.error(`Module ${mod.name} interaction error:`, error);
            await replyWithError(interaction, 'Не удалось выполнить действие. Подробности в логах бота.');
        }
    }
});

// Start the admin web dashboard (also handles /health for Azure)
const server = startServer();

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
