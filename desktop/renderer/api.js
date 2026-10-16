// Thin wrapper over the preload bridge (window.panel). All network calls go through
// the Electron main process, which holds the session token.

export async function apiGet(path) {
    const result = await window.panel.request('GET', path);
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
}

export async function apiPost(path, body) {
    return window.panel.request('POST', path, body);
}

export const ERROR_TEXT = {
    not_configured: 'Модуль пропуска не настроен на этом сервере.',
    forbidden: 'Нет прав на это действие.',
    in_progress: 'Этого новичка уже обрабатывает другой модератор.',
    member_left: 'Новичок уже вышел с сервера.',
    already_handled: 'Уже обработан.',
    bot_offline: 'Бот сейчас не в сети.',
    reason_required: 'Укажите причину.'
};

export function describeError(result) {
    if (result.error === 'already_handled' && result.body?.handledBy) {
        const who = result.body.handledBy.displayName || result.body.handledBy.id;
        const gender = result.body.card?.gender === 'male' ? 'Парень' : result.body.card?.gender === 'female' ? 'Девушка' : '';
        return `Уже обработал(а) ${who}${gender ? ` · ${gender}` : ''}`;
    }
    return ERROR_TEXT[result.error] || `Ошибка: ${result.error}`;
}
