const { Events } = require('discord.js');
const AIService = require('../../services/AIService');
const GuildSettingsService = require('../../services/GuildSettingsService');

function isAddressedToBot(message, botId) {
    if (message.mentions.users.has(botId)) return true;
    return Boolean(message.reference) && message.mentions.repliedUser?.id === botId;
}

module.exports = {
    name: 'ai',
    isAddressedToBot,

    register(client) {
        client.on(Events.MessageCreate, async message => {
            if (message.author.bot) return;
            if (!message.guild) return;

            // Only to an @mention or a reply to the bot: with the Message Content
            // intent the bot sees every message, and answering all of them would cost OpenAI calls
            if (!isAddressedToBot(message, client.user.id)) return;
            // ...and only in this server's AI channel (Settings) — ignore everything else,
            // even direct @mentions. Slash commands are unaffected (handled separately).
            const settings = await GuildSettingsService.get(message.guild.id).catch(() => null);
            if (!settings?.aiChannelId || message.channelId !== settings.aiChannelId) return;

            let userContent = message.content
                .replace(`<@${client.user.id}>`, '')
                .replace(`<@!${client.user.id}>`, '')
                .trim();

            if (!userContent) {
                await message.reply('Привет! Чем могу помочь?');
                return;
            }

            await message.channel.sendTyping();

            try {
                const member = await message.guild.members.fetch(message.author.id);
                const displayName = member.displayName || message.author.username;

                let authorGender = null;
                if (settings.maleRoleId && member.roles.cache.has(settings.maleRoleId)) {
                    authorGender = 'male';
                } else if (settings.femaleRoleId && member.roles.cache.has(settings.femaleRoleId)) {
                    authorGender = 'female';
                }

                const aiResponse = await AIService.processMessage(
                    userContent,
                    message.author.id,
                    displayName,
                    message.channelId,
                    message.guild,
                    authorGender
                );

                if (aiResponse.length > 2000) {
                    const firstChunk = aiResponse.slice(0, 1990);
                    const splitAt = firstChunk.lastIndexOf('\n') > 1500
                        ? firstChunk.lastIndexOf('\n') : 1990;
                    await message.reply(aiResponse.slice(0, splitAt));
                    await message.channel.send(aiResponse.slice(splitAt));
                } else {
                    await message.reply(aiResponse);
                }
            } catch (error) {
                console.error('Error processing AI message:', error);
                await message.reply('Произошла ошибка, попробуй ещё раз.');
            }
        });
    }
};
