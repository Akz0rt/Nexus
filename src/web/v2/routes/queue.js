const express = require('express');
const config = require('../../../config');
const VerificationService = require('../../../modules/verification/VerificationService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const InviteTracker = require('../../../modules/invites/InviteTracker');
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
    undo_expired: 409
};

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
                .filter(member => member.roles.cache.has(settings.unverifiedRoleId))
                .map(member => describeMember(member, context));
            const byUser = new Map(cards.map(card => [card.userId, card]));
            const items = mergeQueue(holders, cards).map(item => ({ ...item, invite: inviteOf(guild, byUser.get(item.member.id), item.member.id) }));
            // Roles «Доп. роли…» must not offer: the queue's own
            const reservedRoleIds = [settings.unverifiedRoleId, settings.maleRoleId, settings.femaleRoleId].filter(Boolean);
            return res.json({
                tab,
                items,
                reservedRoleIds,
                counts: {
                    handled: handledToday.filter(card => card.status === 'approved').length,
                    rejected: handledToday.filter(card => card.status === 'kicked').length
                },
                youngAccountDays: context.youngAccountDays,
                invitesTracked: InviteTracker.canTrack(guild.id)
            });
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

module.exports = router;
module.exports.inviteOf = inviteOf;
