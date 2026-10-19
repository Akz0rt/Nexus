const express = require('express');
const config = require('../../../config');
const VerificationService = require('../../../modules/verification/VerificationService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const InviteTracker = require('../../../modules/invites/InviteTracker');
const BoosterPassService = require('../../../modules/boosters/BoosterPassService');
const { startOfToday } = require('../../../utils/dateUtils');
const { describeMember, flagContext, userRef, serializeCard, mergeQueue } = require('../serialize');

/** «@Lev» / vanity link / unknown, from the card or (just joined) the tracker's memory */
function inviteOf(guild, card, userId) {
    const invite = card?.invite || InviteTracker.joinOf(guild.id, userId);
    if (!invite) return null;
    return { code: invite.code || null, vanity: Boolean(invite.vanity), inviter: invite.inviterId ? userRef(guild, invite.inviterId) : null };
}

const router = express.Router({ mergeParams: true });

const RESULT_STATUS = {
    not_configured: 409,
    forbidden: 403,
    in_progress: 409,
    member_left: 410,
    already_handled: 409,
    nothing_to_undo: 409,
    undo_expired: 409,
    invalid_term: 400,
    invalid_targets: 400,
    pass_not_found: 404,
    bot_cannot_role: 409,
    bot_cannot: 409
};

/** In the queue: holds @unverified and isn't a booster account (those keep @unverified to see nothing) */
function inQueue(member, settings) {
    return member.roles.cache.has(settings.unverifiedRoleId) && !(settings.boosterRoleId && member.roles.cache.has(settings.boosterRoleId));
}

/** Booster accounts on a term, plus holders of the marker role without one (given by hand) */
async function describeBoosters(guild, settings) {
    const passes = await BoosterPassService.list(guild.id);
    const seen = new Set(passes.map(pass => pass.userId));
    const rows = passes.map(pass => ({ pass, member: guild.members.cache.get(pass.userId) || null }));
    if (settings.boosterRoleId) {
        for (const member of guild.members.cache.values()) {
            if (!seen.has(member.id) && member.roles.cache.has(settings.boosterRoleId)) rows.push({ pass: null, member });
        }
    }
    return rows.map(({ pass, member }) => ({
        member: member ? describeMember(member) : { id: pass.userId, displayName: null, avatarURL: null, flags: [] },
        boostingSince: member?.premiumSince ? member.premiumSince.toISOString() : null,
        until: pass?.until || null,
        note: pass?.note || null,
        createdBy: userRef(guild, pass?.createdBy),
        createdAt: pass?.createdAt || null
    }));
}

function sendResult(res, guild, result) {
    if (result.ok) return res.json({ ok: true, card: serializeCard(result.card), skippedRoles: result.skippedRoles || [] });
    res.status(RESULT_STATUS[result.code] || 400).json({
        error: result.code,
        card: serializeCard(result.card),
        handledBy: userRef(guild, result.card?.handledBy)
    });
}

// GET /queue?tab=waiting|handled|rejected
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const settings = await VerificationService.getQueueSettings(guild.id);
        if (!settings) return res.status(409).json({ error: 'not_configured' });

        const tab = String(req.query.tab || 'waiting');

        if (tab === 'waiting') {
            // Member cache is complete (startup fetch + GuildMembers intent); fetch once if not
            if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();
            const since = startOfToday(config.timezone).toISOString();
            const [cards, handledToday] = await Promise.all([
                QueueCardService.listPending(guild.id),
                QueueCardService.listHandled(guild.id, ['approved', 'kicked'], since)
            ]);
            const context = await flagContext(guild, new Map(cards.map(card => [card.userId, card.kickCount || 0])));
            const holders = guild.members.cache
                .filter(member => inQueue(member, settings))
                .map(member => describeMember(member, context));
            const byUser = new Map(cards.map(card => [card.userId, card]));
            const items = mergeQueue(holders, cards).map(item => ({ ...item, invite: inviteOf(guild, byUser.get(item.member.id), item.member.id) }));
            // Roles «Доп. роли…» must not offer: the queue's own
            const reservedRoleIds = [settings.unverifiedRoleId, settings.maleRoleId, settings.femaleRoleId, settings.boosterRoleId].filter(Boolean);
            const boosters = await BoosterPassService.list(guild.id).catch(() => []);
            return res.json({
                tab,
                items,
                reservedRoleIds,
                counts: {
                    handled: handledToday.filter(card => card.status === 'approved').length,
                    rejected: handledToday.filter(card => card.status === 'kicked').length,
                    boosters: boosters.length
                },
                youngAccountDays: context.youngAccountDays,
                invitesTracked: InviteTracker.canTrack(guild.id)
            });
        }

        if (tab === 'boosters') {
            if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();
            return res.json({ tab, items: await describeBoosters(guild, settings), boosterRoleId: settings.boosterRoleId });
        }

        if (tab === 'handled' || tab === 'rejected') {
            const statuses = tab === 'handled' ? ['approved'] : ['kicked'];
            const since = startOfToday(config.timezone).toISOString();
            const cards = await QueueCardService.listHandled(guild.id, statuses, since);
            const items = cards.map(card => {
                const member = guild.members.cache.get(card.userId);
                return {
                    member: member ? describeMember(member) : { id: card.userId, displayName: null, avatarURL: null },
                    card: serializeCard(card),
                    handledBy: userRef(guild, card.handledBy)
                };
            });
            return res.json({ tab, since, items });
        }

        res.status(400).json({ error: 'invalid_tab' });
    } catch (error) {
        next(error);
    }
});

function actorOf(req) {
    return { id: req.session.userId, tag: req.session.username };
}

// POST /queue/:userId/approve { gender: 'male'|'female', roleIds?: extra roles (preset or picked) }
router.post('/:userId/approve', async (req, res, next) => {
    try {
        const gender = req.body?.gender;
        if (gender !== 'male' && gender !== 'female') return res.status(400).json({ error: 'invalid_gender' });
        const extraRoleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map(String).slice(0, 25) : [];
        const result = await VerificationService.approve(req.guild, req.params.userId, gender, actorOf(req), 'panel', { extraRoleIds });
        sendResult(res, req.guild, result);
    } catch (error) {
        next(error);
    }
});

// POST /queue/:userId/undo — revert own approval within the undo window
router.post('/:userId/undo', async (req, res, next) => {
    try {
        const result = await VerificationService.undoApprove(req.guild, req.params.userId, actorOf(req), 'panel');
        sendResult(res, req.guild, result);
    } catch (error) {
        next(error);
    }
});

// POST /queue/:userId/kick { reason }
router.post('/:userId/kick', async (req, res, next) => {
    try {
        const reason = String(req.body?.reason || '').trim().slice(0, 400);
        if (!reason) return res.status(400).json({ error: 'reason_required' });
        const result = await VerificationService.kick(req.guild, req.params.userId, reason, actorOf(req), 'panel');
        sendResult(res, req.guild, result);
    } catch (error) {
        next(error);
    }
});

// POST /queue/boosters { userIds, until, note? } — booster accounts on a term, from the queue
router.post('/boosters', async (req, res, next) => {
    try {
        const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
        const result = await BoosterPassService.pass(req.guild, userIds, { until: req.body?.until, note: req.body?.note }, actorOf(req), 'panel');
        if (!result.ok) return res.status(RESULT_STATUS[result.code] || 400).json({ error: result.code });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

const boosterAction = run => async (req, res, next) => {
    try {
        const result = await run(req, actorOf(req));
        if (!result.ok) return res.status(RESULT_STATUS[result.code] || 400).json({ error: result.code });
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

// POST /queue/boosters/:userId/extend { until } · /release · /kick
router.post('/boosters/:userId/extend', boosterAction((req, actor) => BoosterPassService.extend(req.guild, req.params.userId, req.body?.until, actor)));
router.post('/boosters/:userId/release', boosterAction((req, actor) => BoosterPassService.release(req.guild, req.params.userId, actor)));
router.post('/boosters/:userId/kick', boosterAction((req, actor) => BoosterPassService.kickNow(req.guild, req.params.userId, actor)));

module.exports = router;
module.exports.inviteOf = inviteOf;
module.exports.inQueue = inQueue;
