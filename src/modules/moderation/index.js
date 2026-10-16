const cron = require('node-cron');
const {
    ActionRowBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle
} = require('discord.js');
const ModerationService = require('./ModerationService');
const { CUSTOM_ID_PREFIX } = require('./ModerationService');
const { describeError, actorOf } = require('./commandText');

const SNOWFLAKE_RE = /^\d{17,20}$/;

function buildBanModal(userId) {
    return new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:banModal:${userId}`)
        .setTitle('Бан навсегда')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина (её получит забаненный)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(400)
                .setValue('Систематические нарушения правил')
                .setRequired(true)
        ));
}

// "Забанить" under the escalation message (5 warns)
async function handleInteraction(interaction) {
    const [, action, userId] = String(interaction.customId).split(':');
    if (!interaction.guild || !SNOWFLAKE_RE.test(userId || '')) return;

    if (interaction.isButton() && action === 'ban') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
            await interaction.reply({ content: describeError({ code: 'forbidden' }), flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.showModal(buildBanModal(userId));
        return;
    }

    if (interaction.isModalSubmit() && action === 'banModal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const reason = interaction.fields.getTextInputValue('reason');
        const result = await ModerationService.ban(
            interaction.guild, userId, { reason, duration: 'forever', deleteMessageDays: 0 }, actorOf(interaction), 'discord');

        if (result.ok || result.code === 'already_banned') {
            // Drop the button so nobody bans twice; note who decided
            const note = result.ok ? `Забанен · <@${interaction.user.id}>` : 'Уже забанен';
            await interaction.message?.edit({
                content: note,
                components: [],
                allowedMentions: { parse: [] }
            }).catch(() => {});
        }
        await interaction.editReply({
            content: result.ok ? `<@${userId}> забанен.` : describeError(result),
            allowedMentions: { parse: [] }
        });
    }
}

module.exports = {
    name: 'moderation',
    interactionPrefix: CUSTOM_ID_PREFIX,
    handleInteraction,

    register() {},

    async onReady(client) {
        const lift = async () => {
            try {
                const lifted = await ModerationService.processExpiredBans(client);
                if (lifted) console.log(`Moderation: lifted ${lifted} expired ban(s)`);
            } catch (error) {
                console.error('Moderation: expired bans check failed:', error.message || error);
            }
        };
        await lift();
        cron.schedule('* * * * *', lift);
    }
};
