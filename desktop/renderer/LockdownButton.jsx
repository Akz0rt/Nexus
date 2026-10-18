import React, { useState } from 'react';
import { apiPost, describeError } from './api.js';
import { formatDateTime, formatTime } from './format.js';
import Dialog from './Dialog.jsx';
import Icon from './icons.jsx';

function slowmodeLabel(seconds) {
    if (seconds < 60) return `${seconds} с`;
    if (seconds < 3600) return `${seconds / 60} мин`;
    return `${seconds / 3600} ч`;
}

/** «21:24» today, «17.10.26, 21:24» on another day */
function sinceLabel(iso) {
    if (!iso) return '';
    return new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso);
}

/** What Lockdown did, in words: «инвайты на паузе, slowmode 30 с в #старт, #правила» */
function whatWasDone(lockdown) {
    const parts = [];
    if (lockdown.invitesPaused) parts.push('инвайты на паузе');
    const names = (lockdown.channels || []).map(c => (c.name ? `#${c.name}` : 'удалённый канал'));
    if (names.length) parts.push(`slowmode ${slowmodeLabel(lockdown.slowmodeSeconds)} в ${names.join(', ')}`);
    return parts.join(', ');
}

/** Red strip under the header while the server is closed — everyone sees it, administrators can act. */
export function LockdownBanner({ lockdown, canManage, onEdit, onOpen }) {
    const done = whatWasDone(lockdown);
    return (
        <div className="lockdown-banner" role="alert">
            <Icon name="lock" size={18} strokeWidth={2} />
            <span className="lockdown-banner-text">
                <strong>Сервер закрыт</strong>{' '}
                <span>
                    с <span title={formatDateTime(lockdown.since)}>{sinceLabel(lockdown.since)}</span>
                    {' · '}включил {lockdown.actorTag || 'администратор'}{done && ` · ${done}`}
                </span>
            </span>
            {canManage && (
                <>
                    <button type="button" className="btn btn-banner" onClick={onEdit}>Изменить</button>
                    <button type="button" className="btn btn-banner-main" onClick={onOpen}>Открыть сервер</button>
                </>
            )}
        </div>
    );
}

/**
 * Header button for administrators. Off: a neutral lock; on: red «Сервер закрыт».
 * Either way a click asks first (`confirm` lives in App so the banner can open it too).
 */
export default function LockdownButton({ guildId, lockdown, onChange, toast, confirm, onConfirm }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const active = Boolean(lockdown?.active);

    const submit = async () => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/lockdown/${active ? 'off' : 'on'}`);
        setBusy(false);
        if (!result.ok) {
            setError(result.error === 'bot_missing_manage_guild'
                ? 'Боту не хватает права «Управлять сервером»: без него Discord не даёт поставить инвайты на паузу.'
                : describeError(result));
            return;
        }
        onChange(result.data.status);
        const failed = result.data.failed || [];
        toast((active ? 'Сервер открыт' : 'Сервер закрыт')
            + (failed.length ? ` · не удалось: ${failed.map(f => f.name ? `#${f.name}` : 'удалённый канал').join(', ')}` : ''),
        failed.length ? { tone: 'error', ttl: 8000 } : {});
        onConfirm(false);
    };

    return (
        <>
            <button type="button" className={`btn lockdown-button ${active ? 'is-active' : ''}`}
                title={active ? 'Открыть сервер' : 'Закрыть сервер для новых людей'}
                onClick={() => { setError(null); onConfirm(true); }}>
                <Icon name="lock" size={16} strokeWidth={active ? 2.2 : 2} />
                {active ? 'Сервер закрыт' : 'Lockdown'}
            </button>
            {confirm && (
                <Dialog title={active ? 'Открыть сервер?' : 'Закрыть сервер?'} onClose={() => onConfirm(false)} onSubmit={submit}
                    submitLabel={active ? 'Открыть сервер' : 'Закрыть сервер'} submitTone={active ? 'primary' : 'danger'} busy={busy}>
                    {active ? (
                        <p className="muted">Инвайты снова заработают, в стартовых каналах вернётся прежний slowmode.</p>
                    ) : (
                        <>
                            <p>Новые люди не смогут зайти ни по одной ссылке{lockdown?.channelIds?.length
                                ? `, в стартовых каналах включится slowmode ${slowmodeLabel(lockdown.slowmodeSeconds)}` : ''}.</p>
                            {!lockdown?.channelIds?.length && <p className="muted small">Стартовые каналы не выбраны: их задают в Настройках → Lockdown.</p>}
                            <p className="muted small">Открыть сервер можно той же кнопкой — всё вернётся как было.</p>
                        </>
                    )}
                    {error && <p className="error">{error}</p>}
                </Dialog>
            )}
        </>
    );
}
