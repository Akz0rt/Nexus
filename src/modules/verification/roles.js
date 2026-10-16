/**
 * Pure helpers for the verification queue — no Discord/Cosmos access, easy to test.
 */

/**
 * Build the full role list for a single roles.set call:
 * every current role (managed ones included) minus @unverified and the opposite
 * gender role, plus the target gender role.
 * @param {Iterable<string>} currentRoleIds
 * @param {{ unverifiedId: string, maleId: string, femaleId: string }} roleIds
 * @param {'male'|'female'} gender
 * @returns {string[]}
 */
function computeNewRoles(currentRoleIds, { unverifiedId, maleId, femaleId }, gender) {
    if (gender !== 'male' && gender !== 'female') {
        throw new Error(`Unknown gender: ${gender}`);
    }
    const targetId = gender === 'male' ? maleId : femaleId;
    const oppositeId = gender === 'male' ? femaleId : maleId;
    if (!targetId) throw new Error(`Role for ${gender} is not configured`);

    const result = new Set(currentRoleIds);
    result.delete(unverifiedId);
    if (oppositeId) result.delete(oppositeId);
    result.add(targetId);
    return [...result];
}

/**
 * Did the @unverified role appear or disappear between two member snapshots?
 * Accepts discord.js GuildMember objects or anything with roles.cache.has().
 * @returns {'added'|'removed'|null}
 */
function diffUnverified(oldMember, newMember, unverifiedId) {
    if (!unverifiedId) return null;
    // A partial old member has no reliable role list — treat as unknown
    if (!oldMember || oldMember.partial) return null;

    const had = oldMember.roles.cache.has(unverifiedId);
    const has = newMember.roles.cache.has(unverifiedId);
    if (!had && has) return 'added';
    if (had && !has) return 'removed';
    return null;
}

/**
 * Should the bot give @unverified to a newly joined member?
 * No if it's a bot, the member already has @unverified (e.g. from a third-party bot),
 * or already has a gender role (verified by hand in the meantime).
 * @returns {boolean}
 */
function shouldAssignUnverified(member, { unverifiedId, maleId, femaleId }) {
    if (!unverifiedId || member.user.bot) return false;
    const has = id => Boolean(id) && member.roles.cache.has(id);
    return !has(unverifiedId) && !has(maleId) && !has(femaleId);
}

module.exports = { computeNewRoles, diffUnverified, shouldAssignUnverified };
