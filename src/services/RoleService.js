const { PermissionFlagsBits } = require('discord.js');
const AuditLogService = require('./AuditLogService');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MISSING_PERMISSIONS = 50013;
const MAX_TARGETS = 100;
const CONCURRENCY = 5;

/**
 * Why `actor` may not hand out or take away `role`, or null if they may.
 * Same rules as Discord: not @everyone, not a bot/integration role, below the
 * actor's highest role (the owner may use any) and below the bot's.
 */
function roleProblem(guild, actor, role) {
    if (!role || role.id === guild.id) return 'role_not_found';
    if (role.managed) return 'role_managed';
    if (actor.id !== guild.ownerId && role.position >= actor.roles.highest.position) return 'role_higher';
    if (!role.editable) return 'bot_cannot_role';
    return null;
}

/** Roles a moderator could give from the panel, highest first. */
function assignableRoles(guild, actor) {
    return [...guild.roles.cache.values()]
        .filter(role => !roleProblem(guild, actor, role))
        .sort((a, b) => b.position - a.position)
        .map(role => ({ id: role.id, name: role.name, color: role.hexColor }));
}

/** Give or take one role from many members at once (e.g. "Участник ивента"). */
async function bulkRole(guild, userIds, roleId, add, actor, source) {
    if (!Array.isArray(userIds)) return { ok: false, code: 'invalid_targets' };
    const ids = [...new Set(userIds.map(String))];
    if (ids.length === 0 || ids.length > MAX_TARGETS) return { ok: false, code: 'invalid_targets' };

    const actorMember = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
    if (!actorMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return { ok: false, code: 'forbidden' };
    const role = guild.roles.cache.get(String(roleId));
    const problem = roleProblem(guild, actorMember, role);
    if (problem) return { ok: false, code: problem };

    const reason = `${add ? 'Роль выдана' : 'Роль снята'} · ${actor.tag || actor.id}`;
    const results = [];
    // A few at a time; discord.js waits out per-route rate limits itself
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
        results.push(...await Promise.all(ids.slice(i, i + CONCURRENCY).map(async userId => {
            let member;
            try {
                member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
            } catch (error) {
                if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return { userId, name: null, code: 'member_not_found' };
                throw error;
            }
            if (member.roles.cache.has(role.id) === add) return { userId, name: member.displayName, skipped: true };
            try {
                if (add) await member.roles.add(role, reason);
                else await member.roles.remove(role, reason);
                return { userId, name: member.displayName };
            } catch (error) {
                return { userId, name: member.displayName, code: error.code === MISSING_PERMISSIONS ? 'bot_cannot' : 'failed' };
            }
        })));
    }

    const failed = results.filter(r => r.code).map(({ userId, name, code }) => ({ userId, name, code }));
    const changed = results.filter(r => !r.code && !r.skipped).map(r => r.userId);
    if (changed.length > 0) {
        await AuditLogService.log({
            guildId: guild.id,
            action: add ? 'roles.added' : 'roles.removed',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: changed,
            source,
            details: { roleId: role.id, roleName: role.name, failed: failed.length }
        });
    }
    return { ok: true, done: results.filter(r => !r.code).map(r => r.userId), failed };
}

module.exports = { roleProblem, assignableRoles, bulkRole };
