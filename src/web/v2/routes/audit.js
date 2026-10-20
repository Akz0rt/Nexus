const express = require('express');
const AuditLogService = require('../../../services/AuditLogService');
const RoleService = require('../../../services/RoleService');
const ModerationService = require('../../../modules/moderation/ModerationService');
const VerificationService = require('../../../modules/verification/VerificationService');
const BoosterPassService = require('../../../modules/boosters/BoosterPassService');
const { actorOf } = require('../result');
const { userRef } = require('../serialize');
const { canSeeEntry } = require('../visibility');

const router = express.Router({ mergeParams: true });

const SOURCES = new Set(['discord', 'bot', 'panel', 'auto']);
const MAX_UNDO_TARGETS = 100;

/**
 * «Отменить» in the journal: what each action is undone with. The services check the
 * permission the action itself needs and whether it can still be undone.
 * @returns {Promise<{ ok, code?, failed? }>}
 */
const UNDO = {
    'moderation.warned': (guild, entry, actor) => (entry.details?.warnId
        ? ModerationService.unwarn(guild, entry.details.warnId, actor, 'panel')
        : { ok: false, code: 'cannot_undo' }),
    'moderation.muted': (guild, entry, actor) => ModerationService.unmute(guild, entry.targetIds[0], actor, 'panel'),
    'moderation.banned': (guild, entry, actor) => ModerationService.unban(guild, entry.targetIds[0], actor, 'panel'),
    'roles.added': (guild, entry, actor) => RoleService.bulkRole(guild, entry.targetIds.slice(0, MAX_UNDO_TARGETS), entry.details?.roleId, false, actor, 'panel'),
    'roles.removed': (guild, entry, actor) => RoleService.bulkRole(guild, entry.targetIds.slice(0, MAX_UNDO_TARGETS), entry.details?.roleId, true, actor, 'panel'),
    'verification.approved': (guild, entry, actor) => VerificationService.undoApprove(guild, entry.targetIds[0], actor, 'panel', { fromJournal: true }),
    'booster.passed': async (guild, entry, actor) => {
        const failed = [];
        for (const userId of entry.targetIds) {
            const result = await BoosterPassService.release(guild, userId, actor);
            // Already released (or gone): nothing left to undo for that one
            if (!result.ok && result.code !== 'pass_not_found') failed.push({ userId, code: result.code });
        }
        return failed.length === entry.targetIds.length ? { ok: false, code: failed[0].code } : { ok: true, failed };
    }
};
const UNDOABLE = new Set(Object.keys(UNDO));

// The state the entry made is gone already: the entry is marked, so the button doesn't stay forever
const OUTDATED = new Set(['warning_not_found', 'not_muted', 'not_banned', 'member_left', 'nothing_to_undo', 'pass_not_found']);
// Per-person actions that a later one of the same kind replaces (an old mute must not lift a newer one)
const SUPERSEDED_BY_LATER = new Set(['moderation.muted', 'moderation.banned', 'verification.approved', 'roles.added', 'roles.removed']);
const SAME_ROLE_ACTIONS = { 'roles.added': ['roles.added', 'roles.removed'], 'roles.removed': ['roles.added', 'roles.removed'] };
const MAX_LATER_CHECKS = 10;

/** Is there a newer entry about the same person (and role) that this undo would trample? */
async function hasNewer(guild, entry) {
    if (!SUPERSEDED_BY_LATER.has(entry.action)) return false;
    const actions = SAME_ROLE_ACTIONS[entry.action] || [entry.action];
    // Big role groups: checking everyone would be a query each; a newer change for them is caught by roleProblem/no-ops
    for (const targetId of entry.targetIds.slice(0, MAX_LATER_CHECKS)) {
        for (const action of actions) {
            const { items } = await AuditLogService.query({ guildId: guild.id, targetId, action, since: entry.createdAt }, { limit: 20 });
            const later = items.find(other => other.id !== entry.id && other.createdAt > entry.createdAt
                && (!SAME_ROLE_ACTIONS[entry.action] || other.details?.roleId === entry.details?.roleId));
            if (later) return true;
        }
    }
    return false;
}

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

// POST /audit/:entryId/undo — «Отменить» from the journal
router.post('/:entryId/undo', async (req, res, next) => {
    try {
        const guild = req.guild;
        const entry = await AuditLogService.get(guild.id, req.params.entryId);
        const viewer = guild.members.cache.get(req.session.userId);
        if (!entry || !canSeeEntry(guild, viewer, entry)) return res.status(404).json({ error: 'entry_not_found' });
        if (!UNDOABLE.has(entry.action) || !(entry.targetIds || []).length) return res.status(400).json({ error: 'cannot_undo' });
        if (entry.undoneAt) return res.status(409).json({ error: 'already_undone' });
        // Big groups (the journal keeps up to 1000 ids of them) are undone from the Roles screen, not one click here
        if (entry.targetIds.length > MAX_UNDO_TARGETS || (entry.details?.count || 0) > entry.targetIds.length) {
            return res.status(409).json({ error: 'too_many_to_undo' });
        }
        if (await hasNewer(guild, entry)) return res.status(409).json({ error: 'newer_action' });
        const actor = actorOf(req);
        const result = await UNDO[entry.action](guild, entry, actor);
        if (!result.ok) {
            const outdated = OUTDATED.has(result.code);
            if (outdated) await AuditLogService.markUndone(entry, actor, { outdated: true });
            return res.status(result.code === 'forbidden' ? 403 : 409).json({ error: result.code, outdated });
        }
        const failed = result.failed || [];
        // A group undone only partly stays undoable for the rest
        if (failed.length === 0) await AuditLogService.markUndone(entry, actor);
        res.json({ ok: true, failed });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.UNDOABLE = UNDOABLE;
