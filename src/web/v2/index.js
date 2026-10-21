const express = require('express');
const PanelSessionService = require('../../services/PanelSessionService');
const { createAuthRouter, isConfigured, bearerToken, publicUser } = require('./auth');
const { requireGuildAccess } = require('./access');
const { SseHub } = require('./events');
const { userRef } = require('./serialize');

/**
 * API for the desktop panel app, mounted at /api/v2 — independent of the old
 * Basic-Auth web dashboard. Auth: "Authorization: Bearer <session token>".
 */
function createV2Router({ hub = new SseHub().attach() } = {}) {
    const router = express.Router();
    router.use(express.json({ limit: '100kb' }));

    // Logging out closes that session's live streams at once
    router.use('/auth', createAuthRouter(undefined, { onLogout: token => hub.closeSession(token) }));

    // Everything below requires a session
    router.use(async (req, res, next) => {
        try {
            if (!isConfigured()) return res.status(503).json({ error: 'not_configured' });
            const session = await PanelSessionService.get(bearerToken(req));
            if (!session) return res.status(401).json({ error: 'unauthorized' });
            req.session = session;
            next();
        } catch (error) {
            next(error);
        }
    });

    router.get('/me', (req, res) => res.json({ user: publicUser(req.session) }));
    router.use('/guilds', require('./routes/guilds'));

    const guildRouter = express.Router({ mergeParams: true });
    guildRouter.use('/queue', require('./routes/queue'));
    guildRouter.use('/audit', require('./routes/audit'));
    guildRouter.use('/members', require('./routes/members'));
    guildRouter.use('/moderation', require('./routes/moderation'));
    guildRouter.use('/voice', require('./routes/voice'));
    guildRouter.use('/roles', require('./routes/roles'));
    guildRouter.use('/overview', require('./routes/overview'));
    guildRouter.use('/stats', require('./routes/stats'));
    guildRouter.use('/lockdown', require('./routes/lockdown'));
    guildRouter.use('/reports', require('./routes/reports'));
    // Not /events: that path is the live stream
    guildRouter.use('/meetups', require('./routes/events'));
    guildRouter.use('/birthdays', require('./routes/birthdays'));
    guildRouter.use('/activity', require('./routes/activity'));
    guildRouter.use('/economy', require('./routes/economy'));
    guildRouter.use('/tasks', require('./routes/tasks'));
    // Settings and the server banner: administrators ("senior") only
    const seniorOnly = (req, res, next) => (req.panelRole === 'senior'
        ? next()
        : res.status(403).json({ error: 'forbidden' }));
    guildRouter.use('/settings', seniorOnly, require('./routes/settings'));
    guildRouter.use('/banner', seniorOnly, require('./routes/banner'));
    guildRouter.get('/events', (req, res) => {
        const ref = userRef(req.guild, req.session.userId);
        hub.subscribe(req.guild.id, res, {
            id: req.session.userId,
            displayName: ref.displayName || req.session.globalName || req.session.username,
            avatarURL: ref.avatarURL
        }, bearerToken(req));
    });
    // Which member card this moderator has open ({ userId } or { userId: null }): «Смотрит Kira» for the others
    guildRouter.post('/presence/viewing', (req, res) => {
        const target = req.body?.userId ? String(req.body.userId) : null;
        if (target && !/^\d{17,20}$/.test(target)) return res.status(400).json({ error: 'invalid_user_id' });
        hub.setViewing(req.guild.id, req.session.userId, target);
        res.json({ ok: true });
    });
    router.use('/guilds/:guildId', requireGuildAccess('admin'), guildRouter);

    router.use((req, res) => res.status(404).json({ error: 'not_found' }));

    // eslint-disable-next-line no-unused-vars
    router.use((error, req, res, next) => {
        console.error(`API v2 ${req.method} ${req.originalUrl} error:`, error);
        if (res.headersSent) return;
        const status = error.type === 'entity.parse.failed' ? 400 : 500;
        res.status(status).json({ error: status === 400 ? 'invalid_json' : 'internal_error' });
    });

    return router;
}

module.exports = { createV2Router };
