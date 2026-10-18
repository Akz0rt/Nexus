const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('./GuildSettingsService');
const AuditLogService = require('./AuditLogService');
const InviteTracker = require('../modules/invites/InviteTracker');

const DB_TIMEOUT_MS = 5000;

/** Bot permissions the panel's features rely on, with what breaks without each. */
const BOT_PERMISSIONS = [
    { flag: PermissionFlagsBits.ManageRoles, label: 'Управлять ролями', hint: 'без него не работают пропуск и выдача ролей' },
    { flag: PermissionFlagsBits.KickMembers, label: 'Выгонять участников', hint: 'нужно для кика' },
    { flag: PermissionFlagsBits.BanMembers, label: 'Банить участников', hint: 'нужно для бана и разбана' },
    { flag: PermissionFlagsBits.ModerateMembers, label: 'Отправлять участников подумать о своём поведении', hint: 'нужно для мута' },
    { flag: PermissionFlagsBits.MoveMembers, label: 'Перемещать участников', hint: 'нужно для переноса и отключения от голоса' },
    { flag: PermissionFlagsBits.MuteMembers, label: 'Отключать участникам микрофон', hint: 'нужно для выключения микрофона' },
    { flag: PermissionFlagsBits.DeafenMembers, label: 'Отключать участникам звук', hint: 'нужно для выключения звука' },
    { flag: PermissionFlagsBits.ManageChannels, label: 'Управлять каналами', hint: 'нужно для лимита и названия голосовых и для slowmode в Lockdown' },
    { flag: PermissionFlagsBits.ManageGuild, label: 'Управлять сервером', hint: 'без него Lockdown не может поставить инвайты на паузу, а в Пропуске не видно, по чьему инвайту зашёл новичок' },
    { flag: PermissionFlagsBits.ViewAuditLog, label: 'Просматривать журнал аудита', hint: 'без него в логе сообщений не видно, какой модератор удалил сообщение' }
];

function check(group, label, level, hint = null) {
    return { group, label, level, hint };
}

async function pingDatabase() {
    const started = Date.now();
    const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS));
    await Promise.race([(async () => {
        await AuditLogService.initialize();
        await AuditLogService.container.read();
    })(), timeout]);
    return Date.now() - started;
}

/**
 * Health checks for the Settings screen. level: 'ok' | 'warn' | 'bad'.
 * @param {import('discord.js').Guild} guild
 */
async function run(guild, { database = pingDatabase } = {}) {
    const checks = [];
    const client = guild.client;
    const me = guild.members.me;
    const settings = await GuildSettingsService.get(guild.id);

    // Intents: if the bot is online with them, they're enabled in the Developer Portal
    const intents = client?.options?.intents;
    for (const [bit, label] of [[GatewayIntentBits.GuildMembers, 'Server Members Intent'], [GatewayIntentBits.MessageContent, 'Message Content Intent']]) {
        const on = Boolean(intents?.has?.(bit));
        checks.push(check('intents', label, on ? 'ok' : 'bad', on ? null : 'включите в Discord Developer Portal → Bot'));
    }

    const isAdmin = Boolean(me?.permissions.has(PermissionFlagsBits.Administrator));
    for (const permission of BOT_PERMISSIONS) {
        const has = Boolean(me?.permissions.has(permission.flag));
        checks.push(check('permissions', permission.label, has ? 'ok' : 'bad', has ? null : permission.hint));
    }
    if (isAdmin) checks.push(check('permissions', 'У бота есть «Администратор» — все права выше есть', 'ok'));

    // Roles the bot hands out must sit below its highest role
    const botTop = me?.roles.highest.position ?? 0;
    const roleKeys = [['unverifiedRoleId', '@АНверефи'], ['maleRoleId', 'Парень'], ['femaleRoleId', 'Девушка']];
    for (const [key, label] of roleKeys) {
        const id = settings[key];
        if (!id) {
            checks.push(check('verification', `Роль «${label}»`, 'bad', 'не выбрана — выберите её в разделе «Пропуск»'));
            continue;
        }
        const role = guild.roles.cache.get(id);
        if (!role) checks.push(check('verification', `Роль «${label}»`, 'bad', 'роль удалена — выберите другую'));
        else if (role.position >= botTop) checks.push(check('verification', `Роль «${role.name}» ниже роли бота`, 'bad', 'перетащите роль бота выше в настройках сервера'));
        else checks.push(check('verification', `Роль «${role.name}» ниже роли бота`, 'ok'));
    }

    const queueChannel = settings.verifyQueueChannelId ? guild.channels.cache.get(settings.verifyQueueChannelId) : null;
    if (!settings.verifyQueueChannelId) {
        checks.push(check('verification', 'Канал очереди', 'bad', 'не выбран — карточки новичков некуда присылать'));
    } else if (!queueChannel) {
        checks.push(check('verification', 'Канал очереди', 'bad', 'канал удалён — выберите другой'));
    } else {
        const perms = queueChannel.permissionsFor(me);
        const can = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
            .every(flag => perms?.has(flag));
        checks.push(check('verification', `Бот пишет в #${queueChannel.name}`, can ? 'ok' : 'bad',
            can ? null : 'дайте боту в этом канале «Просматривать», «Отправлять сообщения» и «Встраивать ссылки»'));
    }
    checks.push(check('verification', 'Модуль пропуска', settings.modules.verification ? 'ok' : 'warn',
        settings.modules.verification ? null : 'выключен — карточки новичков не создаются'));
    const invites = InviteTracker.canTrack(guild.id);
    checks.push(check('verification', 'Видно, по чьему инвайту зашёл новичок', invites ? 'ok' : 'warn',
        invites ? null : 'дайте боту «Управлять сервером» — без него Discord не показывает инвайты'));

    if (settings.lockdown.channelIds.length === 0) {
        checks.push(check('lockdown', 'Стартовые каналы для Lockdown', 'warn', 'не выбраны — Lockdown только поставит инвайты на паузу'));
    } else {
        for (const channelId of settings.lockdown.channelIds) {
            const channel = guild.channels.cache.get(channelId);
            const can = Boolean(channel?.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels));
            checks.push(check('lockdown', channel ? `Slowmode в #${channel.name}` : 'Стартовый канал', can ? 'ok' : 'bad',
                !channel ? 'канал удалён — уберите его из списка' : (can ? null : 'дайте боту «Управлять каналом» в этом канале')));
        }
    }

    let dbMs = null;
    try {
        dbMs = await database();
        checks.push(check('system', 'База данных', 'ok'));
    } catch (error) {
        checks.push(check('system', 'База данных', 'bad', `недоступна: ${error.message || error}`));
    }

    return {
        checks,
        uptimeSeconds: Math.round(process.uptime()),
        pingMs: client?.ws?.ping >= 0 ? Math.round(client.ws.ping) : null,
        dbMs
    };
}

module.exports = { run, BOT_PERMISSIONS };
