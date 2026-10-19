const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const CUSTOM_ID_PREFIX = 'verify';
const YOUNG_ACCOUNT_DAYS = 7; // default; each server sets its own in Settings → Пропуск
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_COLORS = {
    pending: '#FEE75C',
    approved: '#57F287',
    kicked: '#ED4245',
    left: '#99AAB5',
    closed: '#99AAB5',
    booster: '#F47FFF',
    booster_ended: '#99AAB5'
};

// customId format: verify:<action>:<userId>
function customId(action, userId) {
    return `${CUSTOM_ID_PREFIX}:${action}:${userId}`;
}

function parseCustomId(id) {
    const [prefix, action, userId] = String(id).split(':');
    if (prefix !== CUSTOM_ID_PREFIX || !action || !userId) return null;
    return { action, userId };
}

function discordTime(date, style = 'f') {
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

function computeFlags(member, youngAccountDays = YOUNG_ACCOUNT_DAYS) {
    const flags = [];
    const ageMs = Date.now() - member.user.createdTimestamp;
    if (ageMs < youngAccountDays * DAY_MS) flags.push(`⚠️ Аккаунт младше ${youngAccountDays} дн.`);
    if (!member.user.avatar) flags.push('⚠️ Нет аватара');
    return flags;
}

function formatAccountAge(createdTimestamp) {
    const days = Math.floor((Date.now() - createdTimestamp) / DAY_MS);
    if (days < 1) return 'меньше дня';
    if (days < 60) return `${days} дн.`;
    const months = Math.floor(days / 30);
    if (months < 24) return `${months} мес.`;
    return `${Math.floor(days / 365)} г.`;
}

function statusLine(card) {
    const who = card.handledBy ? `<@${card.handledBy}>` : '';
    const when = card.handledAt ? discordTime(card.handledAt, 't') : '';
    switch (card.status) {
        case 'approved':
            return `✅ Пропущен · ${who} · ${card.gender === 'male' ? 'Парень' : 'Девушка'} · ${when}`;
        case 'kicked':
            return `👢 Кикнут · ${who} · ${when}${card.reason ? `\nПричина: ${card.reason}` : ''}`;
        case 'left':
            return `🚪 Вышел с сервера · ${when}`;
        case 'closed':
            return `🔓 Роль снята вне бота · ${when}`;
        case 'booster':
            return `💎 Буст-аккаунт · ${who} · до ${card.boosterUntil ? discordTime(card.boosterUntil, 'D') : '—'} — потом бот его кикнет`;
        case 'booster_ended':
            return `💎 Буст-аккаунт: срок закончен · ${when}`;
        default:
            return null;
    }
}

/**
 * Build message payload for a queue card.
 * @param {import('discord.js').GuildMember | null} member live member (null if left)
 * @param {object} card queue_cards document
 */
function buildCardMessage(member, card, { youngAccountDays } = {}) {
    const embed = new EmbedBuilder()
        .setColor(STATUS_COLORS[card.status] || STATUS_COLORS.pending)
        .setTitle(card.status === 'pending' ? 'Новичок ждёт пропуска' : 'Карточка новичка');

    if (member) {
        embed
            .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
            .setDescription(`<@${member.id}> · **${member.user.username}**` +
                (member.nickname ? ` (${member.nickname})` : ''))
            .addFields(
                { name: 'ID', value: `\`${member.id}\``, inline: true },
                { name: 'Возраст аккаунта', value: formatAccountAge(member.user.createdTimestamp), inline: true },
                { name: 'Зашёл', value: member.joinedAt ? discordTime(member.joinedAt, 'R') : '—', inline: true }
            );

        const flags = computeFlags(member, youngAccountDays);
        if (flags.length) embed.addFields({ name: 'Флаги', value: flags.join('\n') });
    } else {
        embed.setDescription(`<@${card.userId}> · \`${card.userId}\``);
    }

    const status = statusLine(card);
    if (status) embed.addFields({ name: 'Итог', value: status });

    const components = card.status === 'pending'
        ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(customId('male', card.userId)).setLabel('Парень').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(customId('female', card.userId)).setLabel('Девушка').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(customId('kick', card.userId)).setLabel('Кик').setStyle(ButtonStyle.Danger)
        )]
        : [];

    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function buildKickModal(userId) {
    return new ModalBuilder()
        .setCustomId(customId('kickModal', userId))
        .setTitle('Кикнуть новичка')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(400)
        ));
}

module.exports = {
    CUSTOM_ID_PREFIX,
    customId,
    parseCustomId,
    buildCardMessage,
    buildKickModal,
    computeFlags
};
