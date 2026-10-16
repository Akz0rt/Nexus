// Thin wrapper over the preload bridge (window.panel). All network calls go through
// the Electron main process, which holds the session token.
import { GENDER_LABELS } from './format.js';

export async function apiGet(path) {
    const result = await window.panel.request('GET', path);
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
}

export async function apiPost(path, body) {
    return window.panel.request('POST', path, body);
}

export async function apiDelete(path) {
    return window.panel.request('DELETE', path);
}

const ERROR_TEXT = {
    not_configured: 'Пропуск не настроен на этом сервере: задайте UNVERIFIED_ROLE_ID и VERIFY_QUEUE_CHANNEL_ID.',
    forbidden: 'Нет прав на это действие.',
    in_progress: 'Этого новичка сейчас обрабатывает другой модератор.',
    member_left: 'Новичок уже вышел с сервера.',
    already_handled: 'Этого человека уже нет в очереди.',
    nothing_to_undo: 'Отменять уже нечего.',
    undo_expired: 'Время на отмену вышло. Верните человека в очередь вручную в Discord.',
    bot_offline: 'Бот сейчас не в сети. Действия недоступны, пока он не подключится.',
    reason_required: 'Укажите причину.',
    member_not_found: 'Этого человека нет на сервере.',
    user_not_found: 'Пользователь с таким ID не найден.',
    self: 'Себя наказать нельзя.',
    target_protected: 'Владельца сервера и ботов наказывать нельзя.',
    target_higher: 'Его высшая роль не ниже вашей. Это может сделать только старший.',
    bot_cannot: 'Боту не хватает прав или его роль ниже роли этого человека.',
    not_muted: 'Мута уже нет.',
    not_banned: 'Он уже не забанен.',
    already_banned: 'Он уже забанен.',
    warning_not_found: 'Варн уже снят или сгорел.',
    invalid_user_id: 'Это не похоже на ID пользователя Discord.',
    unauthorized: 'Сессия закончилась. Войдите снова.'
};

export function describeError(result) {
    if (result.error === 'already_handled' && result.body?.handledBy) {
        const who = result.body.handledBy.displayName || result.body.handledBy.id;
        const gender = GENDER_LABELS[result.body.card?.gender];
        return result.body.card?.status === 'kicked'
            ? `Уже кикнут: ${who}`
            : `Уже пропущен: ${who}${gender ? ` · ${gender}` : ''}`;
    }
    return ERROR_TEXT[result.error] || `Не удалось выполнить: ${result.error || 'нет связи с сервером'}`;
}
