const express = require('express');
const config = require('../../../config');
const AuditLogService = require('../../../services/AuditLogService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const { startOfToday } = require('../../../utils/dateUtils');
const { userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = { today: null, '7d': 7, '30d': 30 }; // the journal keeps 30 days

/** Which column of the stats table an action counts towards (message.* is the author's own doing). */
const CATEGORIES = {
    'verification.approved': 'approved',
    'verification.kicked': 'rejected',
    'moderation.warned': 'warns',
    'moderation.muted': 'mutes',
    'moderation.kicked': 'kicks',
    'moderation.banned': 'bans',
    'roles.added': 'roles',
    'roles.removed': 'roles',
    'roles.preset_applied': 'roles'
};

function categoryOf(action) {
    if (CATEGORIES[action]) return CATEGORIES[action];
    if (action.startsWith('voice.') && !action.startsWith('voice.squad_')) return 'voice';
    return null;
}

const EMPTY = () => ({ approved: 0, rejected: 0, warns: 0, mutes: 0, kicks: 0, bans: 0, voice: 0, roles: 0, total: 0 });

/**
 * Per-moderator counts from the journal plus queue waiting times from the cards.
 * @param {Array<{ actorId, action, n }>} counts
 * @param {object[]} cards handled queue cards (approved or kicked) in the period
 */
function buildStats(counts, cards) {
    const byActor = new Map();
    const row = id => {
        if (!byActor.has(id)) byActor.set(id, { counts: EMPTY(), waits: [] });
        return byActor.get(id);
    };
    for (const { actorId, action, n } of counts) {
        const category = categoryOf(action);
        if (!category) continue;
        const entry = row(actorId);
        entry.counts[category] += n;
        entry.counts.total += n;
    }
    const waits = [];
    for (const card of cards) {
        const ms = Date.parse(card.handledAt) - Date.parse(card.createdAt);
        if (!Number.isFinite(ms) || ms < 0) continue;
        waits.push(ms);
        if (card.handledBy) row(card.handledBy).waits.push(ms);
    }
    const average = list => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
    const median = list => {
        if (!list.length) return null;
        const sorted = [...list].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    };
    const moderators = [...byActor.entries()]
        .map(([actorId, { counts: c, waits: w }]) => ({ actorId, ...c, decided: w.length, averageWaitMs: average(w) }))
        .sort((a, b) => b.total - a.total || b.decided - a.decided);
    return {
        moderators,
        queue: { decided: waits.length, averageWaitMs: average(waits), medianWaitMs: median(waits) }
    };
}

// GET /stats?period=today|7d|30d
router.get('/', async (req, res, next) => {
    try {
        const period = PERIODS[req.query.period] !== undefined ? req.query.period : '7d';
        const since = period === 'today'
            ? startOfToday(config.timezone).toISOString()
            : new Date(Date.now() - PERIODS[period] * DAY_MS).toISOString();
        const [counts, cards] = await Promise.all([
            AuditLogService.countByActor(req.guild.id, since),
            QueueCardService.listHandled(req.guild.id, ['approved', 'kicked'], since)
        ]);
        const stats = buildStats(counts, cards);
        res.json({
            period,
            since,
            ...stats,
            moderators: stats.moderators.map(m => ({ ...m, user: userRef(req.guild, m.actorId) }))
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.buildStats = buildStats;
