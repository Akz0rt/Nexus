import React, { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, apiPut, describeError } from './api.js';
import { ROLE_DURATIONS, ROLE_PROBLEMS, describeBulk } from './format.js';
import Dialog from './Dialog.jsx';

/** Roles the viewer may give, highest first (empty without Manage Roles). */
export function useAssignable(guildId) {
    const [roles, setRoles] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/assignable`)
            .then(data => { if (!cancelled) setRoles(data.items); })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId]);
    return { roles, error };
}

function usePresets(guildId) {
    const [presets, setPresets] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/presets`)
            .then(data => { if (!cancelled) setPresets(data.items); })
            .catch(err => { if (!cancelled) setError(err.error === 'forbidden' ? null : describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId]);
    return { presets, error };
}

const roleColor = color => (!color || color === '#000000' ? 'var(--muted)' : color);

export function RoleChip({ role, onRemove, title }) {
    return (
        <li className={`role ${role.problem ? 'is-broken' : ''}`} style={{ '--role': roleColor(role.color) }} title={title}>
            {role.name || 'удалённая роль'}
            {onRemove && <button type="button" className="role-x" onClick={onRemove} aria-label={`Снять ${role.name}`}>×</button>}
        </li>
    );
}

function DurationField({ value, onChange }) {
    return (
        <label className="field">
            Срок
            <select value={value} onChange={e => onChange(e.target.value)}>
                {ROLE_DURATIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
        </label>
    );
}

/** Give or take one role from the selected people (voice board) or one member (card). */
export function RoleDialog({ guildId, userIds, title, initialAdd = true, onClose, toast }) {
    const { roles, error: loadError } = useAssignable(guildId);
    const [roleId, setRoleId] = useState('');
    const [add, setAdd] = useState(initialAdd);
    const [duration, setDuration] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');

    const shown = useMemo(() => (roles || []).filter(role => role.name.toLowerCase().includes(query.trim().toLowerCase())), [roles, query]);
    useEffect(() => { if (!shown.some(r => r.id === roleId)) setRoleId(shown[0]?.id || ''); }, [shown, roleId]);

    const submit = async () => {
        if (!roleId) return;
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/roles/bulk`, { userIds, roleId, add, duration: add && duration ? duration : null });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        const role = roles.find(r => r.id === roleId);
        const verb = add ? (duration ? 'Временная роль выдана' : 'Роль выдана') : 'Роль снята';
        const text = userIds.length === 1 && !result.data.failed.length
            ? `${verb}: ${role?.name}`
            : `${describeBulk(verb, result.data)} · ${role?.name}`;
        toast(text, result.data.failed.length ? { tone: 'error', ttl: 8000 } : {});
        onClose();
    };

    return (
        <Dialog title={title || `Роль: ${userIds.length} чел.`} onClose={onClose} onSubmit={submit} submitLabel={add ? 'Выдать' : 'Снять'} busy={busy}>
            <div className="segmented" role="group" aria-label="Действие">
                <button type="button" className={`tab ${add ? 'is-active' : ''}`} aria-pressed={add} onClick={() => setAdd(true)}>Выдать</button>
                <button type="button" className={`tab ${!add ? 'is-active' : ''}`} aria-pressed={!add} onClick={() => setAdd(false)}>Снять</button>
            </div>
            {roles && roles.length === 0 && <p className="muted">Нет ролей, которые вы можете выдавать: они должны быть ниже вашей высшей роли и роли бота.</p>}
            {roles && roles.length > 0 && (
                <>
                    {roles.length > 8 && <input type="search" autoFocus placeholder="Найти роль" value={query} onChange={e => setQuery(e.target.value)} />}
                    <label className="field">
                        Роль
                        <select value={roleId} onChange={e => setRoleId(e.target.value)}>
                            {shown.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
                        </select>
                    </label>
                    {add && <DurationField value={duration} onChange={setDuration} />}
                    {add && duration && <p className="muted small">Бот снимет роль сам, когда срок выйдет. Тем, у кого она уже есть навсегда, временно её не выдать.</p>}
                </>
            )}
            {(error || loadError) && <p className="error">{error || loadError}</p>}
        </Dialog>
    );
}

/** «Применить пресет» from a member card. */
export function PresetApplyDialog({ guildId, member, onClose, toast }) {
    const { presets, error: loadError } = usePresets(guildId);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const apply = async preset => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/roles/presets/${preset.id}/apply`, { userId: member.id });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        const { added, skipped } = result.data;
        const parts = [added.length ? `Пресет «${preset.name}»: выдано ${added.join(', ')}` : `Пресет «${preset.name}»: все роли уже есть`];
        if (skipped.length) parts.push(`пропущено ${skipped.length}: ${skipped.map(s => `${s.name || 'удалённая'} — ${ROLE_PROBLEMS[s.code] || s.code}`).join(', ')}`);
        toast(parts.join(' · '), skipped.length ? { tone: 'error', ttl: 8000 } : {});
        onClose();
    };

    return (
        <Dialog title={`Пресет для ${member.displayName}`} onClose={onClose}>
            {presets && presets.length === 0 && <p className="muted">Пресетов пока нет. Их создают на экране «Роли».</p>}
            <ul className="preset-pick">
                {(presets || []).map(preset => (
                    <li key={preset.id}>
                        <button type="button" className="picker-item" disabled={busy} onClick={() => apply(preset)}>
                            <strong>{preset.name}</strong>
                            <ul className="roles">{preset.roles.map(role => <RoleChip key={role.id} role={role} />)}</ul>
                        </button>
                    </li>
                ))}
            </ul>
            {(error || loadError) && <p className="error">{error || loadError}</p>}
        </Dialog>
    );
}

function RoleChecklist({ roles, chosen, onToggle }) {
    return (
        <ul className="check-list role-checks">
            {roles.map(role => (
                <li key={role.id}>
                    <label className="check">
                        <input type="checkbox" checked={chosen.has(role.id)} onChange={() => onToggle(role.id)} />
                        <span className="role-dot" style={{ '--role': roleColor(role.color) }} />
                        {role.name}
                    </label>
                </li>
            ))}
        </ul>
    );
}

/** Create or edit a preset: a name and the roles in it. */
export function PresetDialog({ guildId, preset, onClose, toast }) {
    const { roles, error: loadError } = useAssignable(guildId);
    const [name, setName] = useState(preset?.name || '');
    const [chosen, setChosen] = useState(() => new Set(preset ? preset.roles.filter(r => !r.problem).map(r => r.id) : []));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const broken = preset ? preset.roles.filter(r => r.problem) : [];

    const toggle = id => setChosen(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const submit = async () => {
        if (!name.trim()) { setError('Введите название.'); return; }
        if (chosen.size === 0) { setError('Отметьте хотя бы одну роль.'); return; }
        setBusy(true);
        const body = { name, roleIds: [...chosen] };
        const result = preset
            ? await apiPut(`/guilds/${guildId}/roles/presets/${preset.id}`, body)
            : await apiPost(`/guilds/${guildId}/roles/presets`, body);
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        toast(`Пресет «${result.data.preset.name}» сохранён`);
        onClose();
    };

    return (
        <Dialog title={preset ? 'Изменить пресет' : 'Новый пресет'} onClose={onClose} onSubmit={submit} submitLabel="Сохранить" busy={busy}>
            <label className="field">
                Название
                <input autoFocus value={name} maxLength={60} placeholder="Например, Ивентер" onChange={e => setName(e.target.value)} />
            </label>
            {roles && roles.length === 0 && <p className="muted">Нет ролей, которые вы можете выдавать.</p>}
            {roles && roles.length > 0 && <RoleChecklist roles={roles} chosen={chosen} onToggle={toggle} />}
            {broken.length > 0 && (
                <p className="muted small">
                    Уберутся из пресета: {broken.map(r => `${r.name || 'удалённая роль'} (${ROLE_PROBLEMS[r.problem] || r.problem})`).join(', ')}.
                </p>
            )}
            {(error || loadError) && <p className="error">{error || loadError}</p>}
        </Dialog>
    );
}

/** «Доп. роли…» before approving a newcomer: presets and single roles, merged into one list. */
export function ExtraRolesDialog({ guildId, name, value, excludeIds = [], onClose, onPick }) {
    const { roles: assignable, error: loadError } = useAssignable(guildId);
    // @unverified and the gender roles are handled by the approval itself
    const roles = assignable && assignable.filter(role => !excludeIds.includes(role.id));
    const { presets } = usePresets(guildId);
    const [chosen, setChosen] = useState(() => new Set(value));

    const toggle = id => setChosen(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const usable = preset => preset.roles.filter(r => !r.problem && !excludeIds.includes(r.id)).map(r => r.id);
    const presetOn = preset => usable(preset).length > 0 && usable(preset).every(id => chosen.has(id));
    const togglePreset = preset => setChosen(prev => {
        const next = new Set(prev);
        const on = presetOn(preset);
        for (const id of usable(preset)) { if (on) next.delete(id); else next.add(id); }
        return next;
    });

    return (
        <Dialog title={`Доп. роли для ${name}`} onClose={onClose} onSubmit={() => onPick([...chosen])} submitLabel="Готово">
            <p className="muted small">Выдадутся вместе с ролью пола, когда вы нажмёте «Парень» или «Девушка».</p>
            {presets && presets.length > 0 && (
                <div className="preset-toggles">
                    {presets.map(preset => (
                        <button type="button" key={preset.id} className={`chip ${presetOn(preset) ? 'is-active' : ''}`}
                            aria-pressed={presetOn(preset)} onClick={() => togglePreset(preset)}>
                            {preset.name}
                        </button>
                    ))}
                </div>
            )}
            {roles && roles.length > 0 && <RoleChecklist roles={roles} chosen={chosen} onToggle={toggle} />}
            {roles && roles.length === 0 && <p className="muted">Нет ролей, которые вы можете выдавать.</p>}
            {loadError && <p className="error">{loadError}</p>}
        </Dialog>
    );
}

const FILTER_TYPES = [
    { id: 'role', label: 'У кого есть роль' },
    { id: 'voice', label: 'Кто в голосовом канале' },
    { id: 'all', label: 'Все на сервере' }
];

/**
 * Mass change with a preview: one role to everyone matching a filter.
 * Runs on the server in the background; progress comes over the live stream.
 */
export function MassRoleDialog({ guildId, initial = {}, allRoles, onClose, toast }) {
    const { roles, error: loadError } = useAssignable(guildId);
    const [roleId, setRoleId] = useState(initial.roleId || '');
    const [add, setAdd] = useState(initial.add !== false);
    const [type, setType] = useState(initial.filter?.type || 'role');
    const [sourceId, setSourceId] = useState(initial.filter?.id || '');
    const [duration, setDuration] = useState('');
    const [channels, setChannels] = useState(null);
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { if (roles && !roleId) setRoleId(roles[0]?.id || ''); }, [roles, roleId]);
    useEffect(() => {
        if (type !== 'voice' || channels) return;
        apiGet(`/guilds/${guildId}/voice`)
            .then(board => setChannels(board.categories.flatMap(c => c.channels.map(ch => ({ ...ch, category: c.name })))))
            .catch(err => setError(describeError(err)));
    }, [type, channels, guildId]);
    const sources = type === 'role' ? (allRoles || []) : type === 'voice' ? (channels || []) : [];
    useEffect(() => {
        if (type === 'all') return;
        if (!sources.some(s => s.id === sourceId)) setSourceId(sources[0]?.id || '');
    }, [type, sources, sourceId]);

    const request = useMemo(() => ({
        roleId, add, duration: add && duration ? duration : null,
        filter: type === 'all' ? { type } : { type, id: sourceId }
    }), [roleId, add, duration, type, sourceId]);

    // Live preview: "затронет N чел."
    useEffect(() => {
        if (!roleId || (type !== 'all' && !sourceId)) { setPreview(null); return undefined; }
        let cancelled = false;
        const timer = setTimeout(async () => {
            const result = await apiPost(`/guilds/${guildId}/roles/jobs/preview`, request);
            if (cancelled) return;
            setPreview(result.ok ? result.data : { error: describeError(result) });
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [guildId, request, roleId, type, sourceId]);

    const submit = async () => {
        if (!preview?.count) return;
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/roles/jobs`, request);
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        toast(`Запущено: ${add ? 'выдача' : 'снятие'} роли для ${result.data.job.total} чел.`);
        onClose();
    };

    const role = roles?.find(r => r.id === roleId);
    return (
        <Dialog title="Массовая выдача ролей" onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={preview?.count ? `${add ? 'Выдать' : 'Снять'} · ${preview.count} чел.` : (add ? 'Выдать' : 'Снять')}
            submitTone={add ? 'primary' : 'danger'}>
            <div className="segmented" role="group" aria-label="Действие">
                <button type="button" className={`tab ${add ? 'is-active' : ''}`} aria-pressed={add} onClick={() => setAdd(true)}>Выдать</button>
                <button type="button" className={`tab ${!add ? 'is-active' : ''}`} aria-pressed={!add} onClick={() => setAdd(false)}>Снять</button>
            </div>
            {roles && roles.length === 0 && <p className="muted">Нет ролей, которые вы можете выдавать.</p>}
            {roles && roles.length > 0 && (
                <label className="field">
                    Роль
                    <select value={roleId} onChange={e => setRoleId(e.target.value)}>
                        {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                </label>
            )}
            <label className="field">
                Кому
                <select value={type} onChange={e => setType(e.target.value)}>
                    {FILTER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
            </label>
            {type === 'role' && (
                <label className="field">
                    Роль-фильтр
                    <select value={sourceId} onChange={e => setSourceId(e.target.value)}>
                        {sources.map(r => <option key={r.id} value={r.id}>{r.name} · {r.memberCount}</option>)}
                    </select>
                </label>
            )}
            {type === 'voice' && (
                <label className="field">
                    Голосовой канал
                    <select value={sourceId} onChange={e => setSourceId(e.target.value)}>
                        {sources.map(ch => <option key={ch.id} value={ch.id}>{ch.category} · {ch.name} · {ch.members.length}</option>)}
                    </select>
                </label>
            )}
            {add && <DurationField value={duration} onChange={setDuration} />}
            <div className="mass-preview" aria-live="polite">
                {preview?.error && <span className="error">{preview.error}</span>}
                {preview && !preview.error && (preview.count === 0
                    ? <span className="muted">Менять некому: у всех уже так.</span>
                    : (
                        <span>
                            Затронет <strong className="numeric">{preview.count}</strong> чел.
                            {preview.sample.length > 0 && <span className="muted"> · {preview.sample.join(', ')}{preview.count > preview.sample.length ? '…' : ''}</span>}
                            {preview.count > preview.limit && <span className="error"> · больше {preview.limit} за раз нельзя</span>}
                        </span>
                    ))}
                {role && <span className="muted small">Боты не затрагиваются.</span>}
            </div>
            {(error || loadError) && <p className="error">{error || loadError}</p>}
        </Dialog>
    );
}
