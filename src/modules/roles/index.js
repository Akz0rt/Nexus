const cron = require('node-cron');
const { Events } = require('discord.js');
const AuditLogService = require('../../services/AuditLogService');
const TempRoleService = require('./TempRoleService');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;

/** Take away temporary roles whose time is up. Returns how many were taken. */
async function processExpiredRoles(client) {
    let taken = 0;
    for (const grant of await TempRoleService.listDue()) {
        const guild = client.guilds.cache.get(grant.guildId);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(grant.userId).catch(error => {
                if (error.code === UNKNOWN_MEMBER) return null;
                throw error;
            });
            const role = guild.roles.cache.get(grant.roleId);
            // Drop the record first, so our own role removal isn't mistaken for a manual one
            await TempRoleService.remove(grant.guildId, grant.userId, grant.roleId);
            if (!member || !role || !member.roles.cache.has(role.id)) continue;
            await member.roles.remove(role, 'Срок временной роли истёк');
            taken++;
            await AuditLogService.log({
                guildId: guild.id,
                action: 'roles.temp_expired',
                targetIds: [grant.userId],
                source: 'auto',
                details: { roleId: role.id, roleName: role.name, grantedBy: grant.actorId || null }
            });
        } catch (error) {
            if (error.code === UNKNOWN_ROLE) continue;
            console.error(`Roles: removing expired role ${grant.roleId} from ${grant.userId} failed:`, error.message || error);
        }
    }
    return taken;
}

/** Forget temporary-role records that no longer match Discord. */
function forget(guildId, userId, roleIds) {
    for (const roleId of roleIds) {
        TempRoleService.remove(guildId, userId, roleId)
            .catch(error => console.error('Roles: temp role cleanup failed:', error.message || error));
    }
}

module.exports = {
    name: 'roles',
    processExpiredRoles,

    register(client) {
        // Someone took a temporary role away by hand: nothing left to expire
        client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
            const temporary = TempRoleService.rolesOf(newMember.guild.id, newMember.id);
            if (temporary.length === 0) return;
            forget(newMember.guild.id, newMember.id, temporary.filter(roleId => !newMember.roles.cache.has(roleId)));
        });

        client.on(Events.GuildMemberRemove, member => {
            forget(member.guild.id, member.id, TempRoleService.rolesOf(member.guild.id, member.id));
        });

        client.on(Events.GuildRoleDelete, role => {
            for (const userId of TempRoleService.holdersOf(role.guild.id, role.id)) forget(role.guild.id, userId, [role.id]);
        });
    },

    async onReady(client) {
        const count = await TempRoleService.loadIndex();
        if (count) console.log(`Roles: ${count} temporary role(s) waiting to expire`);
        const lift = async () => {
            try {
                const taken = await processExpiredRoles(client);
                if (taken) console.log(`Roles: took away ${taken} expired role(s)`);
            } catch (error) {
                console.error('Roles: expired roles check failed:', error.message || error);
            }
        };
        await lift();
        cron.schedule('* * * * *', lift);
    }
};
