const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const CosmosDBService = require('./CosmosDBService');

class NotificationService {
    constructor() {
        // channel used for announcements when users set birthdays (legacy)
        this.announceChannel = null;
        // separate channel used for daily congratulation messages
        this.congratsChannel = null;
    }

    // Backwards-compatible setter for single channel
    setChannel(channel) {
        this.announceChannel = channel;
        // default congratsChannel to announceChannel if not set separately
        if (!this.congratsChannel) this.congratsChannel = channel;
    }

    // New API: set both announce and congrats channels explicitly
    setChannels(announceChannel, congratsChannel) {
        this.announceChannel = announceChannel || null;
        this.congratsChannel = congratsChannel || announceChannel || null;
    }

    async sendBirthdayNotifications() {
        const birthdayUsers = await CosmosDBService.getTodaysBirthdays();
        console.log(`Found ${birthdayUsers.length} birthday user(s) for today`);

        // Use congratsChannel for sending congratulations; fall back to announceChannel
        const targetChannel = this.congratsChannel || this.announceChannel;
        if (!targetChannel) {
            if (birthdayUsers.length > 0) {
                console.warn(
                    `Found ${birthdayUsers.length} birthdays today, but no notification channel is configured/reachable.`
                );
            } else {
                console.log('No birthdays today and no notification channel configured.');
            }
            return;
        }

        for (const userId of birthdayUsers) {
            try {
                const result = await this.congratulate(userId);
                if (result.code === 'already_congratulated') console.log(`Already congratulated ${userId} today, skipping`);
            } catch (error) {
                console.error(`Error sending birthday notification for user ${userId}:`, error);
            }
        }
    }

    /**
     * Congratulate one member today (the daily run, or «Поздравить сейчас» in the app).
     * Idempotent: anyone already congratulated today is skipped, so restarts, the
     * startup catch-up check, the scheduled run and the app button never duplicate.
     * @returns {Promise<{ ok: true } | { ok: false, code: 'no_channel'|'already_congratulated'|'member_not_found' }>}
     */
    async congratulate(userId) {
        const targetChannel = this.congratsChannel || this.announceChannel;
        if (!targetChannel) return { ok: false, code: 'no_channel' };

        const todayStr = CosmosDBService.getTodayDateString();
        if (await CosmosDBService.wasCongratulatedOn(userId, todayStr)) return { ok: false, code: 'already_congratulated' };

        const member = await targetChannel.guild.members.fetch(userId).catch(() => null);
        if (!member) return { ok: false, code: 'member_not_found' };
        const displayName = member.displayName || member.user.username;

        const messages = [
            "🎉 Ура! Сегодня твой особенный день!",
            "🎂 С наилучшими пожеланиями в день рождения!",
            "🎈 Пусть этот день будет наполнен радостью и смехом!",
            "🎁 Желаем ещё одного удивительного года впереди!",
            "✨ Время отмечать ТЕБЯ!",
            "🌟 Пусть этот год принесёт тебе новые победы и яркие впечатления!",
            "🥳 Пусть здоровье, удача и любовь всегда будут рядом с тобой!",
            "🎊 От всей души желаем исполнения самых тёплых желаний!",
            "🎁 Сегодня — твой день: наслаждайся, улыбайся и получай подарки!",
            "💫 С праздником! Пусть впереди ждёт только хорошее и светлое!"
        ];

        const embed = new EmbedBuilder()
            .setColor('#FF69B4')
            .setTitle(`С Днём Рождения, ${displayName}!`)
            .setDescription(messages[Math.floor(Math.random() * messages.length)])
            .setThumbnail(member.user.displayAvatarURL())
            .addFields({
                name: '🌟 Поздравление',
                value: 'Желаем всего самого лучшего в этот день! Пусть он будет полон приятных моментов и тёплых воспоминаний.'
            });

        await targetChannel.send({
            content: `@everyone Внимание! Сегодня у <@${userId}> день рождения! 🎉🎂`,
            embeds: [embed]
        });

        // Mark only after a successful send so a send failure is retried,
        // not silently swallowed.
        await CosmosDBService.markCongratulated(userId, todayStr);
        return { ok: true };
    }
}

module.exports = new NotificationService();