const { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const VoiceService = require('../modules/voice/VoiceService');
const { describeError, describeBulk } = require('../modules/voice/commandText');
const { actorOf } = require('../modules/moderation/commandText');

const SPLIT_CHANNEL_OPTIONS = ['канал-1', 'канал-2', 'канал-3', 'канал-4'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Действия над твоим голосовым каналом')
        .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand(sub => sub
            .setName('mute-all')
            .setDescription('Выключить микрофон всем в твоём канале, кроме тебя'))
        .addSubcommand(sub => sub
            .setName('unmute-all')
            .setDescription('Вернуть микрофон всем в твоём канале'))
        .addSubcommand(sub => {
            sub.setName('split')
                .setDescription('Случайно разбить твой канал на команды (ты остаёшься)')
                .addIntegerOption(option => option
                    .setName('команды')
                    .setDescription('Сколько команд; каналы — пустые из этой же категории')
                    .setMinValue(2)
                    .setMaxValue(10));
            for (const name of SPLIT_CHANNEL_OPTIONS) {
                sub.addChannelOption(option => option
                    .setName(name)
                    .setDescription('Канал для команды (вместо автоматического выбора)')
                    .addChannelTypes(ChannelType.GuildVoice));
            }
            return sub;
        })
        .addSubcommand(sub => sub
            .setName('gather')
            .setDescription('Собрать команды обратно после /voice split')),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;
        const actor = actorOf(interaction);
        const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
        const sub = interaction.options.getSubcommand();

        if (sub === 'gather') {
            const split = VoiceService.lastSplit.get(guild.id);
            if (!split) return reply(describeError({ code: 'nothing_to_gather' }));
            const result = await VoiceService.gather(guild, split.sourceChannelId, split.targetChannelIds, actor, 'discord');
            if (result.ok) VoiceService.lastSplit.delete(guild.id);
            return reply(result.ok ? `${describeBulk(result, 'Собрано')}\nКанал: <#${split.sourceChannelId}>` : describeError(result));
        }

        const channel = interaction.member.voice?.channel;
        if (!channel) return reply('Сначала зайди в голосовой канал.');

        if (sub === 'mute-all' || sub === 'unmute-all') {
            const on = sub === 'mute-all';
            const result = await VoiceService.muteChannel(guild, channel.id, on, actor, 'discord', { exceptIds: [actor.id] });
            return reply(result.ok ? describeBulk(result, on ? 'Микрофон выключен:' : 'Микрофон включён:') : describeError(result));
        }

        // split
        let targets = SPLIT_CHANNEL_OPTIONS
            .map(name => interaction.options.getChannel(name))
            .filter(Boolean)
            .map(target => target.id);
        if (targets.length === 0) {
            const count = interaction.options.getInteger('команды') || 2;
            targets = VoiceService.freeChannelsNear(guild, channel, interaction.member, count).map(target => target.id);
            if (targets.length < count) return reply(describeError({ code: 'not_enough_channels' }));
        }
        const result = await VoiceService.split(guild, channel.id, targets, actor, 'discord', { exceptIds: [actor.id] });
        if (!result.ok) return reply(describeError(result));
        const teams = result.targetChannelIds.map(id => `<#${id}>`).join(', ');
        return reply(`${describeBulk(result, 'Разослано')}\nКоманды: ${teams}. Собрать обратно: /voice gather.`);
    }
};
