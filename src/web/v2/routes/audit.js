const express = require('express');
const AuditLogService = require('../../../services/AuditLogService');
const { userRef } = require('../serialize');
const { canSeeEntry } = require('../visibility');

const router = express.Router({ mergeParams: true });

const SOURCES = new Set(['discord', 'bot', 'panel', 'auto']);

// GET /audit?action&actorId&targetId&source&since&until&limit&cursor
router.get('/', async (req, res, next) => {
    try {
        const q = req.query;
        if (q.source && !SOURCES.has(q.source)) return res.status(400).json({ error: 'invalid_source' });
        for (const key of ['since', 'until']) {
            if (q[key] && Number.isNaN(Date.parse(q[key]))) return res.status(400).json({ error: `invalid_${key}` });
        }

        const page = await AuditLogService.query({
            guildId: req.guild.id,
            action: q.action,
            actorId: q.actorId,
            targetId: q.targetId,
            source: q.source,
            since: q.since ? new Date(q.since).toISOString() : undefined,
            until: q.until ? new Date(q.until).toISOString() : undefined
        }, { limit: parseInt(q.limit, 10) || 50, cursor: q.cursor });
        // Message texts only from channels the viewer can read (a page may come out shorter)
        const viewer = req.guild.members.cache.get(req.session.userId);
        const items = page.items.filter(entry => canSeeEntry(req.guild, viewer, entry));
        const { cursor } = page;

        // Names for everyone mentioned, so the app doesn't need a request per row
        const ids = new Set();
        for (const entry of items) {
            if (entry.actorId) ids.add(entry.actorId);
            for (const id of entry.targetIds || []) ids.add(id);
        }
        const users = {};
        for (const id of ids) users[id] = userRef(req.guild, id);

        res.json({ items, cursor, users });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
