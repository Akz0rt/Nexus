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
        let running = false;
        const check = async () => {
            if (running) return; // a slow round is still kicking
            running = true;
            try {
                // A failed load at startup is retried next round; the kicks below don't need it
                if (!BoosterPassService.indexLoaded) {
                    await BoosterPassService.loadIndex()
                        .then(count => { if (count) console.log(`Boosters: ${count} booster account(s) on a term`); })
                        .catch(error => console.error('Boosters: loading the index failed:', error.message || error));
                }
                const kicked = await BoosterPassService.processDue(client);
                if (kicked) console.log(`Boosters: kicked ${kicked} booster account(s) whose term ended`);
            } catch (error) {
                console.error('Boosters: term check failed:', error.message || error);
            } finally {
                running = false;
            }
        };
        cron.schedule('*/5 * * * *', check);
        await check();
    }
};
