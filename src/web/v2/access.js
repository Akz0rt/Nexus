const { PermissionFlagsBits } = require('discord.js');
const state = require('../../state');

/** Panel roles, lowest to highest. */
const ROLE_RANK = { none: 0, admin: 1, senior: 2 };

/**
 * Panel role from a member's Discord permissions:
 * Administrator → senior; Manage Roles or Kick Members → admin; otherwise none.
 * @param {{ has(flag: bigint): boolean }} permissions
 * @returns {'senior'|'admin'|'none'}
 */
function panelRoleFromPermissions(permissions) {
    if (!permissions) return 'none';
    if (permissions.has(PermissionFlagsBits.Administrator)) return 'senior';
    if (permissions.has(PermissionFlagsBits.ManageRoles) || permissions.has(PermissionFlagsBits.KickMembers)) {
        return 'admin';
    }
    return 'none';
}

/**
 * Live panel role of a user in a guild. Uses the member cache, which the
 * GuildMembers intent keeps current, so a demotion in Discord applies immediately.
 */
async function getPanelRole(guild, userId) {
    const member = guild.members.cache.get(userId)
        || await guild.members.fetch(userId).catch(() => null);
    return member ? panelRoleFromPermissions(member.permissions) : 'none';
}

function hasRole(role, minRole) {
    return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** Express middleware: req.guild + req.panelRole for /guilds/:guildId routes. */
function requireGuildAccess(minRole = 'admin') {
    return async (req, res, next) => {
        try {
            const client = state.client;
            if (!client?.isReady?.()) {
                return res.status(503).json({ error: 'bot_offline' });
            }
            const guild = client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json({ error: 'guild_not_found' });

            const role = await getPanelRole(guild, req.session.userId);
            if (!hasRole(role, minRole)) return res.status(403).json({ error: 'forbidden' });

            req.guild = guild;
            req.panelRole = role;
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = { ROLE_RANK, panelRoleFromPermissions, getPanelRole, hasRole, requireGuildAccess };
