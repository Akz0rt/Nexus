const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('./GuildSettingsService');
const AuditLogService = require('./AuditLogService');
const InviteTracker = require('../modules/invites/InviteTracker');
const { birthdayGuildId } = require('../modules/birthdays');

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

/**
 * One line of the diagnostics. `fix` — «Как исправить»: the steps, and the Settings
 * section where it is fixed inside the app (if it is).
 */
function check(group, label, level, hint = null, fix = null) {
    return { group, label, level, hint, fix: level === 'ok' ? null : fix };
}

// «Как исправить» for the usual causes
const FIX = {
    intent: name => ({ steps: [
        'Откройте discord.com/developers/applications → приложение бота → Bot.',
        `В «Privileged Gateway Intents» включите «${name}» и сохраните.`,
        'Перезапустите бота: Azure → App Service → Restart.'
    ] }),
    permission: name => ({ steps: [
        'Discord → Настройки сервера → Роли → роль бота.',
        `Включите право «${name}» и сохраните.`,
        'Бот увидит изменение сразу — нажмите «Проверить снова».'
    ] }),
    roleAboveBot: name => ({ steps: [
        'Discord → Настройки сервера → Роли.',
        `Перетащите роль бота выше роли «${name}» и сохраните.`
    ] }),
    pick: (what, section) => ({ section, steps: [`Откройте раздел ниже, ${what} и сохраните.`] }),
    channelPermissions: (name, permissions) => ({ steps: [
        `Discord → канал #${name} → «Изменить канал» → «Права доступа».`,
        `Добавьте роль бота и включите: ${permissions}.`
    ] })
};
const SEND_PERMISSIONS = '«Просматривать канал», «Отправлять сообщения», «Встраивать ссылки»';

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
        checks.push(check('intents', label, on ? 'ok' : 'bad', on ? null : 'включите в Discord Developer Portal → Bot', FIX.intent(label)));
    }

    const isAdmin = Boolean(me?.permissions.has(PermissionFlagsBits.Administrator));
    for (const permission of BOT_PERMISSIONS) {
        const has = Boolean(me?.permissions.has(permission.flag));
        checks.push(check('permissions', permission.label, has ? 'ok' : 'bad', has ? null : permission.hint, FIX.permission(permission.label)));
    }
    if (isAdmin) checks.push(check('permissions', 'У бота есть «Администратор» — все права выше есть', 'ok'));

    // Roles the bot hands out must sit below its highest role
    const botTop = me?.roles.highest.position ?? 0;
    const roleKeys = [['unverifiedRoleId', '@АНверефи'], ['maleRoleId', 'Парень'], ['femaleRoleId', 'Девушка']];
    for (const [key, label] of roleKeys) {
        const id = settings[key];
        if (!id) {
            checks.push(check('verification', `Роль «${label}»`, 'bad', 'не выбрана — выберите её в разделе «Пропуск»', FIX.pick(`выберите роль «${label}»`, 'verification')));
            continue;
        }
        const role = guild.roles.cache.get(id);
        if (!role) checks.push(check('verification', `Роль «${label}»`, 'bad', 'роль удалена — выберите другую', FIX.pick(`выберите новую роль «${label}»`, 'verification')));
        else if (role.position >= botTop) checks.push(check('verification', `Роль «${role.name}» ниже роли бота`, 'bad', 'перетащите роль бота выше в настройках сервера', FIX.roleAboveBot(role.name)));
        else checks.push(check('verification', `Роль «${role.name}» ниже роли бота`, 'ok'));
    }

    const queueChannel = settings.verifyQueueChannelId ? guild.channels.cache.get(settings.verifyQueueChannelId) : null;
    if (!settings.verifyQueueChannelId) {
        checks.push(check('verification', 'Канал очереди', 'bad', 'не выбран — карточки новичков некуда присылать', FIX.pick('выберите канал очереди', 'verification')));
    } else if (!queueChannel) {
        checks.push(check('verification', 'Канал очереди', 'bad', 'канал удалён — выберите другой', FIX.pick('выберите другой канал очереди', 'verification')));
    } else {
        const perms = queueChannel.permissionsFor(me);
        const can = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
            .every(flag => perms?.has(flag));
        checks.push(check('verification', `Бот пишет в #${queueChannel.name}`, can ? 'ok' : 'bad',
            can ? null : 'дайте боту в этом канале «Просматривать», «Отправлять сообщения» и «Встраивать ссылки»',
            FIX.channelPermissions(queueChannel.name, SEND_PERMISSIONS)));
    }
    checks.push(check('verification', 'Модуль пропуска', settings.modules.verification ? 'ok' : 'warn',
        settings.modules.verification ? null : 'выключен — карточки новичков не создаются', FIX.pick('включите «Модуль пропуска»', 'verification')));
    const invites = InviteTracker.canTrack(guild.id);
    checks.push(check('verification', 'Видно, по чьему инвайту зашёл новичок', invites ? 'ok' : 'warn',
        invites ? null : 'дайте боту «Управлять сервером» — без него Discord не показывает инвайты', FIX.permission('Управлять сервером')));

    if (settings.lockdown.channelIds.length === 0) {
        checks.push(check('lockdown', 'Стартовые каналы для Lockdown', 'warn', 'не выбраны — Lockdown только поставит инвайты на паузу', FIX.pick('отметьте каналы, где новички пишут первыми', 'lockdown')));
    } else {
        for (const channelId of settings.lockdown.channelIds) {
            const channel = guild.channels.cache.get(channelId);
            const can = Boolean(channel?.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels));
            checks.push(check('lockdown', channel ? `Slowmode в #${channel.name}` : 'Стартовый канал', can ? 'ok' : 'bad',
                !channel ? 'канал удалён — уберите его из списка' : (can ? null : 'дайте боту «Управлять каналом» в этом канале'),
                !channel ? FIX.pick('снимите отметку с удалённого канала', 'lockdown') : FIX.channelPermissions(channel.name, '«Управлять каналом»')));
        }
    }

    // Birthdays: the main server only (one list for the bot)
    if (guild.id === birthdayGuildId(client)) {
        const channelId = settings.birthdayCongratsChannelId || settings.birthdayAnnounceChannelId;
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (!channelId) {
            checks.push(check('birthdays', 'Канал поздравлений', 'bad', 'не выбран — поздравлять некуда', FIX.pick('выберите канал поздравлений', 'birthdays')));
        } else if (!channel) {
            checks.push(check('birthdays', 'Канал поздравлений', 'bad', 'канал удалён — выберите другой', FIX.pick('выберите другой канал поздравлений', 'birthdays')));
        } else {
            const perms = channel.permissionsFor?.(me);
            const can = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].every(flag => perms?.has(flag));
            checks.push(check('birthdays', `Бот поздравляет в #${channel.name}`, can ? 'ok' : 'bad',
                can ? null : 'боту не хватает прав в этом канале', FIX.channelPermissions(channel.name, SEND_PERMISSIONS)));
        }
    }

    let dbMs = null;
    try {
        dbMs = await database();
        checks.push(check('system', 'База данных', 'ok'));
    } catch (error) {
        checks.push(check('system', 'База данных', 'bad', `недоступна: ${error.message || error}`, { steps: [
            'Azure → Cosmos DB: проверьте, что аккаунт работает и не упёрся в лимит.',
            'Azure → App Service → Configuration: проверьте COSMOS_ENDPOINT и COSMOS_KEY.',
            'Перезапустите бота: App Service → Restart.'
        ] }));
    }

    return {
        checks,
        uptimeSeconds: Math.round(process.uptime()),
        pingMs: client?.ws?.ping >= 0 ? Math.round(client.ws.ping) : null,
        dbMs
    };
}

module.exports = { run, BOT_PERMISSIONS };
