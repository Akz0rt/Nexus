import React, { useEffect, useState } from 'react';
import { apiGet, apiPatch, describeError } from './api.js';

const SECTIONS = [
    { id: 'verification', label: 'Пропуск' },
    { id: 'moderation', label: 'Модерация' },
    { id: 'lockdown', label: 'Lockdown' },
    { id: 'diagnostics', label: 'Диагностика' }
];

const SAVE_ERRORS = {
    role_not_found: 'Такой роли нет.',
    channel_not_found: 'Нужен текстовый канал, который существует.',
    invalid_reasons: 'Нужно от 1 до 15 причин.',
    invalid_escalation: 'Проверьте правила: число варнов от 1 до 20, для мута выберите срок.',
    duplicate_warns: 'Два правила на одно и то же число варнов.',
    invalid_slowmode: 'Такой задержки нет.',
    too_many_channels: 'Не больше 10 каналов.',
    nothing_to_save: 'Нечего сохранять.'
};

const LEVEL_MARK = { ok: '✓', warn: '!', bad: '✕' };
const GROUPS = { intents: 'Intents', permissions: 'Права бота', verification: 'Пропуск', lockdown: 'Lockdown', system: 'Система' };

function slowmodeLabel(seconds) {
    if (seconds < 60) return `${seconds} секунд`;
    if (seconds < 3600) return `${seconds / 60} мин`;
    return `${seconds / 3600} ч`;
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return days ? `${days} дн. ${hours} ч` : hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/** One section's form: local draft, «Сохранить» sends only its fields. */
function useDraft(values, keys) {
    const pick = source => Object.fromEntries(keys.map(key => [key, source[key]]));
    const [draft, setDraft] = useState(() => pick(values));
    useEffect(() => { setDraft(pick(values)); }, [values]); // eslint-disable-line react-hooks/exhaustive-deps
    const dirty = keys.some(key => JSON.stringify(draft[key]) !== JSON.stringify(values[key]));
    const set = (key, value) => setDraft(d => ({ ...d, [key]: value }));
    return { draft, set, dirty, reset: () => setDraft(pick(values)) };
}

function SaveBar({ dirty, busy, error, onSave, onReset }) {
    return (
        <div className="save-bar">
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={onSave}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            {dirty && <button className="btn btn-quiet" onClick={onReset}>Отменить изменения</button>}
            {error && <span className="error">{error}</span>}
        </div>
    );
}

function RoleSelect({ label, value, roles, fromEnv, onChange }) {
    const role = roles.find(r => r.id === value);
    return (
        <label className="field">
            {label}
            <select value={value} onChange={e => onChange(e.target.value)}>
                <option value="">— не выбрана —</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {role && !role.belowBot && <span className="error small">Роль выше роли бота — бот не сможет её выдавать.</span>}
            {fromEnv && <span className="muted small">Сейчас берётся из переменных окружения Azure.</span>}
        </label>
    );
}

function ChannelSelect({ label, value, channels, fromEnv, onChange }) {
    return (
        <label className="field">
            {label}
            <select value={value} onChange={e => onChange(e.target.value)}>
                <option value="">— не выбран —</option>
                {channels.map(c => <option key={c.id} value={c.id}>{c.category ? `${c.category} · ` : ''}#{c.name}</option>)}
            </select>
            {fromEnv && <span className="muted small">Сейчас берётся из переменных окружения Azure.</span>}
        </label>
    );
}

function useSave(guildId, onSaved, toast) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const save = async patch => {
        setBusy(true);
        setError(null);
        const result = await apiPatch(`/guilds/${guildId}/settings`, patch);
        setBusy(false);
        if (!result.ok) { setError(SAVE_ERRORS[result.error] || describeError(result)); return false; }
        onSaved(result.data.values);
        toast('Настройки сохранены');
        return true;
    };
    return { busy, error, save };
}

function VerificationSection({ guildId, values, options, onSaved, toast }) {
    const keys = ['unverifiedRoleId', 'maleRoleId', 'femaleRoleId', 'verifyQueueChannelId', 'verificationEnabled', 'assignUnverifiedOnJoin'];
    const { draft, set, dirty, reset } = useDraft(values, keys);
    const { busy, error, save } = useSave(guildId, onSaved, toast);
    const env = key => values.fromEnv.includes(key) && draft[key] === values[key];
    return (
        <div className="settings-form">
            <label className="check">
                <input type="checkbox" checked={draft.verificationEnabled} onChange={e => set('verificationEnabled', e.target.checked)} />
                Модуль пропуска включён
            </label>
            <div className="settings-grid">
                <RoleSelect label="Роль новичка (@АНверефи)" value={draft.unverifiedRoleId} roles={options.roles} fromEnv={env('unverifiedRoleId')} onChange={v => set('unverifiedRoleId', v)} />
                <RoleSelect label="Роль «Парень»" value={draft.maleRoleId} roles={options.roles} fromEnv={env('maleRoleId')} onChange={v => set('maleRoleId', v)} />
                <RoleSelect label="Роль «Девушка»" value={draft.femaleRoleId} roles={options.roles} fromEnv={env('femaleRoleId')} onChange={v => set('femaleRoleId', v)} />
                <ChannelSelect label="Канал очереди (карточки новичков)" value={draft.verifyQueueChannelId} channels={options.textChannels} fromEnv={env('verifyQueueChannelId')} onChange={v => set('verifyQueueChannelId', v)} />
            </div>
            <label className="check">
                <input type="checkbox" checked={draft.assignUnverifiedOnJoin} onChange={e => set('assignUnverifiedOnJoin', e.target.checked)} />
                Выдавать @АНверефи при входе на сервер (если её не выдал другой бот)
            </label>
            <SaveBar dirty={dirty} busy={busy} error={error} onReset={reset} onSave={() => save(Object.fromEntries(keys.map(k => [k, draft[k]])))} />
        </div>
    );
}

function ModerationSection({ guildId, values, options, onSaved, toast }) {
    const { draft, set, dirty, reset } = useDraft(values, ['reasons', 'escalation']);
    const { busy, error, save } = useSave(guildId, onSaved, toast);
    const [newReason, setNewReason] = useState('');

    const reasons = draft.reasons;
    const moveReason = (index, delta) => {
        const next = [...reasons];
        const [item] = next.splice(index, 1);
        next.splice(index + delta, 0, item);
        set('reasons', next);
    };
    const addReason = () => {
        const text = newReason.trim();
        if (!text || reasons.includes(text)) return;
        set('reasons', [...reasons, text]);
        setNewReason('');
    };
    const rules = draft.escalation;
    const setRule = (index, patch) => set('escalation', rules.map((rule, i) => {
        if (i !== index) return rule;
        const next = { ...rule, ...patch };
        if (next.action === 'propose_ban') delete next.durationMs;
        else if (!next.durationMs) next.durationMs = options.muteDurations[1]?.ms;
        return next;
    }));

    return (
        <div className="settings-form">
            <h3>Шаблоны причин</h3>
            <p className="muted small">Подсказки в /warn, /mute и в окнах наказаний приложения. Свою причину всё равно можно написать.</p>
            <ul className="reason-list">
                {reasons.map((reason, index) => (
                    <li key={reason}>
                        <span>{reason}</span>
                        <button className="btn btn-quiet" disabled={index === 0} onClick={() => moveReason(index, -1)} aria-label="Выше">↑</button>
                        <button className="btn btn-quiet" disabled={index === reasons.length - 1} onClick={() => moveReason(index, 1)} aria-label="Ниже">↓</button>
                        <button className="btn btn-quiet" disabled={reasons.length === 1} onClick={() => set('reasons', reasons.filter(r => r !== reason))} aria-label={`Удалить ${reason}`}>✕</button>
                    </li>
                ))}
            </ul>
            <form className="inline-form" onSubmit={e => { e.preventDefault(); addReason(); }}>
                <input value={newReason} maxLength={100} placeholder="Новая причина" onChange={e => setNewReason(e.target.value)} />
                <button className="btn" type="submit" disabled={!newReason.trim() || reasons.length >= 15}>Добавить</button>
            </form>

            <h3>Эскалация варнов</h3>
            <p className="muted small">Срабатывает, когда активных варнов становится ровно столько. Варн сгорает через {options.warnTtlDays} дней.</p>
            <ul className="rule-list">
                {rules.map((rule, index) => (
                    <li key={index}>
                        <input type="number" min="1" max="20" value={rule.warns} aria-label="Варнов"
                            onChange={e => setRule(index, { warns: Number(e.target.value) })} />
                        <span className="muted">варн. →</span>
                        <select value={rule.action} onChange={e => setRule(index, { action: e.target.value })} aria-label="Что делать">
                            <option value="timeout">мут</option>
                            <option value="propose_ban">предложить бан</option>
                        </select>
                        {rule.action === 'timeout' && (
                            <select value={rule.durationMs} onChange={e => setRule(index, { durationMs: Number(e.target.value) })} aria-label="Срок мута">
                                {options.muteDurations.map(d => <option key={d.id} value={d.ms}>{d.label}</option>)}
                            </select>
                        )}
                        <button className="btn btn-quiet" onClick={() => set('escalation', rules.filter((_, i) => i !== index))} aria-label="Удалить правило">✕</button>
                    </li>
                ))}
            </ul>
            {rules.length < 6 && (
                <button className="btn" onClick={() => set('escalation', [...rules, {
                    warns: Math.max(0, ...rules.map(r => r.warns)) + 1, action: 'timeout', durationMs: options.muteDurations[1]?.ms
                }])}>Добавить правило</button>
            )}
            <SaveBar dirty={dirty} busy={busy} error={error} onReset={reset} onSave={() => save({ reasons: draft.reasons, escalation: draft.escalation })} />
        </div>
    );
}

function LockdownSection({ guildId, values, options, onSaved, toast }) {
    const { draft, set, dirty, reset } = useDraft(values, ['lockdownChannelIds', 'slowmodeSeconds']);
    const { busy, error, save } = useSave(guildId, onSaved, toast);
    const chosen = new Set(draft.lockdownChannelIds);
    const toggle = id => set('lockdownChannelIds', chosen.has(id) ? draft.lockdownChannelIds.filter(x => x !== id) : [...draft.lockdownChannelIds, id]);
    return (
        <div className="settings-form">
            <p className="muted small">Lockdown ставит инвайты на паузу и включает slowmode в стартовых каналах. Снятие возвращает всё как было. Включают его кнопкой в шапке.</p>
            <label className="field">
                Задержка slowmode
                <select value={draft.slowmodeSeconds} onChange={e => set('slowmodeSeconds', Number(e.target.value))}>
                    {options.slowmodeChoices.map(s => <option key={s} value={s}>{slowmodeLabel(s)}</option>)}
                </select>
            </label>
            <h3>Стартовые каналы · {chosen.size}</h3>
            <ul className="check-list channel-checks">
                {options.textChannels.map(channel => (
                    <li key={channel.id}>
                        <label className="check">
                            <input type="checkbox" checked={chosen.has(channel.id)} onChange={() => toggle(channel.id)} />
                            <span className="muted small">{channel.category || ''}</span> #{channel.name}
                        </label>
                    </li>
                ))}
            </ul>
            <SaveBar dirty={dirty} busy={busy} error={error} onReset={reset} onSave={() => save({ lockdownChannelIds: draft.lockdownChannelIds, slowmodeSeconds: draft.slowmodeSeconds })} />
        </div>
    );
}

function DiagnosticsSection({ guildId }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const run = () => {
        setLoading(true);
        apiGet(`/guilds/${guildId}/settings/diagnostics`)
            .then(result => { setData(result); setError(null); })
            .catch(err => setError(describeError(err)))
            .finally(() => setLoading(false));
    };
    useEffect(run, [guildId]); // eslint-disable-line react-hooks/exhaustive-deps

    const groups = data ? Object.keys(GROUPS).filter(g => data.checks.some(c => c.group === g)) : [];
    const bad = data ? data.checks.filter(c => c.level === 'bad').length : 0;
    return (
        <div className="settings-form">
            <div className="toolbar">
                {data && (bad === 0
                    ? <strong className="diag-summary is-ok">Всё в порядке</strong>
                    : <strong className="diag-summary is-bad">Проблем: {bad}</strong>)}
                {data && (
                    <span className="muted small">
                        бот работает {formatUptime(data.uptimeSeconds)}
                        {data.pingMs !== null && ` · пинг до Discord ${data.pingMs} мс`}
                        {data.dbMs !== null && ` · база ответила за ${data.dbMs} мс`}
                    </span>
                )}
                <button className="btn hint" disabled={loading} onClick={run}>{loading ? 'Проверяем…' : 'Проверить снова'}</button>
            </div>
            {error && <p className="error">{error}</p>}
            {groups.map(group => (
                <div key={group} className="diag-group">
                    <h3>{GROUPS[group]}</h3>
                    <ul className="diag-list">
                        {data.checks.filter(c => c.group === group).map(item => (
                            <li key={item.label} className={`diag diag-${item.level}`}>
                                <span className="diag-mark" aria-hidden="true">{LEVEL_MARK[item.level]}</span>
                                <span>{item.label}</span>
                                {item.hint && <span className="muted small">— {item.hint}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

export default function SettingsView({ guildId, toast }) {
    const [section, setSection] = useState('verification');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setData(null);
        apiGet(`/guilds/${guildId}/settings`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId]);

    const onSaved = values => setData(d => ({ ...d, values }));
    const props = data ? { guildId, values: data.values, options: data.options, onSaved, toast } : null;

    return (
        <section className="view">
            <div className="view-head">
                <h1>Настройки</h1>
                <div className="tabs" role="tablist">
                    {SECTIONS.map(s => (
                        <button key={s.id} role="tab" aria-selected={section === s.id} className={`tab ${section === s.id ? 'is-active' : ''}`} onClick={() => setSection(s.id)}>
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>
            <p className="muted small">Только для администраторов. Сохраняется для этого сервера и применяется сразу, без перезапуска бота. Дни рождения и AI настраиваются в старой веб-панели.</p>
            {error && <p className="error">{error}</p>}
            {section === 'verification' && props && <VerificationSection {...props} />}
            {section === 'moderation' && props && <ModerationSection {...props} />}
            {section === 'lockdown' && props && <LockdownSection {...props} />}
            {section === 'diagnostics' && <DiagnosticsSection guildId={guildId} />}
        </section>
    );
}
