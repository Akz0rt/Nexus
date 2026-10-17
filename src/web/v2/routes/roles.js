const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const RoleService = require('../../../services/RoleService');
const { actorOf, sendResult } = require('../result');

const router = express.Router({ mergeParams: true });

const STATUS = {
    invalid_targets: 400,
    role_managed: 400,
    forbidden: 403,
    role_higher: 403,
    role_not_found: 404,
    bot_cannot_role: 409
};

// GET /roles/assignable — roles the viewer could give or take away
router.get('/assignable', (req, res) => {
    const viewer = req.guild.members.cache.get(req.session.userId);
    const allowed = viewer?.permissions.has(PermissionFlagsBits.ManageRoles);
    res.json({ items: allowed ? RoleService.assignableRoles(req.guild, viewer) : [] });
});

// POST /roles/bulk — { userIds, roleId, add }
router.post('/bulk', async (req, res, next) => {
    try {
        const body = req.body || {};
        const result = await RoleService.bulkRole(req.guild, body.userIds, body.roleId, body.add !== false, actorOf(req), 'panel');
        sendResult(res, result, STATUS);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
