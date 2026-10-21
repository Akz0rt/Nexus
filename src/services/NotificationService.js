const { EmbedBuilder } = require('discord.js');
const CosmosDBService = require('./CosmosDBService');
const GuildSettingsService = require('./GuildSettingsService');

/**
 * A text channel of this server from Settings → «Дни рождения» (Azure variables on the
 * main server until saved there), or null. Never a channel of another server.
 */
async function channelOf(guild, channelId) {
    if (!channelId) return null;
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
        try {
            channel = await guild.channels.fetch(channelId);
        } catch {
            return null;
        }
    }
    return channel?.guild?.id === guild.id && channel.isTextBased?.() ? channel : null;
}

class NotificationService {
    /** Where this server announces a newly set birthday, or null */
    async announceChannel(guild) {
        const settings = await GuildSettingsService.get(guild.id);
        return channelOf(guild, settings.birthdayAnnounceChannelId);
    }

    /** Where this server posts the daily congratulations (the announce channel if unset), or null */
    async congratsChannel(guild) {
        const settings = await GuildSettingsService.get(guild.id);
        return await channelOf(guild, settings.birthdayCongratsChannelId)
            || channelOf(guild, settings.birthdayAnnounceChannelId);
    }

    /** The daily run for one server: its own list, channel and calendar */
    async sendBirthdayNotifications(guild) {
        const { timezone } = await GuildSettingsService.get(guild.id);
        const birthdayUsers = await CosmosDBService.getTodaysBirthdays(guild.id, timezone);
        console.log(`Found ${birthdayUsers.length} birthday user(s) for today in ${guild.id}`);

        if (!(await this.congratsChannel(guild))) {
            if (birthdayUsers.length > 0) {
                console.warn(`Found ${birthdayUsers.length} birthdays today in ${guild.id}, but no notification channel is configured/reachable.`);
            }
            return;
        }

        for (const userId of birthdayUsers) {
            try {
                const result = await this.congratulate(guild, userId);
                if (result.code === 'already_congratulated') console.log(`Already congratulated ${userId} in ${guild.id} today, skipping`);
            } catch (error) {
                console.error(`Error sending birthday notification for user ${userId} in ${guild.id}:`, error);
            }
        }
    }

    /**
     * Congratulate one member of this server today (the daily run, or «Поздравить сейчас» in the app).
     * Idempotent: anyone already congratulated here today is skipped, so restarts, the
     * startup catch-up check, the scheduled run and the app button never duplicate.
     * @returns {Promise<{ ok: true } | { ok: false, code: 'no_channel'|'already_congratulated'|'member_not_found' }>}
     */
    async congratulate(guild, userId) {
        const targetChannel = await this.congratsChannel(guild);
        if (!targetChannel) return { ok: false, code: 'no_channel' };

        const { timezone } = await GuildSettingsService.get(guild.id);
        const todayStr = CosmosDBService.getTodayDateString(timezone);
        if (await CosmosDBService.wasCongratulatedOn(guild.id, userId, todayStr)) return { ok: false, code: 'already_congratulated' };

        const member = await guild.members.fetch(userId).catch(() => null);
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
        await CosmosDBService.markCongratulated(guild.id, userId, todayStr);
        return { ok: true };
    }
}

module.exports = new NotificationService();
