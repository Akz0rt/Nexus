export const ACTION_LABELS = {
    'verification.queued': 'Новичок в очереди',
    'verification.approved': 'Пропуск',
    'verification.undone': 'Пропуск отменён',
    'verification.kicked': 'Кик из очереди',
    'verification.role_removed': '@АНверефи снята вручную',
    'verification.left': 'Вышел из очереди',
    'verification.role_assigned': 'Выдана @АНверефи при входе',
    'moderation.warned': 'Варн',
    'moderation.unwarned': 'Варн снят',
    'moderation.muted': 'Мут',
    'moderation.unmuted': 'Мут снят',
    'moderation.kicked': 'Кик',
    'moderation.banned': 'Бан',
    'moderation.unbanned': 'Разбан',
    'moderation.ban_proposed': 'Предложен бан',
    'voice.moved': 'Перемещение',
    'voice.move_undone': 'Перемещение отменено',
    'voice.split': 'Разбивка на команды',
    'voice.gathered': 'Сбор в канал',
    'voice.muted': 'Микро выключен',
    'voice.unmuted': 'Микро включён',
    'voice.deafened': 'Звук выключен',
    'voice.undeafened': 'Звук включён',
    'voice.disconnected': 'Отключён от голоса',
    'voice.channel_locked': 'Канал закрыт',
    'voice.channel_unlocked': 'Канал открыт',
    'voice.channel_edited': 'Канал изменён',
    'voice.squad_saved': 'Состав сохранён',
    'voice.squad_deleted': 'Состав удалён',
    'voice.squad_invited': 'Приглашение в голос',
    'roles.added': 'Роль выдана',
    'roles.removed': 'Роль снята',
    'roles.temp_expired': 'Срок роли истёк',
    'roles.preset_applied': 'Применён пресет',
    'roles.preset_saved': 'Пресет сохранён',
    'roles.preset_deleted': 'Пресет удалён',
    'message.deleted': 'Сообщение удалено',
    'message.edited': 'Сообщение изменено',
    'message.bulk_deleted': 'Сообщения очищены'
};

/** Groups for the journal filter ("message.*" matches every message action). */
export const ACTION_GROUPS = { 'message.*': 'Сообщения: все' };

/** How long a temporary role lasts (ids match the server's ROLE_DURATIONS). */
export const ROLE_DURATIONS = [
    { id: '', label: 'Навсегда' },
    { id: '1h', label: '1 час' },
    { id: '6h', label: '6 часов' },
    { id: '1d', label: '1 день' },
    { id: '7d', label: '7 дней' },
    { id: '30d', label: '30 дней' }
];

/** Why a role can't be given from the panel. */
export const ROLE_PROBLEMS = {
    role_managed: 'выдаёт интеграция',
    role_higher: 'не ниже вашей роли',
    bot_cannot_role: 'бот не может выдавать',
    role_not_found: 'роль удалена'
};

export const SOURCE_LABELS = { discord: 'Discord', bot: 'Бот', panel: 'Панель', auto: 'Авто' };

export const GENDER_LABELS = { male: 'Парень', female: 'Девушка' };

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDateTime(iso, withSeconds = false) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined
    });
}

export function formatTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
}

/** "3 ч назад", "2 дн. назад" */
export function timeAgo(iso) {
    if (!iso) return '—';
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.round(hours / 24)} дн. назад`;
}

/** "осталось 42 мин", "осталось 5 ч", "осталось 3 дн." */
export function timeLeft(iso) {
    if (!iso) return '';
    const minutes = Math.ceil((Date.parse(iso) - Date.now()) / 60000);
    if (minutes <= 0) return 'истекает';
    if (minutes < 60) return `осталось ${minutes} мин`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `осталось ${hours} ч`;
    return `осталось ${Math.round(hours / 24)} дн.`;
}

/** Duration of a mute/ban from the log: "1 ч", "7 дн.", "навсегда" */
export function formatDurationMs(ms) {
    if (!ms) return 'навсегда';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} мин`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} ч`;
    return `${Math.round(minutes / 1440)} дн.`;
}

export function accountAge(iso) {
    const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
    if (days < 1) return 'меньше дня';
    if (days < 60) return `${days} дн.`;
    const months = Math.floor(days / 30);
    if (months < 24) return `${months} мес.`;
    return `${Math.floor(days / 365)} г.`;
}

/** CSV with ; separator (what Russian-locale Excel expects) */
export function toCsv(rows) {
    const cell = value => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return rows.map(row => row.map(cell).join(';')).join('\r\n');
}

/** Journal line: "Пропуск · Девушка", "Мут · 1 ч", "Бан · навсегда" */
export function describeAction(entry) {
    const label = ACTION_LABELS[entry.action] || entry.action;
    const gender = GENDER_LABELS[entry.details?.gender];
    if (gender) return `${label} · ${gender}`;
    if (entry.action === 'moderation.muted' || entry.action === 'moderation.banned') {
        return `${label} · ${formatDurationMs(entry.details?.durationMs)}`;
    }
    if (entry.action === 'moderation.warned' && entry.details?.activeWarns) {
        return `${label} · ${entry.details.activeWarns}-й активный`;
    }
    if (entry.action.startsWith('message.')) {
        const where = entry.details?.channelName ? ` · #${entry.details.channelName}` : '';
        const count = entry.action === 'message.bulk_deleted' ? ` · ${entry.details?.count || 0} шт.` : '';
        return `${label}${where}${count}`;
    }
    if (entry.action === 'roles.temp_expired' && entry.details?.failed) {
        return `Срок роли истёк, но бот не смог её снять · ${entry.details.roleName}`;
    }
    if (entry.action === 'roles.added' && entry.details?.durationMs) {
        return `${label} · ${entry.details.roleName} · на ${formatDurationMs(entry.details.durationMs)}`;
    }
    const subject = entry.details?.roleName || entry.details?.presetName || entry.details?.squadName || entry.details?.channelName;
    const many = entry.details?.count > 1 && (entry.action === 'roles.added' || entry.action === 'roles.removed')
        ? ` · ${entry.details.count} чел.` : '';
    if (subject) return `${label} · ${subject}${many}`;
    return label;
}

/** Message text for the journal: the deleted text, or "было → стало" for an edit. */
export function describeMessage(entry) {
    const details = entry.details || {};
    if (entry.action === 'message.edited') return `${details.content || '—'} → ${details.newContent || '—'}`;
    if (entry.action === 'message.deleted') {
        const files = details.attachments?.length ? ` [файлы: ${details.attachments.join(', ')}]` : '';
        return `${details.content || ''}${files}`.trim();
    }
    return '';
}

/** Why one member was skipped in a group action. */
export const FAILURE_LABELS = {
    has_permanent: 'роль уже есть навсегда',
    not_in_voice: 'не в голосе',
    target_higher: 'роль не ниже вашей',
    target_protected: 'владелец сервера',
    member_not_found: 'нет на сервере',
    bot_cannot: 'боту не хватает прав',
    dm_closed: 'закрыты ЛС',
    failed: 'ошибка Discord'
};

/** "Перемещено 7 из 8 · Bob — не в голосе" */
export function describeBulk(verb, data) {
    const total = data.done.length + data.failed.length;
    const parts = [`${verb} ${data.done.length} из ${total}`];
    const byCode = new Map();
    for (const failure of data.failed) {
        if (!byCode.has(failure.code)) byCode.set(failure.code, []);
        byCode.get(failure.code).push(failure.name || failure.userId);
    }
    for (const [code, names] of byCode) {
        const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` и ещё ${names.length - 2}` : '');
        parts.push(`${shown} — ${FAILURE_LABELS[code] || code}`);
    }
    return parts.join(' · ');
}

/** "12 мин", "2 ч 05 мин" in a voice channel */
export function formatSince(iso) {
    if (!iso) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 60) return `${minutes} мин`;
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}
