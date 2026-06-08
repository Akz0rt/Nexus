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

        if (birthdayUsers.length > 0) {
            const todayStr = CosmosDBService.getTodayDateString();
            for (const userId of birthdayUsers) {
                try {
                    // Idempotency: skip anyone already congratulated today so restarts,
                    // the startup catch-up check, and the scheduled run don't duplicate.
                    if (await CosmosDBService.wasCongratulatedOn(userId, todayStr)) {
                        console.log(`Already congratulated ${userId} on ${todayStr}, skipping`);
                        continue;
                    }

                    const member = await targetChannel.guild.members.fetch(userId);
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
                } catch (error) {
                    console.error(`Error sending birthday notification for user ${userId}:`, error);
                }
            }
        }
    }
}

module.exports = new NotificationService();