const { computeFlags } = require('../../modules/verification/card');

/** JSON view of a guild member for the desktop app. */
function describeMember(member) {
    return {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        avatarURL: member.user.displayAvatarURL({ size: 128, extension: 'png' }),
        bot: member.user.bot,
        accountCreatedAt: new Date(member.user.createdTimestamp).toISOString(),
        joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        flags: computeFlags(member)
    };
}

/** Minimal { id, displayName, avatarURL } for ids shown in lists (from the member cache). */
function userRef(guild, userId) {
    if (!userId) return null;
    const member = guild.members.cache.get(userId);
    return {
        id: userId,
        displayName: member?.displayName || null,
        avatarURL: member ? member.user.displayAvatarURL({ size: 64, extension: 'png' }) : null
    };
}

function serializeCard(card) {
    if (!card) return null;
    return {
        status: card.status,
        gender: card.gender || null,
        reason: card.reason || null,
        createdAt: card.createdAt || null,
        handledBy: card.handledBy || null,
        handledAt: card.handledAt || null,
        hasDiscordMessage: Boolean(card.messageId)
    };
}

/**
 * The waiting queue = members currently holding @unverified (Discord is the source
 * of truth), joined with their card when one exists. Oldest join first.
 * @param {Array<{ id: string, joinedAt: string|null }>} holders described members
 * @param {object[]} cards queue_cards documents
 */
function mergeQueue(holders, cards) {
    const byUser = new Map(cards.map(card => [card.userId, card]));
    return holders
        .filter(member => !member.bot)
        .map(member => {
            const card = byUser.get(member.id);
            return { member, card: card?.status === 'pending' ? serializeCard(card) : null };
        })
        .sort((a, b) => String(a.member.joinedAt || '').localeCompare(String(b.member.joinedAt || '')));
}

module.exports = { describeMember, userRef, serializeCard, mergeQueue };
