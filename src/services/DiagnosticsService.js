const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('./GuildSettingsService');
const CosmosDBService = require('./CosmosDBService');
const AuditLogService = require('./AuditLogService');
const InviteTracker = require('../modules/invites/InviteTracker');
const config = require('../config');

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
    { flag: PermissionFlagsBits.ManageGuild, label: 'Управлять сервером', hint: 'без него Lockdown не может поставить инвайты на паузу, в Пропуске не видно, по чьему инвайту зашёл новичок, и бот не может менять баннер' },
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

    // Azure variables (and the old shared birthday list) belong to GUILD_ID; without it they go
    // to the oldest server and the old list isn't copied anywhere. Shown on that server only
    if (!config.guildId && (client?.guilds?.cache.size || 0) > 1 && guild.id === GuildSettingsService.mainGuildId(client)) {
        checks.push(check('birthdays', 'Основной сервер бота', 'warn', 'GUILD_ID не задан — настройки из Azure действуют на самый старый сервер, старый список дней рождения не перенесён',
            { steps: ['Azure → App Service → Configuration → GUILD_ID: укажите ID основного сервера.', 'Перезапустите бота: App Service → Restart.'] }));
    }
    {
        // Every server has its own birthdays; without a channel they just aren't congratulated
        const channelId = settings.birthdayCongratsChannelId || settings.birthdayAnnounceChannelId;
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (!channelId) {
            // A problem once people have set their dates here; otherwise birthdays just aren't used
            const used = Object.keys(await CosmosDBService.getAllBirthdays(guild.id).catch(() => ({}))).length > 0;
            checks.push(check('birthdays', 'Канал поздравлений', used ? 'bad' : 'warn',
                used ? 'не выбран — поздравлять некуда' : 'не выбран — дни рождения не поздравляются', FIX.pick('выберите канал поздравлений', 'birthdays')));
        } else if (!channel) {
            checks.push(check('birthdays', 'Канал поздравлений', 'bad', 'канал удалён — выберите другой', FIX.pick('выберите другой канал поздравлений', 'birthdays')));
        } else {
            const perms = channel.permissionsFor?.(me);
            const can = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].every(flag => perms?.has(flag));
            checks.push(check('birthdays', `Бот поздравляет в #${channel.name}`, can ? 'ok' : 'bad',
                can ? null : 'боту не хватает прав в этом канале', FIX.channelPermissions(channel.name, SEND_PERMISSIONS)));
        }
    }

    // Server banner: only once it is turned on — otherwise the bot doesn't touch it
    if (settings.banner?.enabled) {
        const BannerStore = require('../banner/store');
        const [state, background] = await Promise.all([
            BannerStore.getState(guild.id).catch(() => ({})),
            BannerStore.readDoc(guild.id, 'background').catch(() => null)
        ]);
        const features = guild.features || [];
        checks.push(check('banner', 'Баннер сервера доступен', features.includes('BANNER') ? 'ok' : 'bad',
            'нужен 2-й уровень буста — до него Discord не даёт ставить баннер', { steps: ['Наберите 2-й уровень буста сервера (7 бустов).'] }));
        if (!background) {
            checks.push(check('banner', 'Фон баннера', 'bad', 'не загружен — бот не меняет баннер', { steps: ['Откройте экран «Баннер» и загрузите фон.'] }));
        } else {
            checks.push(check('banner', `Фон «${background.name}»`, 'ok'));
            if (background.animated) {
                const animated = features.includes('ANIMATED_BANNER');
                checks.push(check('banner', 'Анимированный баннер', animated ? 'ok' : 'warn',
                    animated ? null : 'нужен 3-й уровень буста — пока ставится первый кадр', { steps: ['Наберите 3-й уровень буста сервера (14 бустов).'] }));
            }
        }
        if (state.lastError) {
            checks.push(check('banner', 'Последнее обновление баннера', 'bad', state.lastError.message || state.lastError.code,
                { steps: ['Исправьте причину и нажмите «Обновить сейчас» на экране «Баннер».'] }));
        }
    }

    let dbMs = null;
    try {
        dbMs = await database();
        checks.push(check('system', 'База данных', 'ok'));
    } catch (error) {
        // The error text is about the bot's own database, not this server: it stays in the log
        console.error('Diagnostics: database check failed:', error.message || error);
        checks.push(check('system', 'База данных', 'bad', 'недоступна', { steps: [
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
