import React, { useState } from 'react';
import { apiPost, describeError } from './api.js';
import { formatTime } from './format.js';
import Dialog from './Dialog.jsx';

function slowmodeLabel(seconds) {
    if (seconds < 60) return `${seconds} с`;
    if (seconds < 3600) return `${seconds / 60} мин`;
    return `${seconds / 3600} ч`;
}

/** Red strip under the header while the server is closed — everyone sees it. */
export function LockdownBanner({ lockdown }) {
    return (
        <div className="banner banner-lockdown" role="status">
            <strong>Сервер закрыт (Lockdown)</strong>
            <span>· включил {lockdown.actorTag || 'администратор'} · {formatTime(lockdown.since)}</span>
            <span className="muted small">Инвайты на паузе{lockdown.channelIds.length ? `, slowmode ${slowmodeLabel(lockdown.slowmodeSeconds)} в стартовых каналах` : ''}.</span>
        </div>
    );
}

/** Header button for administrators: turn Lockdown on or off, after a confirmation. */
export default function LockdownButton({ guildId, lockdown, onChange, toast }) {
    const [confirm, setConfirm] = useState(false);
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
        toast((active ? 'Lockdown снят' : 'Lockdown включён')
            + (failed.length ? ` · не удалось: ${failed.map(f => f.name ? `#${f.name}` : 'удалённый канал').join(', ')}` : ''),
        failed.length ? { tone: 'error', ttl: 8000 } : {});
        setConfirm(false);
    };

    return (
        <>
            <button className={`btn lockdown-button ${active ? 'is-active' : ''}`} onClick={() => { setError(null); setConfirm(true); }}>
                {active ? 'Снять Lockdown' : 'Lockdown'}
            </button>
            {confirm && (
                <Dialog title={active ? 'Снять Lockdown?' : 'Закрыть сервер?'} onClose={() => setConfirm(false)} onSubmit={submit}
                    submitLabel={active ? 'Снять' : 'Включить Lockdown'} submitTone={active ? 'primary' : 'danger'} busy={busy}>
                    {active ? (
                        <p className="muted">Инвайты снова заработают, в стартовых каналах вернётся прежний slowmode.</p>
                    ) : (
                        <>
                            <p>Новые люди не смогут зайти ни по одной ссылке{lockdown?.channelIds?.length
                                ? `, в стартовых каналах включится slowmode ${slowmodeLabel(lockdown.slowmodeSeconds)}` : ''}.</p>
                            {!lockdown?.channelIds?.length && <p className="muted small">Стартовые каналы не выбраны: их задают в Настройках.</p>}
                            <p className="muted small">Повторное нажатие всё вернёт как было.</p>
                        </>
                    )}
                    {error && <p className="error">{error}</p>}
                </Dialog>
            )}
        </>
    );
}
