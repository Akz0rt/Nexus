export const ACTION_LABELS = {
    'verification.queued': 'Новичок в очереди',
    'verification.approved': 'Пропуск',
    'verification.undone': 'Пропуск отменён',
    'verification.kicked': 'Кик из очереди',
    'verification.role_removed': '@АНверефи снята вручную',
    'verification.left': 'Вышел из очереди',
    'verification.role_assigned': 'Выдана @АНверефи при входе'
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
