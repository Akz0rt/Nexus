const GuildSettingsService = require('../../services/GuildSettingsService');
const { riskFlags, joinsAround, bannedNames } = require('../../modules/verification/riskFlags');

const RAID_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // a burst of joins long ago is history, not a raid

/**
 * What the risk flags need about the whole server: the young-account threshold,
 * banned names, how many joined around each moment. Built once per request.
 * @param {Map<string, number>} [kickCounts] userId -> kicks from the queue so far
 */
async function flagContext(guild, kickCounts = new Map()) {
    const settings = await GuildSettingsService.get(guild.id);
    const around = joinsAround([...guild.members.cache.values()].map(m => m.joinedTimestamp));
    const now = Date.now();
    return {
        youngAccountDays: settings.verification?.youngAccountDays ?? 7,
        bannedNames: await bannedNames.get(guild),
        kickCounts,
        joinsNear: member => (now - (member.joinedTimestamp || 0) < RAID_LOOKBACK_MS ? around(member.joinedTimestamp) : 0)
    };
}

/**
 * JSON view of a guild member for the desktop app.
 * @param {object} [context] from flagContext(); without it only the per-member flags show
 */
function describeMember(member, context) {
    const ctx = context && typeof context === 'object' ? context : {}; // .map() passes an index here
    return {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        avatarURL: member.user.displayAvatarURL({ size: 128, extension: 'png' }),
        bot: member.user.bot,
        accountCreatedAt: new Date(member.user.createdTimestamp).toISOString(),
        joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        flags: riskFlags(member, {
            youngAccountDays: ctx.youngAccountDays ?? 7,
            bannedNames: ctx.bannedNames,
            kickCount: ctx.kickCounts?.get(member.id) || 0,
            joinsNear: ctx.joinsNear ? ctx.joinsNear(member) : 0
        })
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
        hasDiscordMessage: Boolean(card.messageId),
        kickCount: card.kickCount || 0
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

module.exports = { describeMember, flagContext, userRef, serializeCard, mergeQueue };
