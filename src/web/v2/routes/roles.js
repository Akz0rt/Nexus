const express = require('express');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const RoleService = require('../../../services/RoleService');
const PresetService = require('../../../modules/roles/PresetService');
const TempRoleService = require('../../../modules/roles/TempRoleService');
const RoleJobService = require('../../../modules/roles/RoleJobService');
const RoleMenuService = require('../../../modules/rolemenus/RoleMenuService');
const { actorOf, sendResult } = require('../result');
const { userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const STATUS = {
    invalid_targets: 400,
    invalid_duration: 400,
    invalid_filter: 400,
    invalid_name: 400,
    invalid_roles: 400,
    role_managed: 400,
    forbidden: 403,
    role_higher: 403,
    role_not_found: 404,
    preset_not_found: 404,
    member_not_found: 404,
    channel_not_found: 404,
    bot_cannot_role: 409,
    bot_cannot: 409,
    job_running: 409,
    bot_cannot_channel: 409,
    invalid_title: 400,
    role_dangerous: 400,
    menu_not_found: 404,
    nobody: 409,
    too_many_targets: 413
};

const SNOWFLAKE_RE = /^\d{17,20}$/;

const handle = run => async (req, res, next) => {
    try {
        sendResult(res, await run(req, actorOf(req)), STATUS);
    } catch (error) {
        next(error);
    }
};

function viewerOf(req) {
    return req.guild.members.cache.get(req.session.userId) || null;
}

/** Mass changes: { roleId, add, filter: { type: 'all'|'role'|'voice'|'users', id?, userIds? }, duration? } */
function jobRequest(body = {}) {
    const filter = body.filter || {};
    return {
        roleId: String(body.roleId || ''),
        add: body.add !== false,
        duration: body.duration || null,
        filter: {
            type: String(filter.type || ''),
            id: filter.id ? String(filter.id) : undefined,
            userIds: Array.isArray(filter.userIds) ? filter.userIds.map(String).filter(id => SNOWFLAKE_RE.test(id)) : undefined
        }
    };
}

// GET /roles/assignable — roles the viewer could give or take away
router.get('/assignable', (req, res) => {
    const viewer = viewerOf(req);
    const allowed = viewer?.permissions.has(PermissionFlagsBits.ManageRoles);
    res.json({ items: allowed ? RoleService.assignableRoles(req.guild, viewer) : [] });
});

// POST /roles/bulk — { userIds, roleId, add, duration? } (up to 100 people, e.g. from the voice board or a member card)
router.post('/bulk', handle((req, actor) => {
    const body = req.body || {};
    return RoleService.bulkRole(req.guild, body.userIds, body.roleId, body.add !== false, actor, 'panel', { duration: body.duration || null });
}));

// Everything below is the «Роли» screen: Manage Roles only
router.use((req, res, next) => {
    if (!viewerOf(req)?.permissions.has(PermissionFlagsBits.ManageRoles)) return res.status(403).json({ error: 'forbidden' });
    next();
});

// GET /roles — every role, highest first, plus the running or last mass change
router.get('/', async (req, res, next) => {
    try {
        await RoleJobService.ensureMembers(req.guild);
        res.json({
            items: RoleService.describeRoles(req.guild, viewerOf(req)),
            job: RoleJobService.current(req.guild.id) ? RoleJobService.publicJob(RoleJobService.current(req.guild.id)) : null
        });
    } catch (error) {
        next(error);
    }
});

// --- Temporary roles ---------------------------------------------------------------

router.get('/temp', async (req, res, next) => {
    try {
        const guild = req.guild;
        const viewer = viewerOf(req);
        const grants = await TempRoleService.list(guild.id);
        res.json({
            items: grants.map(grant => {
                const role = guild.roles.cache.get(grant.roleId);
                return {
                    user: userRef(guild, grant.userId),
                    roleId: grant.roleId,
                    roleName: role?.name || grant.roleName,
                    color: role?.hexColor || null,
                    expiresAt: grant.expiresAt,
                    grantedBy: userRef(guild, grant.actorId),
                    editable: Boolean(role) && !RoleService.roleProblem(guild, viewer, role)
                };
            })
        });
    } catch (error) {
        next(error);
    }
});

// DELETE /roles/temp/:userId/:roleId — take a temporary role away now
router.delete('/temp/:userId/:roleId', handle((req, actor) =>
    RoleService.bulkRole(req.guild, [req.params.userId], req.params.roleId, false, actor, 'panel')));

// --- Presets -----------------------------------------------------------------------

router.get('/presets', async (req, res, next) => {
    try {
        const guild = req.guild;
        const viewer = viewerOf(req);
        const presets = await PresetService.list(guild.id);
        res.json({
            items: presets.map(preset => ({
                id: preset.id,
                name: preset.name,
                updatedAt: preset.updatedAt,
                roles: preset.roleIds.map(roleId => {
                    const role = guild.roles.cache.get(roleId);
                    return {
                        id: roleId,
                        name: role?.name || null,
                        color: role?.hexColor || null,
                        problem: RoleService.roleProblem(guild, viewer, role)
                    };
                })
            }))
        });
    } catch (error) {
        next(error);
    }
});

router.post('/presets', handle((req, actor) =>
    RoleService.savePreset(req.guild, { name: req.body?.name, roleIds: req.body?.roleIds }, actor, 'panel')));

router.put('/presets/:presetId', handle((req, actor) =>
    RoleService.savePreset(req.guild, { id: req.params.presetId, name: req.body?.name, roleIds: req.body?.roleIds }, actor, 'panel')));

router.delete('/presets/:presetId', handle((req, actor) =>
    RoleService.deletePreset(req.guild, req.params.presetId, actor, 'panel')));

// POST /roles/presets/:presetId/apply — { userId }
router.post('/presets/:presetId/apply', handle((req, actor) =>
    RoleService.applyPreset(req.guild, String(req.body?.userId || ''), req.params.presetId, actor, 'panel')));

// --- Mass changes ------------------------------------------------------------------

router.get('/jobs/current', (req, res) => {
    const job = RoleJobService.current(req.guild.id);
    res.json({ job: job ? RoleJobService.publicJob(job) : null });
});

router.post('/jobs/preview', handle((req, actor) => RoleJobService.preview(req.guild, jobRequest(req.body), actor)));

router.post('/jobs', handle((req, actor) => RoleJobService.start(req.guild, jobRequest(req.body), actor, 'panel')));

// --- Self-service role menus («роли по интересам») -----------------------------------

function describeMenu(guild, menu) {
    return {
        id: menu.id,
        title: menu.title,
        description: menu.description,
        mode: menu.mode,
        channel: { id: menu.channelId, name: guild.channels.cache.get(menu.channelId)?.name || null },
        roles: menu.roleIds.map(roleId => {
            const role = guild.roles.cache.get(roleId);
            return { id: roleId, name: role?.name || null, color: role?.hexColor || null, problem: role ? null : 'role_not_found' };
        }),
        messageUrl: menu.messageId ? `https://discord.com/channels/${guild.id}/${menu.channelId}/${menu.messageId}` : null,
        updatedAt: menu.updatedAt
    };
}

const menuResult = run => async (req, res, next) => {
    try {
        const result = await run(req, actorOf(req));
        if (!result.ok) return res.status(STATUS[result.code] || 400).json({ error: result.code, field: result.field || null, roleName: result.roleName || null });
        res.json({ ok: true, menu: result.menu ? describeMenu(req.guild, result.menu) : undefined });
    } catch (error) {
        next(error);
    }
};

router.get('/menus', async (req, res, next) => {
    try {
        const guild = req.guild;
        const menus = await RoleMenuService.list(guild.id);
        const viewer = viewerOf(req);
        res.json({
            items: menus.map(menu => describeMenu(guild, menu)),
            // For the form: text channels, and which roles may go into a menu
            channels: [...guild.channels.cache.values()]
                .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
                .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
                .map(c => ({ id: c.id, name: c.name, category: c.parent?.name || null })),
            roles: RoleService.assignableRoles(guild, viewer)
                .filter(role => !RoleMenuService.isDangerous(guild.roles.cache.get(role.id)))
        });
    } catch (error) {
        next(error);
    }
});
router.post('/menus', menuResult((req, actor) => RoleMenuService.create(req.guild, req.body || {}, actor, 'panel')));
router.put('/menus/:menuId', menuResult((req, actor) => RoleMenuService.update(req.guild, req.params.menuId, req.body || {}, actor, 'panel')));
router.delete('/menus/:menuId', menuResult((req, actor) => RoleMenuService.delete(req.guild, req.params.menuId, actor, 'panel')));

// GET /roles/:roleId/members — who holds a role
router.get('/:roleId/members', async (req, res, next) => {
    try {
        const guild = req.guild;
        const role = guild.roles.cache.get(req.params.roleId);
        if (!role || role.id === guild.id) return res.status(404).json({ error: 'role_not_found' });
        await RoleJobService.ensureMembers(guild);
        const items = [...role.members.values()]
            .map(member => ({
                id: member.id,
                displayName: member.displayName,
                username: member.user.username,
                avatarURL: member.user.displayAvatarURL({ size: 64, extension: 'png' }),
                bot: member.user.bot,
                expiresAt: null
            }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
        const temporary = new Set(TempRoleService.holdersOf(guild.id, role.id));
        if (temporary.size > 0) {
            const grants = new Map((await TempRoleService.list(guild.id))
                .filter(grant => grant.roleId === role.id)
                .map(grant => [grant.userId, grant.expiresAt]));
            for (const item of items) item.expiresAt = grants.get(item.id) || null;
        }
        res.json({ role: { id: role.id, name: role.name, color: role.hexColor }, items });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
