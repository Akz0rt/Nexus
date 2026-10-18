const { Events } = require('discord.js');
const InviteTracker = require('./InviteTracker');
const QueueCardService = require('../verification/QueueCardService');

module.exports = {
    name: 'invites',

    register(client) {
        client.on(Events.InviteCreate, invite => { if (invite.guild?.invites) InviteTracker.refresh(invite.guild).catch(() => {}); });
        client.on(Events.InviteDelete, invite => { if (invite.guild?.invites) InviteTracker.refresh(invite.guild).catch(() => {}); });

        client.on(Events.GuildMemberAdd, async member => {
            if (member.user.bot) return;
            try {
                const invite = await InviteTracker.onJoin(member);
                if (!invite) return;
                // The queue card may already exist (another bot gave @unverified first): note the invite on it
                const card = await QueueCardService.get(member.guild.id, member.id).catch(() => null);
                if (card?.status === 'pending' && !card.invite) await QueueCardService.upsert({ ...card, invite });
            } catch (error) {
                console.error('Invite tracking error:', error.message || error);
            }
        });
    },

    async onReady(client) {
        for (const guild of client.guilds.cache.values()) await InviteTracker.snapshot(guild);
    }
};
