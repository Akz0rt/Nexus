const { Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const VerificationService = require('./VerificationService');
const QueueCardService = require('./QueueCardService');
const { CUSTOM_ID_PREFIX, parseCustomId, buildKickModal } = require('./card');
const { diffUnverified } = require('./roles');

const ERROR_TEXT = {
    not_configured: 'Модуль пропуска не настроен на этом сервере.',
    forbidden: 'У тебя нет прав на это действие.',
    in_progress: 'Этого новичка уже обрабатывает другой модератор.',
    member_left: 'Новичок уже вышел с сервера.'
};

function describeResult(result) {
    if (result.code === 'already_handled') {
        const card = result.card;
        if (!card) return 'Этого человека уже нет в очереди.';
        const who = card.handledBy ? `<@${card.handledBy}>` : 'кто-то вне бота';
        if (card.status === 'approved') {
            return `Уже пропущен: ${who} · ${card.gender === 'male' ? 'Парень' : 'Девушка'}`;
        }
        if (card.status === 'kicked') return `Уже кикнут: ${who}`;
        return 'Карточка уже закрыта.';
    }
    return ERROR_TEXT[result.code] || 'Не удалось выполнить действие.';
}

function actorOf(interaction) {
    return { id: interaction.user.id, tag: interaction.user.tag };
}

async function handleInteraction(interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed || !interaction.guild) return;
    const { action, userId } = parsed;

    if (interaction.isButton() && (action === 'male' || action === 'female')) {
        await interaction.deferUpdate();
        const result = await VerificationService.approve(interaction.guild, userId, action, actorOf(interaction), 'discord');
        if (!result.ok) {
            await interaction.followUp({ content: describeResult(result), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        return;
    }

    if (interaction.isButton() && action === 'kick') {
        // The modal must be shown within 3 s, so only the cheap permission check happens here;
        // the service re-checks everything on submit.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
            await interaction.reply({ content: ERROR_TEXT.forbidden, flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.showModal(buildKickModal(userId));
        return;
    }

    if (interaction.isModalSubmit() && action === 'kickModal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const reason = interaction.fields.getTextInputValue('reason').trim();
        const result = await VerificationService.kick(interaction.guild, userId, reason, actorOf(interaction), 'discord');
        await interaction.editReply({
            content: result.ok ? `Кикнут <@${userId}>.` : describeResult(result),
            allowedMentions: { parse: [] }
        });
    }
}

module.exports = {
    name: 'verification',
    interactionPrefix: CUSTOM_ID_PREFIX,
    handleInteraction,

    register(client) {
        // Back on a server the bot was on before: its saved queue settings apply again
        client.on(Events.GuildCreate, async guild => {
            try {
                const result = await VerificationService.reconcile(guild);
                if (!result.skipped) console.log(`Verification queue rebuilt for ${guild.name}:`, result);
            } catch (error) {
                console.error(`Verification reconcile failed for ${guild.id}:`, error.message || error);
            }
        });

        client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
            try {
                const settings = await VerificationService.getQueueSettings(newMember.guild.id);
                if (!settings || newMember.user.bot) return;

                const change = diffUnverified(oldMember, newMember, settings.unverifiedRoleId);
                if (!change) return;
                // Our own roles.set/kick also lands here — the lock tells us to stay out
                if (VerificationService.isLocked(newMember.guild.id, newMember.id)) return;

                if (change === 'added') {
                    await VerificationService.ensureCard(newMember.guild, newMember, 'discord');
                } else {
                    await VerificationService.closeCard(newMember.guild, newMember.id, 'closed', newMember);
                }
            } catch (error) {
                console.error('Verification GuildMemberUpdate error:', error.message || error);
            }
        });

        client.on(Events.GuildMemberAdd, async (member) => {
            try {
                const result = await VerificationService.assignOnJoin(member);
                if (result === 'assigned') console.log(`Verification: gave @unverified to ${member.user.tag}`);
            } catch (error) {
                console.error('Verification GuildMemberAdd error:', error.message || error);
            }
        });

        client.on(Events.GuildMemberRemove, async (member) => {
            try {
                if (member.user?.bot) return;
                if (VerificationService.isLocked(member.guild.id, member.id)) return;
                const card = await QueueCardService.get(member.guild.id, member.id).catch(() => null);
                if (card?.status !== 'pending') return;
                await VerificationService.closeCard(member.guild, member.id, 'left', null);
            } catch (error) {
                console.error('Verification GuildMemberRemove error:', error.message || error);
            }
        });
    },

    async onReady(client) {
        for (const guild of client.guilds.cache.values()) {
            try {
                const result = await VerificationService.reconcile(guild);
                if (!result.skipped) console.log(`Verification queue rebuilt for ${guild.name}:`, result);
            } catch (error) {
                console.error(`Verification reconcile failed for ${guild.id}:`, error.message || error);
            }
        }
    }
};
