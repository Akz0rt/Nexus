const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const config = require('./config');
const SettingsService = require('./services/SettingsService');
const AzureManagementService = require('./services/AzureManagementService');
const AIService = require('./services/AIService');
const ActivityService = require('./services/ActivityService');
const ActivitySyncService = require('./services/ActivitySyncService');
const VoiceActivityService = require('./services/VoiceActivityService');
const BirthdayService = require('./services/BirthdayService');
const state = require('./state');
const { createV2Router } = require('./web/v2');

const BANNER_MODE_KEY = 'BANNER_MODE';
const ACTIVITY_PERIOD_KEY = 'ACTIVITY_PERIOD';
const ACTIVITY_CALC_MODE_KEY = 'ACTIVITY_CALC_MODE';
const SHOW_GAME_ACTIVITY_KEY = 'SHOW_GAME_ACTIVITY';
const VALID_BANNER_MODES = new Set(['active', 'birthday', 'random', 'none']);
const VALID_ACTIVITY_PERIODS = new Set(['hour', 'day', 'week', 'month']);
const VALID_ACTIVITY_CALC_MODES = new Set(['text', 'voice', 'combined']);

// Names of settings that can be edited via the panel (secrets are read-only)
const EDITABLE_SETTINGS = [
    'CHECK_TIME',
    'TIMEZONE',
    'BIRTHDAY_CHANNEL_ID',
    'CONGRATS_CHANNEL_ID',
    'AI_CHANNEL_ID',
    'MALE_ROLE_ID',
    'FEMALE_ROLE_ID',
    'OPENAI_MODEL',
    'AI_MAX_HISTORY'
];

// Settings to display as masked (sensitive credentials)
const SECRET_SETTINGS = [
    'DISCORD_TOKEN',
    'COSMOS_KEY',
    'OPENAI_API_KEY',
    'ADMIN_PASSWORD'
];

// All settings to display in the panel (editable + read-only informational)
const DISPLAY_SETTINGS = [
    ...EDITABLE_SETTINGS,
    'CLIENT_ID',
    'GUILD_ID',
    'COSMOS_ENDPOINT',
    'COSMOS_DB_NAME',
    ...SECRET_SETTINGS
];

function buildSettingsResponse(dbOverrides) {
    const result = {};
    for (const key of DISPLAY_SETTINGS) {
        if (SECRET_SETTINGS.includes(key)) {
            result[key] = { value: '***', editable: false, secret: true };
        } else {
            const envValue = process.env[key] ?? '';
            const dbValue = dbOverrides[key];
            result[key] = {
                value: dbValue !== undefined ? dbValue : envValue,
                editable: EDITABLE_SETTINGS.includes(key),
                secret: false
            };
        }
    }
    return result;
}

// Simple in-memory rate limiter for /api/chat
const chatRateLimit = {
    counts: new Map(),
    WINDOW_MS: 60 * 1000,  // 1 minute
    MAX_REQUESTS: 10,
    check(ip) {
        const now = Date.now();
        const entry = this.counts.get(ip);
        if (!entry || now - entry.start > this.WINDOW_MS) {
            this.counts.set(ip, { start: now, count: 1 });
            return true;
        }
        if (entry.count >= this.MAX_REQUESTS) return false;
        entry.count++;
        return true;
    }
};

function createApp() {
    const app = express();

    // Desktop panel API — own Discord login, so it goes before the dashboard's Basic Auth
    app.use('/api/v2', createV2Router());

    if (!config.adminPassword) {
        console.error('❌ ADMIN_PASSWORD is not set. Admin dashboard is disabled — set this env var in Azure App Settings.');
        // Serve a safe placeholder on all routes so the container starts successfully
        app.use((req, res) => {
            res.status(503).send(
                '<h2>Admin dashboard is not available.</h2>' +
                '<p>Set the <code>ADMIN_PASSWORD</code> environment variable in Azure App Settings, then restart the bot.</p>'
            );
        });
        return app;
    }

    // Basic Auth — challenge every request
    app.use(basicAuth({
        users: { [config.adminUser]: config.adminPassword },
        challenge: true,
        realm: 'Nexus Admin'
    }));

    app.use(express.json());

    // Serve the dashboard SPA
    app.use(express.static(path.join(__dirname, 'dashboard')));

    // GET /api/settings — return current settings (env + db overrides)
    app.get('/api/settings', async (req, res) => {
        try {
            const dbOverrides = await SettingsService.getSettings();
            res.json(buildSettingsResponse(dbOverrides));
        } catch (err) {
            console.error('GET /api/settings error:', err);
            res.status(500).json({ error: 'Failed to load settings' });
        }
    });

    // POST /api/settings — save to Cosmos DB + Azure App Settings (if Managed Identity configured)
    app.post('/api/settings', async (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};

            for (const key of EDITABLE_SETTINGS) {
                if (Object.prototype.hasOwnProperty.call(body, key)) {
                    const val = String(body[key]).trim();
                    patch[key] = val;
                }
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: 'No valid settings provided' });
            }

            const azureConfigured = AzureManagementService.isConfigured();

            // Always save to Cosmos DB
            await SettingsService.updateSettings(patch);

            if (azureConfigured) {
                // Sync to Azure App Settings and restart
                try {
                    await AzureManagementService.updateAppSettings(patch);
                    await AzureManagementService.restart();
                    return res.json({ ok: true, restarting: true });
                } catch (azureErr) {
                    console.error('Azure Management API error:', azureErr);
                    return res.json({
                        ok: true,
                        restarting: false,
                        warn: 'Saved to database, but failed to update Azure App Settings: ' + (azureErr.message || azureErr)
                    });
                }
            }

            // Azure Management not configured — DB-only save
            res.json({ ok: true, restarting: false, warn: 'Saved to database only. Set AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_WEBAPP_NAME to enable Azure App Settings sync.' });
        } catch (err) {
            console.error('POST /api/settings error:', err);
            res.status(500).json({ error: 'Failed to save settings' });
        }
    });

    // GET /api/guild-info — server "business card": name, icon, banner, invite link
    app.get('/api/guild-info', async (req, res) => {
        if (!state.guild) {
            return res.status(503).json({ error: 'Bot is not connected to Discord yet. Please wait.' });
        }

        try {
            const guild = state.guild;
            await guild.fetch();

            const iconUrl = guild.iconURL({ extension: 'png', forceStatic: false, size: 256 }) || null;
            const bannerUrl = guild.bannerURL({ extension: 'gif', forceStatic: false, size: 1024 })
                || guild.bannerURL({ extension: 'png', forceStatic: false, size: 1024 })
                || null;

            let inviteUrl = null;
            if (guild.vanityURLCode) {
                inviteUrl = `https://discord.gg/${guild.vanityURLCode}`;
            } else {
                try {
                    const invites = await guild.invites.fetch();
                    const first = invites.first();
                    if (first) inviteUrl = `https://discord.gg/${first.code}`;
                } catch {
                    // No permission to read invites — leave null
                }
            }

            res.json({
                name: guild.name,
                iconUrl,
                bannerUrl,
                inviteUrl,
                memberCount: guild.memberCount,
                boostLevel: guild.premiumTier,
                boostCount: guild.premiumSubscriptionCount || 0
            });
        } catch (err) {
            console.error('GET /api/guild-info error:', err);
            res.status(500).json({ error: 'Failed to fetch guild info' });
        }
    });

    // GET /api/server-banner-settings — persisted banner mode/activity period from settings table
    app.get('/api/server-banner-settings', async (req, res) => {
        try {
            const settings = await SettingsService.getSettings();
            const mode = VALID_BANNER_MODES.has(settings[BANNER_MODE_KEY]) ? settings[BANNER_MODE_KEY] : 'active';
            const period = VALID_ACTIVITY_PERIODS.has(settings[ACTIVITY_PERIOD_KEY]) ? settings[ACTIVITY_PERIOD_KEY] : 'week';
            const calcMode = VALID_ACTIVITY_CALC_MODES.has(settings[ACTIVITY_CALC_MODE_KEY]) ? settings[ACTIVITY_CALC_MODE_KEY] : 'text';
            const showGameActivity = String(settings[SHOW_GAME_ACTIVITY_KEY] || '').toLowerCase() === 'true';
            res.json({ mode, period, calcMode, showGameActivity });
        } catch (err) {
            console.error('GET /api/server-banner-settings error:', err);
            res.status(500).json({ error: 'Failed to load server banner settings' });
        }
    });

    // POST /api/server-banner-settings — persist banner mode/activity period to settings table
    app.post('/api/server-banner-settings', async (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};

            if (Object.prototype.hasOwnProperty.call(body, 'mode')) {
                const mode = String(body.mode || '').trim();
                if (!VALID_BANNER_MODES.has(mode)) {
                    return res.status(400).json({ error: 'Invalid mode' });
                }
                patch[BANNER_MODE_KEY] = mode;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'period')) {
                const period = String(body.period || '').trim();
                if (!VALID_ACTIVITY_PERIODS.has(period)) {
                    return res.status(400).json({ error: 'Invalid period' });
                }
                patch[ACTIVITY_PERIOD_KEY] = period;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'calcMode')) {
                const calcMode = String(body.calcMode || '').trim();
                if (!VALID_ACTIVITY_CALC_MODES.has(calcMode)) {
                    return res.status(400).json({ error: 'Invalid calcMode' });
                }
                patch[ACTIVITY_CALC_MODE_KEY] = calcMode;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'showGameActivity')) {
                patch[SHOW_GAME_ACTIVITY_KEY] = Boolean(body.showGameActivity) ? 'true' : 'false';
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: 'No valid banner settings provided' });
            }

            await SettingsService.updateSettings(patch);

            const settings = await SettingsService.getSettings();
            const mode = VALID_BANNER_MODES.has(settings[BANNER_MODE_KEY]) ? settings[BANNER_MODE_KEY] : 'active';
            const period = VALID_ACTIVITY_PERIODS.has(settings[ACTIVITY_PERIOD_KEY]) ? settings[ACTIVITY_PERIOD_KEY] : 'week';
            const calcMode = VALID_ACTIVITY_CALC_MODES.has(settings[ACTIVITY_CALC_MODE_KEY]) ? settings[ACTIVITY_CALC_MODE_KEY] : 'text';
            const showGameActivity = String(settings[SHOW_GAME_ACTIVITY_KEY] || '').toLowerCase() === 'true';
            res.json({ ok: true, mode, period, calcMode, showGameActivity });
        } catch (err) {
            console.error('POST /api/server-banner-settings error:', err);
            res.status(500).json({ error: 'Failed to save server banner settings' });
        }
    });

    // GET /api/featured-user — returns the highlighted user for the server banner overlay
    app.get('/api/featured-user', async (req, res) => {
        if (!state.guild) {
            return res.status(503).json({ error: 'Bot is not connected to Discord yet. Please wait.' });
        }

        let { mode = 'active', period = 'week', calcMode, showGameActivity } = req.query;
        if (!VALID_ACTIVITY_PERIODS.has(period)) period = 'week';

        if (!VALID_ACTIVITY_CALC_MODES.has(calcMode)) {
            const settings = await SettingsService.getSettings();
            calcMode = VALID_ACTIVITY_CALC_MODES.has(settings[ACTIVITY_CALC_MODE_KEY]) ? settings[ACTIVITY_CALC_MODE_KEY] : 'text';
            if (showGameActivity === undefined) {
                showGameActivity = String(settings[SHOW_GAME_ACTIVITY_KEY] || '').toLowerCase() === 'true';
            }
        }

        if (showGameActivity !== true && showGameActivity !== false) {
            showGameActivity = String(showGameActivity || '').toLowerCase() === 'true';
        }

        let resolvedMode = mode;
        let resolvedPeriod = period;

        if (mode === 'random') {
            const modes = ['active', 'birthday'];
            resolvedMode = modes[Math.floor(Math.random() * modes.length)];
            if (resolvedMode === 'active') {
                const periods = ['hour', 'day', 'week', 'month'];
                resolvedPeriod = periods[Math.floor(Math.random() * periods.length)];
            }
        }

        try {
            if (resolvedMode === 'birthday') {
                const userIds = await BirthdayService.getTodaysBirthdays();
                if (!userIds.length) return res.json({ found: false, reason: 'no_birthdays' });

                const userId = userIds[Math.floor(Math.random() * userIds.length)];
                try {
                    const member = await state.guild.members.fetch(userId);
                    return res.json({
                        found: true,
                        resolvedMode,
                        user: {
                            displayName: member.displayName,
                            avatarURL: member.user.displayAvatarURL({ size: 128, extension: 'png' }),
                            stat: '🎂 Сегодня именинник!'
                        }
                    });
                } catch {
                    return res.json({ found: false, reason: 'member_not_found' });
                }
            }

            if (resolvedMode === 'active') {
                const periodLabel = { hour: 'час', day: 'день', week: 'неделю', month: 'месяц' }[resolvedPeriod] ?? 'неделю';
                const syncIntervalMs = {
                    hour: 30 * 60 * 1000,
                    day: 60 * 60 * 1000,
                    week: 24 * 60 * 60 * 1000,
                    month: 7 * 24 * 60 * 60 * 1000
                }[resolvedPeriod] ?? 60 * 60 * 1000;

                try {
                    const status = await ActivitySyncService.getStatus();
                    const lastSuccessTs = status?.lastSuccessAt ? Date.parse(status.lastSuccessAt) : NaN;
                    const isStale = Number.isNaN(lastSuccessTs) || (Date.now() - lastSuccessTs >= syncIntervalMs);
                    if (isStale && state.guild) {
                        const syncResult = await ActivitySyncService.run(state.guild, `on-demand:${resolvedPeriod}`);
                        if (!syncResult?.skipped) {
                            console.log('Activity sync (on-demand):', { period: resolvedPeriod, ...syncResult });
                        }
                    }
                } catch (syncErr) {
                    console.warn('On-demand activity sync failed:', syncErr?.message || syncErr);
                }

                const textTopUsers = resolvedPeriod === 'hour'
                    ? await ActivityService.getTopUsersByRecentWindow(60 * 60 * 1000)
                    : await ActivityService.getTopUsersByPeriod(resolvedPeriod);
                const voiceTopUsers = resolvedPeriod === 'hour'
                    ? await VoiceActivityService.getTopUsersByRecentWindow(60 * 60 * 1000)
                    : await VoiceActivityService.getTopUsersByPeriod(resolvedPeriod);

                let selectedUser = null;
                let stat = '';

                if (calcMode === 'text') {
                    const top = textTopUsers[0];
                    if (top) {
                        selectedUser = { ...top };
                        stat = `💬 ${top.totalMessages} сообщений за ${periodLabel}`;
                    }
                } else if (calcMode === 'voice') {
                    const top = voiceTopUsers[0];
                    if (top) {
                        selectedUser = { ...top };
                        stat = `🔊 ${top.totalMinutes} мин в голосе за ${periodLabel}`;
                    }
                } else {
                    const merged = new Map();

                    for (const row of textTopUsers || []) {
                        merged.set(row.userId, {
                            userId: row.userId,
                            displayName: row.displayName || null,
                            avatarURL: row.avatarURL || null,
                            totalMessages: Number(row.totalMessages || 0),
                            totalMinutes: 0,
                            score: 0
                        });
                    }

                    for (const row of voiceTopUsers || []) {
                        const prev = merged.get(row.userId) || {
                            userId: row.userId,
                            displayName: row.displayName || null,
                            avatarURL: row.avatarURL || null,
                            totalMessages: 0,
                            totalMinutes: 0,
                            score: 0
                        };
                        prev.displayName = prev.displayName || row.displayName || null;
                        prev.avatarURL = prev.avatarURL || row.avatarURL || null;
                        prev.totalMinutes += Number(row.totalMinutes || 0);
                        prev.score += Number(row.totalMinutes || 0);
                        merged.set(row.userId, prev);
                    }

                    for (const row of merged.values()) {
                        row.score += Number(row.totalMessages || 0);
                    }

                    const ranked = Array.from(merged.values()).sort((a, b) => b.score - a.score);
                    const top = ranked[0];
                    if (top) {
                        selectedUser = { ...top };
                        stat = `🧮 ${top.totalMessages} сообщ., ${top.totalMinutes} мин за ${periodLabel}`;
                    }
                }

                if (!selectedUser) {
                    const [textDebug, voiceDebug] = await Promise.all([
                        ActivityService.getPeriodDebugStats(resolvedPeriod),
                        VoiceActivityService.getPeriodDebugStats(resolvedPeriod)
                    ]);
                    const debug = { text: textDebug, voice: voiceDebug, calcMode };
                    console.warn('featured-user no_activity debug:', { period: resolvedPeriod, ...debug });
                    return res.json({ found: false, reason: 'no_activity', debug });
                }

                const topUser = { ...selectedUser };
                if (topUser.userId && state.guild && (showGameActivity || !topUser.displayName || !topUser.avatarURL)) {
                    try {
                        const member = await state.guild.members.fetch(topUser.userId);
                        topUser.displayName = topUser.displayName || member.displayName;
                        topUser.avatarURL = topUser.avatarURL || member.user.displayAvatarURL({ size: 128, extension: 'png' });

                        if (showGameActivity) {
                            const game = member.presence?.activities?.find(a => a.type === 0) || member.presence?.activities?.[0];
                            if (game?.name) {
                                stat += ` • 🎮 ${game.name}`;
                            }
                        }
                    } catch {
                        topUser.displayName = topUser.displayName || `User ${topUser.userId}`;
                    }
                }

                return res.json({
                    found: true,
                    resolvedMode,
                    resolvedPeriod,
                    calcMode,
                    showGameActivity,
                    user: {
                        displayName: topUser.displayName,
                        avatarURL: topUser.avatarURL,
                        stat
                    }
                });
            }

            return res.status(400).json({ error: 'Unknown mode' });
        } catch (err) {
            console.error('GET /api/featured-user error:', err);
            const details = err?.message || String(err);
            res.status(500).json({ error: `Failed to fetch featured user: ${details}` });
        }
    });

    // GET /api/activity-sync-status — sync health and freshness
    app.get('/api/activity-sync-status', async (req, res) => {
        try {
            const status = await ActivitySyncService.getStatus();
            res.json(status);
        } catch (err) {
            console.error('GET /api/activity-sync-status error:', err);
            res.status(500).json({ error: 'Failed to fetch activity sync status' });
        }
    });

    // GET /api/activity-debug — container counters for activity troubleshooting
    app.get('/api/activity-debug', async (req, res) => {
        try {
            const period = String(req.query.period || 'week');
            const debug = await ActivityService.getPeriodDebugStats(period);
            res.json({ period, ...debug });
        } catch (err) {
            console.error('GET /api/activity-debug error:', err);
            res.status(500).json({ error: 'Failed to fetch activity debug stats' });
        }
    });

    // POST /api/chat — send a message to the AI (web user, shared AI_CHANNEL_ID history)
    app.post('/api/chat', async (req, res) => {
        try {
            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            if (!chatRateLimit.check(ip)) {
                return res.status(429).json({ error: 'Too many requests. Max 10 messages per minute.' });
            }

            const message = String(req.body?.message || '').trim();
            if (!message) {
                return res.status(400).json({ error: 'message is required' });
            }

            if (!state.guild) {
                return res.status(503).json({ error: 'Bot is not connected to Discord yet. Please wait.' });
            }

            const channelId = config.aiChannelId || 'web-admin';
            const reply = await AIService.processMessage(
                message,
                'web-admin',
                config.adminUser,
                `web-${channelId}`,
                state.guild,
                null
            );

            res.json({ reply });
        } catch (err) {
            console.error('POST /api/chat error:', err);
            res.status(500).json({ error: 'AI processing failed. Check server logs.' });
        }
    });

    // Fallback — serve the SPA for any unknown route (Express 5 compatible)
    app.use((req, res) => {
        res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });

    return app;
}

function startServer() {
    const app = createApp();
    const port = config.port;

    return app.listen(port, () => {
        console.log(`🌐 Admin dashboard listening on port ${port}`);
    });
}

module.exports = { startServer, createApp };
