const { PermissionFlagsBits } = require('discord.js');
const AuditLogService = require('./AuditLogService');
const TempRoleService = require('../modules/roles/TempRoleService');
const PresetService = require('../modules/roles/PresetService');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MISSING_PERMISSIONS = 50013;
const MAX_TARGETS = 100;
const CONCURRENCY = 5;
const HOUR_MS = 60 * 60 * 1000;

/** How long a temporary role lasts; absent = for good. */
const ROLE_DURATIONS = {
    '1h': HOUR_MS,
    '6h': 6 * HOUR_MS,
    '1d': 24 * HOUR_MS,
    '7d': 7 * 24 * HOUR_MS,
    '30d': 30 * 24 * HOUR_MS
};

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

/** Every role but @everyone, highest first, with who may hand it out. */
function describeRoles(guild, viewer) {
    return [...guild.roles.cache.values()]
        .filter(role => role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(role => ({
            id: role.id,
            name: role.name,
            color: role.hexColor,
            memberCount: role.members?.size ?? 0,
            managed: Boolean(role.managed),
            problem: viewer ? roleProblem(guild, viewer, role) : 'forbidden'
        }));
}

async function fetchActor(guild, actor) {
    const member = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
    return member?.permissions.has(PermissionFlagsBits.ManageRoles) ? member : null;
}

async function fetchMember(guild, userId) {
    try {
        return guild.members.cache.get(userId) || await guild.members.fetch(userId);
    } catch (error) {
        if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return null;
        throw error;
    }
}

/**
 * Give or take one role from one member. With expiresAt the role is temporary:
 * refused if the member already holds it for good (the expiry would take a
 * permanent role away), extended if it's already temporary. Giving it for good
 * makes a temporary role permanent.
 * @returns {Promise<{ userId, name, code?, skipped?, extended? }>}
 */
async function changeMemberRole(guild, userId, role, add, { reason, actor, expiresAt = null }) {
    const member = await fetchMember(guild, userId);
    if (!member) return { userId, name: null, code: 'member_not_found' };
    const name = member.displayName;
    const has = member.roles.cache.has(role.id);
    const temporary = TempRoleService.has(guild.id, userId, role.id);

    try {
        if (add) {
            if (has && expiresAt) {
                const grant = temporary ? await TempRoleService.get(guild.id, userId, role.id) : null;
                if (!grant) return { userId, name, code: 'has_permanent' };
                await TempRoleService.set({ ...grant, expiresAt, actorId: actor.id, actorTag: actor.tag || null });
                return { userId, name, extended: true };
            }
            if (has) {
                if (!temporary) return { userId, name, skipped: true };
                await TempRoleService.remove(guild.id, userId, role.id);
                return { userId, name };
            }
            await member.roles.add(role, reason);
            if (expiresAt) {
                await TempRoleService.set({
                    guildId: guild.id, userId, roleId: role.id, roleName: role.name,
                    expiresAt, actorId: actor.id, actorTag: actor.tag || null
                });
            }
            return { userId, name };
        }

        if (!has) {
            if (temporary) await TempRoleService.remove(guild.id, userId, role.id);
            return { userId, name, skipped: true };
        }
        await member.roles.remove(role, reason);
        if (temporary) await TempRoleService.remove(guild.id, userId, role.id);
        return { userId, name };
    } catch (error) {
        if (error.code === MISSING_PERMISSIONS) return { userId, name, code: 'bot_cannot' };
        if (error.code === UNKNOWN_MEMBER) return { userId, name, code: 'member_not_found' };
        console.error(`RoleService: role change for ${userId} failed:`, error.message || error);
        return { userId, name, code: 'failed' };
    }
}

/** Run fn over items a few at a time; discord.js waits out per-route rate limits itself. */
async function mapLimit(items, fn, onEach) {
    const results = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
        const chunk = await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
        results.push(...chunk);
        onEach?.(results);
    }
    return results;
}

function expiryOf(duration) {
    if (!duration) return { ok: true, expiresAt: null, durationMs: null };
    const durationMs = ROLE_DURATIONS[duration];
    if (!durationMs) return { ok: false, code: 'invalid_duration' };
    return { ok: true, expiresAt: new Date(Date.now() + durationMs).toISOString(), durationMs };
}

function roleReason(add, actor, durationMs) {
    const verb = add ? (durationMs ? 'Временная роль выдана' : 'Роль выдана') : 'Роль снята';
    return `${verb} · ${actor.tag || actor.id}`;
}

/** Summary + one journal entry for a finished group role change. */
async function finishBulk(guild, results, role, add, actor, source, { durationMs = null, expiresAt = null, total } = {}) {
    const failed = results.filter(r => r.code).map(({ userId, name, code }) => ({ userId, name, code }));
    const changed = results.filter(r => !r.code && !r.skipped).map(r => r.userId);
    if (changed.length > 0) {
        await AuditLogService.log({
            guildId: guild.id,
            action: add ? 'roles.added' : 'roles.removed',
            actorId: actor.id,
            actorTag: actor.tag,
            // Big jobs keep the first thousand ids; the count says how many there were
            targetIds: changed.slice(0, 1000),
            source,
            details: {
                roleId: role.id,
                roleName: role.name,
                count: changed.length,
                failed: failed.length,
                ...(durationMs ? { durationMs, expiresAt } : {}),
                ...(total ? { total } : {})
            }
        });
    }
    return { ok: true, done: results.filter(r => !r.code).map(r => r.userId), failed };
}

/**
 * Check actor and role for a group change.
 * @returns {Promise<{ ok: true, role, actorMember } | { ok: false, code }>}
 */
async function authorizeRole(guild, roleId, actor) {
    const actorMember = await fetchActor(guild, actor);
    if (!actorMember) return { ok: false, code: 'forbidden' };
    const role = guild.roles.cache.get(String(roleId));
    const problem = roleProblem(guild, actorMember, role);
    if (problem) return { ok: false, code: problem };
    return { ok: true, role, actorMember };
}

/** Give or take one role from up to 100 members at once (e.g. "Участник ивента"). */
async function bulkRole(guild, userIds, roleId, add, actor, source, { duration = null } = {}) {
    if (!Array.isArray(userIds)) return { ok: false, code: 'invalid_targets' };
    const ids = [...new Set(userIds.map(String))];
    if (ids.length === 0 || ids.length > MAX_TARGETS) return { ok: false, code: 'invalid_targets' };

    const expiry = expiryOf(add ? duration : null);
    if (!expiry.ok) return expiry;
    const auth = await authorizeRole(guild, roleId, actor);
    if (!auth.ok) return auth;

    const reason = roleReason(add, actor, expiry.durationMs);
    const results = await mapLimit(ids, userId =>
        changeMemberRole(guild, userId, auth.role, add, { reason, actor, expiresAt: expiry.expiresAt }));
    return finishBulk(guild, results, auth.role, add, actor, source, expiry);
}

/**
 * Split preset/extra role ids into the ones `actorMember` may give now and the rest.
 * Checked at use time: a role may have been deleted or moved above the bot since.
 */
function sortRoles(guild, actorMember, roleIds) {
    const valid = [];
    const skipped = [];
    for (const roleId of new Set((roleIds || []).map(String))) {
        const role = guild.roles.cache.get(roleId);
        const problem = roleProblem(guild, actorMember, role);
        if (problem) skipped.push({ id: roleId, name: role?.name || null, code: problem });
        else valid.push(role);
    }
    return { valid, skipped };
}

/** Give a member every role of a preset in one request. */
async function applyPreset(guild, userId, presetId, actor, source) {
    const actorMember = await fetchActor(guild, actor);
    if (!actorMember) return { ok: false, code: 'forbidden' };
    const preset = await PresetService.get(guild.id, String(presetId));
    if (!preset) return { ok: false, code: 'preset_not_found' };
    const member = await fetchMember(guild, String(userId));
    if (!member) return { ok: false, code: 'member_not_found' };

    const { valid, skipped } = sortRoles(guild, actorMember, preset.roleIds);
    const missing = valid.filter(role => !member.roles.cache.has(role.id));
    if (missing.length > 0) {
        try {
            await member.roles.add(missing.map(role => role.id), `Пресет «${preset.name}» · ${actor.tag || actor.id}`);
        } catch (error) {
            if (error.code === MISSING_PERMISSIONS) return { ok: false, code: 'bot_cannot' };
            throw error;
        }
        await AuditLogService.log({
            guildId: guild.id,
            action: 'roles.preset_applied',
            actorId: actor.id,
            actorTag: actor.tag,
            targetIds: [member.id],
            source,
            details: { presetId: preset.id, presetName: preset.name, roleNames: missing.map(role => role.name), skipped: skipped.length }
        });
    }
    return { ok: true, added: missing.map(role => role.name), skipped };
}

/** Create (no id) or replace a preset; every role in it must be one the actor may give. */
async function savePreset(guild, { id = null, name, roleIds }, actor, source) {
    const actorMember = await fetchActor(guild, actor);
    if (!actorMember) return { ok: false, code: 'forbidden' };
    const title = String(name || '').trim().slice(0, 60);
    if (!title) return { ok: false, code: 'invalid_name' };
    if (!Array.isArray(roleIds) || roleIds.length === 0 || roleIds.length > 25) return { ok: false, code: 'invalid_roles' };
    const { valid, skipped } = sortRoles(guild, actorMember, roleIds);
    if (skipped.length > 0) return { ok: false, code: skipped[0].code };
    if (id && !(await PresetService.get(guild.id, String(id)))) return { ok: false, code: 'preset_not_found' };

    const preset = await PresetService.save({
        id: id ? String(id) : undefined,
        guildId: guild.id,
        name: title,
        roleIds: valid.map(role => role.id),
        actorId: actor.id
    });
    await AuditLogService.log({
        guildId: guild.id,
        action: 'roles.preset_saved',
        actorId: actor.id,
        actorTag: actor.tag,
        source,
        details: { presetId: preset.id, presetName: preset.name, roleNames: valid.map(role => role.name) }
    });
    return { ok: true, preset };
}

async function deletePreset(guild, presetId, actor, source) {
    const actorMember = await fetchActor(guild, actor);
    if (!actorMember) return { ok: false, code: 'forbidden' };
    const preset = await PresetService.get(guild.id, String(presetId));
    if (!preset) return { ok: false, code: 'preset_not_found' };
    await PresetService.remove(guild.id, preset.id);
    await AuditLogService.log({
        guildId: guild.id,
        action: 'roles.preset_deleted',
        actorId: actor.id,
        actorTag: actor.tag,
        source,
        details: { presetId: preset.id, presetName: preset.name }
    });
    return { ok: true };
}

/**
 * Members a mass change would touch: everyone, holders of a role, or the people
 * in a voice channel (bots never), minus those already in the wanted state.
 * @param {{ type: 'all'|'role'|'voice'|'users', id?: string, userIds?: string[] }} filter
 * @returns {{ ok: true, userIds: string[] } | { ok: false, code }}
 */
function resolveTargets(guild, filter, role, add) {
    let members;
    switch (filter?.type) {
        case 'all':
            members = [...guild.members.cache.values()];
            break;
        case 'role': {
            const source = guild.roles.cache.get(String(filter.id));
            if (!source) return { ok: false, code: 'role_not_found' };
            members = [...guild.members.cache.values()].filter(member => member.roles.cache.has(source.id));
            break;
        }
        case 'voice': {
            const channel = guild.channels.cache.get(String(filter.id));
            if (!channel?.members) return { ok: false, code: 'channel_not_found' };
            members = [...channel.members.values()];
            break;
        }
        case 'users': {
            if (!Array.isArray(filter.userIds)) return { ok: false, code: 'invalid_targets' };
            members = filter.userIds.map(id => guild.members.cache.get(String(id))).filter(Boolean);
            break;
        }
        default:
            return { ok: false, code: 'invalid_filter' };
    }
    const userIds = members
        .filter(member => !member.user.bot && member.roles.cache.has(role.id) !== add)
        .map(member => member.id);
    return { ok: true, userIds };
}

module.exports = {
    ROLE_DURATIONS,
    roleProblem,
    assignableRoles,
    describeRoles,
    authorizeRole,
    changeMemberRole,
    mapLimit,
    expiryOf,
    roleReason,
    finishBulk,
    bulkRole,
    sortRoles,
    applyPreset,
    savePreset,
    deletePreset,
    resolveTargets
};
