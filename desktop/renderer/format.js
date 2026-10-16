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
    'moderation.ban_proposed': 'Предложен бан'
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
    return label;
}
