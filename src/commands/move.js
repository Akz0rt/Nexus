const { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const VoiceService = require('../modules/voice/VoiceService');
const SquadService = require('../modules/voice/SquadService');
const { describeError, describeBulk } = require('../modules/voice/commandText');
const { actorOf } = require('../modules/moderation/commandText');

const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('move')
        .setDescription('Перенести людей из голосового канала в другой')
        .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
        .setContexts(InteractionContextType.Guild)
        .addChannelOption(option => option
            .setName('куда')
            .setDescription('Канал, куда переносить')
            .setRequired(true)
            .addChannelTypes(...VOICE_TYPES))
        .addChannelOption(option => option
            .setName('откуда')
            .setDescription('Из какого канала (по умолчанию — из твоего)')
            .addChannelTypes(...VOICE_TYPES))
        .addRoleOption(option => option
            .setName('роль')
            .setDescription('Только люди с этой ролью'))
        .addStringOption(option => option
            .setName('состав')
            .setDescription('Сохранённый состав: переносит тех, кто сейчас в голосе')
            .setAutocomplete(true)),

    async autocomplete(interaction) {
        const needle = String(interaction.options.getFocused() || '').trim().toLowerCase();
        const squads = await SquadService.list(interaction.guildId);
        await interaction.respond(squads
            .filter(squad => !needle || squad.name.toLowerCase().includes(needle))
            .slice(0, 25)
            .map(squad => ({ name: squad.name.slice(0, 100), value: squad.id })));
    },

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;
        const to = interaction.options.getChannel('куда');
        const from = interaction.options.getChannel('откуда');
        const role = interaction.options.getRole('роль');
        const squadId = interaction.options.getString('состав');
        const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });

        let members;
        if (squadId) {
            const squad = await SquadService.get(guild.id, squadId);
            if (!squad) return reply(describeError({ code: 'squad_not_found' }));
            members = squad.memberIds
                .map(id => guild.members.cache.get(id))
                .filter(member => member?.voice?.channelId && (!from || member.voice.channelId === from.id));
        } else {
            const fromId = from?.id || interaction.member.voice?.channelId;
            if (!fromId) return reply(describeError({ code: 'not_in_voice' }));
            members = VoiceService.membersIn(guild, fromId) || [];
        }
        if (role) members = members.filter(member => member.roles.cache.has(role.id));
        if (members.length === 0) return reply(describeError({ code: 'invalid_targets' }));

        const result = await VoiceService.move(guild, members.map(member => member.id), to.id, actorOf(interaction), 'discord');
        return reply(result.ok ? `${describeBulk(result, 'Перемещено')}\nКанал: <#${to.id}>` : describeError(result));
    }
};
