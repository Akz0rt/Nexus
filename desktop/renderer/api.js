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

export async function apiPut(path, body) {
    return window.panel.request('PUT', path, body);
}

export async function apiPatch(path, body) {
    return window.panel.request('PATCH', path, body);
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
    target_owner: 'Ник владельца сервера бот поменять не может.',
    nickname_too_long: 'Ник — не длиннее 32 символов.',
    invalid_nickname: 'Ник должен быть текстом.',
    note_empty: 'Напишите текст заметки.',
    note_too_long: 'Заметка — не длиннее 500 символов.',
    too_many_notes: 'У этого человека уже 50 заметок — удалите старые.',
    note_not_found: 'Заметку уже удалили.',
    not_note_author: 'Удалить заметку может её автор или администратор.',
    not_banned: 'Он уже не забанен.',
    already_banned: 'Он уже забанен.',
    warning_not_found: 'Варн уже снят или сгорел.',
    invalid_user_id: 'Это не похоже на ID пользователя Discord.',
    unauthorized: 'Сессия закончилась. Войдите снова.',
    invalid_targets: 'Никто не выбран.',
    invalid_name: 'Введите название.',
    invalid_limit: 'Лимит — число от 0 до 99.',
    need_two_channels: 'Для команд нужно хотя бы два канала.',
    channel_not_found: 'Голосовой канал не найден. Возможно, его удалили.',
    channel_forbidden: 'У вас нет доступа к этому каналу.',
    bot_cannot_channel: 'У бота нет прав в этом канале.',
    bot_missing_permission: 'Боту не хватает прав: «Перемещать участников», «Отключать участникам микрофон» или «Отключать участникам звук».',
    nobody: 'Некого трогать: в канале никого нет или всё уже сделано.',
    squad_not_found: 'Состав уже удалён.',
    rename_rate_limited: 'Discord разрешает переименовать канал только дважды за 10 минут. Попробуйте позже.',
    role_higher: 'Эта роль не ниже вашей высшей роли.',
    role_managed: 'Эту роль выдаёт интеграция, вручную её не выдать.',
    role_not_found: 'Роль не найдена.',
    bot_cannot_role: 'Роль бота ниже этой роли.',
    invalid_duration: 'Такого срока нет.',
    invalid_roles: 'Выберите от 1 до 25 ролей.',
    invalid_filter: 'Выберите, кому менять роль.',
    preset_not_found: 'Пресет уже удалён.',
    job_running: 'Уже идёт массовая выдача ролей. Дождитесь, пока она закончится.',
    too_many_targets: 'Слишком много людей за раз: не больше 5000.',
    already_active: 'Lockdown уже включён.',
    not_active: 'Lockdown уже снят.',
    bot_missing_manage_guild: 'Боту не хватает права «Управлять сервером».',
    report_not_found: 'Жалоба не найдена.',
    report_closed: 'Жалоба уже закрыта.',
    dm_closed: 'У человека закрыты личные сообщения.',
    event_not_found: 'Ивент не найден.',
    event_closed: 'Ивент уже прошёл или отменён.',
    menu_not_found: 'Меню ролей уже удалено.',
    already_muted: 'У него уже есть мут.',
    guild_not_found: 'Бот больше не на этом сервере.',
    invalid_action: 'Такого действия нет.',
    invalid_channel_id: 'Канал не найден.',
    invalid_delete_days: 'Удалять сообщения можно за 0–7 дней.',
    invalid_gender: 'Выберите «Парень» или «Девушка».',
    invalid_source: 'Такого источника нет.',
    invalid_tab: 'Такой вкладки нет.',
    invalid_days: 'От 1 до 365 дней.',
    role_gone: 'Этой роли уже нет в Discord.',
    not_personal: 'Это не личная роль.',
    discord_error: 'Discord не дал это сделать — возможно, боту не хватает прав.',
    invalid_steps: 'Выберите наказание: варн, мут, кик или бан.',
    template_not_found: 'Такого шаблона уже нет — обновите список.',
    invalid_templates: 'Проверьте шаблон: нужно название и хотя бы одно наказание.',
    template_changed: 'Администратор только что изменил этот шаблон — посмотрите, что в нём теперь, и выберите ещё раз.',
    report_other_member: 'Эта жалоба про другого участника.',
    not_found: 'Бот не знает такого запроса — возможно, он ещё не обновился до этой версии приложения.',
    internal_error: 'На стороне бота произошла ошибка.'
};

/** The raw code of a failed request, for tooltips (never shown as the message itself). */
export function errorCode(result) {
    return result?.error || (result?.status ? `HTTP ${result.status}` : null);
}

export function describeError(result) {
    if (result.error === 'already_handled' && result.body?.handledBy) {
        const who = result.body.handledBy.displayName || result.body.handledBy.id;
        const gender = GENDER_LABELS[result.body.card?.gender];
        return result.body.card?.status === 'kicked'
            ? `Уже кикнут: ${who}`
            : `Уже пропущен: ${who}${gender ? ` · ${gender}` : ''}`;
    }
    if (ERROR_TEXT[result.error]) return ERROR_TEXT[result.error];
    // status 0: the request never got an answer (the message is a network error, not a code)
    if (!result.status) return 'Нет связи с сервером бота.';
    // Unknown codes stay out of the text; ErrorState shows them in its tooltip
    return 'Что-то пошло не так. Попробуйте ещё раз.';
}
