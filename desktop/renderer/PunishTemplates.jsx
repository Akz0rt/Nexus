import React, { useEffect, useState } from 'react';
import { apiGet, apiPut, describeError } from './api.js';
import { useModerationOptions } from './PunishDialog.jsx';

// Punishment templates per server, loaded once and refreshed after a save
const cache = new Map();
const listeners = new Set();

/** { items, canEdit } of a server, or null while loading */
export function useTemplates(guildId) {
    const [data, setData] = useState(() => cache.get(guildId) || null);
    useEffect(() => {
        const update = () => setData(cache.get(guildId) || null);
        listeners.add(update);
        if (!cache.has(guildId)) {
            apiGet(`/guilds/${guildId}/moderation/templates`)
                .then(result => { cache.set(guildId, result); listeners.forEach(fn => fn()); })
                .catch(() => {});
        } else {
            update();
        }
        return () => listeners.delete(update);
    }, [guildId]);
    return data;
}

function remember(guildId, items) {
    cache.set(guildId, { ...(cache.get(guildId) || {}), items });
    listeners.forEach(fn => fn());
}

const SHORT_MUTE = { '10m': '10 мин', '1h': '1 ч', '6h': '6 ч', '1d': '1 день', '7d': '7 дней' };

/** «мут 10 мин + варн» (the bot sends the same text as `summary`) */
export function stepsText(steps) {
    const order = { mute: 0, ban: 1, kick: 2, warn: 3 };
    return [...steps].sort((a, b) => order[a.kind] - order[b.kind]).map(step => {
        if (step.kind === 'mute') return `мут ${SHORT_MUTE[step.duration] || step.duration}`;
        if (step.kind === 'ban') {
            const span = step.duration === 'forever' ? 'навсегда' : step.duration === '7d' ? '7 дн.' : step.duration === '30d' ? '30 дн.' : step.duration;
            return `бан ${span}${step.deleteDays ? `, удалить за ${step.deleteDays === 1 ? '24 ч' : `${step.deleteDays} дн.`}` : ''}`;
        }
        return step.kind === 'kick' ? 'кик' : 'варн';
    }).join(' + ');
}

/**
 * Pick the steps of a punishment: варн, мут (срок), кик или бан (срок, удалить сообщения).
 * value / onChange: the steps array.
 */
export function StepsEditor({ guildId, value, onChange }) {
    const options = useModerationOptions(guildId);
    const has = kind => value.find(step => step.kind === kind);
    const toggle = (kind, defaults) => {
        if (has(kind)) { onChange(value.filter(step => step.kind !== kind)); return; }
        // Kick and ban don't go together
        const rest = value.filter(step => !(kind === 'kick' && step.kind === 'ban') && !(kind === 'ban' && step.kind === 'kick'));
        onChange([...rest, { kind, ...defaults }]);
    };
    const set = (kind, patch) => onChange(value.map(step => (step.kind === kind ? { ...step, ...patch } : step)));
    const mute = has('mute');
    const ban = has('ban');
    return (
        <div className="steps-editor">
            <label className="check"><input type="checkbox" checked={Boolean(has('warn'))} onChange={() => toggle('warn')} />Варн</label>
            <div className="step-line">
                <label className="check"><input type="checkbox" checked={Boolean(mute)} onChange={() => toggle('mute', { duration: '1h' })} />Мут</label>
                {mute && (
                    <select aria-label="Срок мута" value={mute.duration} onChange={e => set('mute', { duration: e.target.value })}>
                        {(options?.muteDurations || []).map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                )}
            </div>
            <label className="check"><input type="checkbox" checked={Boolean(has('kick'))} onChange={() => toggle('kick')} />Кик</label>
            <div className="step-line">
                <label className="check"><input type="checkbox" checked={Boolean(ban)} onChange={() => toggle('ban', { duration: 'forever', deleteDays: 0 })} />Бан</label>
                {ban && (
                    <>
                        <select aria-label="Срок бана" value={ban.duration} onChange={e => set('ban', { duration: e.target.value })}>
                            {(options?.banDurations || []).map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                        </select>
                        <select aria-label="Удалить его сообщения" value={ban.deleteDays} onChange={e => set('ban', { deleteDays: Number(e.target.value) })}>
                            {(options?.banDeleteDays || [0]).map(days => (
                                <option key={days} value={days}>{days === 0 ? 'сообщения не удалять' : `удалить сообщения за ${days === 1 ? '24 ч' : `${days} дн.`}`}</option>
                            ))}
                        </select>
                    </>
                )}
            </div>
        </div>
    );
}

function TemplateEditor({ guildId, template, onCancel, onSave, onDelete, busy }) {
    const [name, setName] = useState(template?.name || '');
    const [reason, setReason] = useState(template?.reason || '');
    const [steps, setSteps] = useState(template?.steps || [{ kind: 'warn' }]);
    const valid = name.trim() && steps.length > 0;
    return (
        <form className="template-editor" onSubmit={event => { event.preventDefault(); if (valid) onSave({ ...template, name: name.trim(), reason: reason.trim() || name.trim(), steps }); }}>
            <label className="field">Название<input autoFocus value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Флуд" /></label>
            <label className="field">Причина (её увидят в журнале и в ЛС)<input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} placeholder={name || 'Флуд'} /></label>
            <StepsEditor guildId={guildId} value={steps} onChange={setSteps} />
            <div className="template-editor-actions">
                {onDelete && <button type="button" className="btn btn-quiet btn-small" onClick={onDelete} disabled={busy}>Удалить</button>}
                <span className="toolbar-spacer" />
                <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>Отмена</button>
                <button type="submit" className="btn btn-primary btn-small" disabled={!valid || busy}>Сохранить</button>
            </div>
        </form>
    );
}

/** Beside the reports: the templates «Наказать…» offers first; administrators edit them here. */
export default function TemplatesPanel({ guildId, toast }) {
    const data = useTemplates(guildId);
    const [editing, setEditing] = useState(null); // template id, or 'new'
    const [busy, setBusy] = useState(false);

    const save = async items => {
        setBusy(true);
        const result = await apiPut(`/guilds/${guildId}/moderation/templates`, { items });
        setBusy(false);
        if (!result.ok) { toast(result.error === 'invalid_templates' ? 'Проверьте шаблон: нужно название и хотя бы одно наказание.' : describeError(result), { tone: 'error' }); return; }
        remember(guildId, result.data.items);
        setEditing(null);
        toast('Шаблоны сохранены');
    };
    const items = data?.items || [];

    return (
        <aside className="templates" aria-label="Шаблоны наказаний">
            <h2>Шаблоны наказаний</h2>
            <p className="muted small">«Наказать…» сразу предлагает их{data && !data.canEdit ? '. Менять их могут администраторы' : ''}</p>
            {!data && <p className="muted small">Загружаем…</p>}
            <ul>
                {items.map(template => (
                    <li key={template.id}>
                        {editing === template.id ? (
                            <TemplateEditor guildId={guildId} template={template} busy={busy} onCancel={() => setEditing(null)}
                                onSave={next => save(items.map(t => (t.id === template.id ? next : t)))}
                                onDelete={() => save(items.filter(t => t.id !== template.id))} />
                        ) : (
                            <button type="button" className="template-card" disabled={!data.canEdit} onClick={() => setEditing(template.id)}
                                title={data.canEdit ? 'Изменить шаблон' : undefined}>
                                <strong>{template.name}</strong>
                                <span className="muted small">{template.summary || stepsText(template.steps)}</span>
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {data?.canEdit && (editing === 'new'
                ? <TemplateEditor guildId={guildId} busy={busy} onCancel={() => setEditing(null)} onSave={next => save([...items, next])} />
                : <button type="button" className="template-new" onClick={() => setEditing('new')}>+ Новый шаблон</button>)}
        </aside>
    );
}
