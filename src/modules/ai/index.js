const { Events } = require('discord.js');
const config = require('../../config');
const AIService = require('../../services/AIService');

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

            // Only respond in the dedicated AI channel — ignore everything else,
            // even direct @mentions. Slash commands are unaffected (handled separately).
            if (!config.aiChannelId || message.channelId !== config.aiChannelId) return;
            // ...and there only to an @mention or a reply to the bot: with the Message Content
            // intent the bot sees every message, and answering all of them would cost OpenAI calls
            if (!isAddressedToBot(message, client.user.id)) return;

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
                if (config.maleRoleId && member.roles.cache.has(config.maleRoleId)) {
                    authorGender = 'male';
                } else if (config.femaleRoleId && member.roles.cache.has(config.femaleRoleId)) {
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
