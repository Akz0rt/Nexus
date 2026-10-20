import React, { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { describeBulk } from './format.js';

// Options (reason templates, durations) per server, loaded once
const optionsCache = new Map();

export function useModerationOptions(guildId) {
    const [options, setOptions] = useState(() => optionsCache.get(guildId) || null);
    useEffect(() => {
        if (optionsCache.has(guildId)) { setOptions(optionsCache.get(guildId)); return; }
        let cancelled = false;
        apiGet(`/guilds/${guildId}/moderation/options`)
            .then(data => { optionsCache.set(guildId, data); if (!cancelled) setOptions(data); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [guildId]);
    return options;
}

const KINDS = {
    warn: {
        title: 'Варн',
        submit: 'Выдать варн',
        done: 'Варн выдан',
        note: 'Человек не узнает о варне. Варн сгорит через 30 дней.'
    },
    mute: {
        title: 'Мут',
        submit: 'Выдать мут',
        done: 'Мут выдан',
        note: 'Бот отправит человеку сообщение со сроком и причиной.'
    },
    kick: {
        title: 'Кик',
        submit: 'Кикнуть',
        done: 'Кикнут',
        note: 'Человек сможет вернуться по приглашению.'
    },
    ban: {
        title: 'Бан',
        submit: 'Забанить',
        done: 'Забанен',
        note: 'Если человек на сервере, бот отправит ему сообщение со сроком и причиной.'
    }
};

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Warn / mute / kick / ban dialog.
 * target: { id, displayName } or null for "ban by ID";
 * targets: several members at once (the voice board's «Тайм-аут…»).
 */
export default function PunishDialog({ guildId, kind, target, targets, initial = {}, onClose, onDone, toast }) {
    const options = useModerationOptions(guildId);
    const meta = KINDS[kind];
    const [userId, setUserId] = useState(target?.id || '');
    // `initial`: what a command bar line already said («мут @ник 1ч флуд»)
    const [reason, setReason] = useState(initial.reason || '');
    const [duration, setDuration] = useState(initial.duration || (kind === 'mute' ? '1h' : 'forever'));
    const [deleteDays, setDeleteDays] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const firstField = useRef(null);

    useEffect(() => { firstField.current?.focus(); }, []);
    useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const submitMany = async body => {
        setBusy(true);
        setError(null);
        const done = [];
        const failed = [];
        for (const member of targets) {
            const result = await apiPost(`/guilds/${guildId}/moderation/${member.id}/${kind}`, body);
            if (result.ok) done.push(member.id);
            else failed.push({ userId: member.id, name: member.displayName, code: result.error });
        }
        setBusy(false);
        if (done.length === 0) { setError(describeError({ error: failed[0]?.code })); return; }
        toast(describeBulk(meta.done, { done, failed }), failed.length ? { tone: 'error', ttl: 8000 } : {});
        onDone?.({ done, failed });
        onClose();
    };

    const submit = async event => {
        event.preventDefault();
        if (targets) {
            if (!reason.trim()) { setError('Укажите причину.'); return; }
            const body = { reason: reason.trim() };
            if (kind === 'mute') body.duration = duration;
            await submitMany(body);
            return;
        }
        const id = userId.trim();
        if (!SNOWFLAKE_RE.test(id)) { setError('Введите ID пользователя: 17–20 цифр.'); return; }
        if (!reason.trim()) { setError('Укажите причину.'); return; }
        setBusy(true);
        setError(null);
        const body = { reason: reason.trim() };
        if (kind === 'mute') body.duration = duration;
        if (kind === 'ban') Object.assign(body, { duration, deleteMessageDays: deleteDays });
        const result = await apiPost(`/guilds/${guildId}/moderation/${id}/${kind}`, body);
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }

        const name = target?.displayName || id;
        let text = `${meta.done}: ${name}`;
        const escalation = result.data?.escalation;
        if (escalation?.action === 'timeout' && escalation.ok) text += '. Автоматически выдан мут по эскалации';
        if (escalation?.action === 'propose_ban' && escalation.ok) text += '. В канал модераторов ушло предложение бана';
        toast(text);
        onDone?.(result.data);
        onClose();
    };

    return (
        <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="punish-title" onSubmit={submit}>
                <h2 id="punish-title">
                    {meta.title}{targets ? `: ${targets.length} чел.` : target ? `: ${target.displayName || target.id}` : ' по ID'}
                </h2>

                {!target && !targets && (
                    <label className="field">
                        ID пользователя
                        <input ref={firstField} value={userId} onChange={e => setUserId(e.target.value)} inputMode="numeric" placeholder="123456789012345678" />
                    </label>
                )}

                {kind === 'mute' && (
                    <div className="field">
                        Срок
                        <div className="segmented" role="group" aria-label="Срок">
                        {(options?.muteDurations || []).map(d => (
                            <button type="button" key={d.id} className={`tab ${duration === d.id ? 'is-active' : ''}`}
                                aria-pressed={duration === d.id} onClick={() => setDuration(d.id)}>{d.label}</button>
                        ))}
                        </div>
                    </div>
                )}

                {kind === 'ban' && (
                    <>
                        <div className="field">
                            Срок
                            <div className="segmented" role="group" aria-label="Срок">
                            {(options?.banDurations || []).map(d => (
                                <button type="button" key={d.id} className={`tab ${duration === d.id ? 'is-active' : ''}`}
                                    aria-pressed={duration === d.id} onClick={() => setDuration(d.id)}>{d.label}</button>
                            ))}
                            </div>
                        </div>
                        <label className="field">
                            Удалить его сообщения
                            <select value={deleteDays} onChange={e => setDeleteDays(Number(e.target.value))}>
                                {(options?.banDeleteDays || [0]).map(days => (
                                    <option key={days} value={days}>{days === 0 ? 'не удалять' : `за ${days} ${days === 1 ? 'день' : 'дней'}`}</option>
                                ))}
                            </select>
                        </label>
                    </>
                )}

                <div className="field">
                    Причина
                    <div className="reason-chips">
                        {(options?.reasons || []).map(template => (
                            <button type="button" key={template}
                                className={`chip ${reason === template ? 'is-active' : ''}`}
                                onClick={() => setReason(template)}>{template}</button>
                        ))}
                    </div>
                    <input ref={target || targets ? firstField : undefined} value={reason} maxLength={400}
                        onChange={e => setReason(e.target.value)} placeholder="Шаблон выше или своя причина" aria-label="Причина" />
                </div>

                <p className="muted small">{meta.note}</p>
                {error && <p className="error">{error}</p>}

                <div className="dialog-actions">
                    <button type="button" className="btn btn-quiet" onClick={onClose}>Отмена</button>
                    <button type="submit" className={`btn ${kind === 'warn' || kind === 'mute' ? 'btn-primary' : 'btn-danger-solid'}`} disabled={busy}>
                        {busy ? 'Выполняем…' : meta.submit}
                    </button>
                </div>
            </form>
        </div>
    );
}
