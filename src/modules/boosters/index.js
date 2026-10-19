const cron = require('node-cron');
const { Events } = require('discord.js');
const BoosterPassService = require('./BoosterPassService');

/**
 * Booster accounts: kick when the term is over, warn a day before,
 * tell the moderators when one stops boosting or leaves early.
 */
module.exports = {
    name: 'boosters',

    register(client) {
        client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
            BoosterPassService.onBoostChange(oldMember, newMember)
                .catch(error => console.error('Boosters: boost change failed:', error.message || error));
        });
        client.on(Events.GuildMemberRemove, member => {
            BoosterPassService.onLeave(member)
                .catch(error => console.error('Boosters: leave failed:', error.message || error));
        });
    },

    async onReady(client) {
        const count = await BoosterPassService.loadIndex();
        if (count) console.log(`Boosters: ${count} booster account(s) on a term`);
        const check = async () => {
            try {
                const kicked = await BoosterPassService.processDue(client);
                if (kicked) console.log(`Boosters: kicked ${kicked} booster account(s) whose term ended`);
            } catch (error) {
                console.error('Boosters: term check failed:', error.message || error);
            }
        };
        await check();
        cron.schedule('*/5 * * * *', check);
    }
};
