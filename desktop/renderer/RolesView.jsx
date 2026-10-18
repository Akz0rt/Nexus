import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPost, describeError } from './api.js';
import { ROLE_PROBLEMS, describeBulk, formatDateTime, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';
import { MassRoleDialog, PresetDialog, RoleChip } from './RoleDialogs.jsx';
import RoleMenusTab from './RoleMenusTab.jsx';

const TABS = [
    { id: 'roles', label: 'Роли' },
    { id: 'presets', label: 'Пресеты' },
    { id: 'temp', label: 'Временные' },
    { id: 'menus', label: 'Меню ролей' }
];

const roleColor = color => (!color || color === '#000000' ? 'var(--muted)' : color);

/** Progress of the running (or just finished) mass change. */
export function JobBar({ job, onRetry, onClose }) {
    if (!job) return null;
    const verb = job.add ? 'Выдаём' : 'Снимаем';
    const percent = job.total ? Math.round((job.processed / job.total) * 100) : 0;
    if (job.status === 'running') {
        return (
            <div className="job-bar" role="status">
                <span>{verb} «{job.roleName}»: <span className="numeric">{job.processed} / {job.total}</span>
                    {job.failedCount > 0 && <span className="error"> · не удалось {job.failedCount}</span>}</span>
                <div className="progress" aria-hidden="true"><div style={{ width: `${percent}%` }} /></div>
            </div>
        );
    }
    const done = job.doneCount ?? job.processed - job.failedCount;
    return (
        <div className={`job-bar ${job.failedCount ? 'is-failed' : 'is-done'}`} role="status">
            <span>
                Готово: {job.add ? 'выдано' : 'снято'} «{job.roleName}» — <span className="numeric">{done} из {job.total}</span>
                {job.failedCount > 0 && <span className="error"> · не удалось {job.failedCount}</span>}
            </span>
            {job.failedCount > 0 && onRetry && <button className="btn" onClick={onRetry}>Повторить для неудачных</button>}
            <button className="btn btn-quiet" onClick={onClose} aria-label="Скрыть">✕</button>
        </div>
    );
}

function ConfirmRemove({ count, role, onClose, onConfirm, busy }) {
    return (
        <Dialog title={`Снять «${role.name}» у ${count} чел.?`} onClose={onClose} onSubmit={onConfirm}
            submitLabel="Снять" submitTone="danger" busy={busy}>
            <p className="muted">Роль снимется у каждого по очереди; прогресс будет виден сверху. Отменить это одной кнопкой нельзя.</p>
        </Dialog>
    );
}

/** Holders of one role, with the usual selection: click, Ctrl, Shift, rubber band, Ctrl+A, Esc. */
function Owners({ guildId, role, revision, dialogOpen, onOpenMember, onStartJob, onGrant }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(() => new Set());
    const [anchor, setAnchor] = useState(null);
    const [marquee, setMarquee] = useState(null);
    const [confirm, setConfirm] = useState(null); // { userIds|null (= all), count }
    const [busy, setBusy] = useState(false);
    const listRef = useRef(null);

    useEffect(() => { setSelected(new Set()); setAnchor(null); setQuery(''); }, [role.id]);
    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/${role.id}/members`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, role.id, revision]);

    const items = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return (data?.items || []).filter(m => !needle || m.displayName.toLowerCase().includes(needle) || m.username.toLowerCase().includes(needle));
    }, [data, query]);
    const ids = items.map(m => m.id);
    // Drop ids that left the list (role taken away meanwhile)
    const chosen = ids.filter(id => selected.has(id));

    const click = (event, id) => {
        if (event.detail > 1) return;
        if (event.shiftKey && anchor && ids.includes(anchor)) {
            const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b);
            setSelected(prev => new Set([...(event.ctrlKey ? prev : []), ...ids.slice(from, to + 1)]));
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            setSelected(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
            });
        } else {
            setSelected(prev => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
        }
        setAnchor(id);
    };

    useEffect(() => {
        const onKey = event => {
            if (dialogOpen || confirm || event.target.closest?.('input, select, textarea')) return;
            if (event.key === 'Escape') setSelected(new Set());
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                setSelected(new Set(ids));
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dialogOpen, confirm, ids]);

    const startMarquee = event => {
        if (event.button !== 0 || event.target.closest('[data-owner], button, input')) return;
        event.preventDefault();
        const base = event.shiftKey ? new Set(selected) : new Set();
        const start = { x: event.clientX, y: event.clientY };
        let moved = false;
        const onMove = e => {
            const rect = {
                left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY),
                right: Math.max(start.x, e.clientX), bottom: Math.max(start.y, e.clientY)
            };
            if (!moved && rect.right - rect.left < 4 && rect.bottom - rect.top < 4) return;
            moved = true;
            setMarquee(rect);
            const hits = [...listRef.current.querySelectorAll('[data-owner]')].filter(el => {
                const r = el.getBoundingClientRect();
                return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
            }).map(el => el.dataset.owner);
            setSelected(new Set([...base, ...hits]));
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setMarquee(null);
            if (!moved && !event.shiftKey) setSelected(new Set());
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    const remove = async userIds => {
        const people = userIds ? userIds.filter(id => !data.items.find(m => m.id === id)?.bot) : null;
        if (people && people.length === 0) return;
        const count = people ? people.length : data.items.filter(m => !m.bot).length;
        if (count >= 3 && !confirm) { setConfirm({ userIds: people, count }); return; }
        setBusy(true);
        await onStartJob({
            roleId: role.id,
            add: false,
            filter: people ? { type: 'users', userIds: people } : { type: 'role', id: role.id }
        });
        setBusy(false);
        setConfirm(null);
        setSelected(new Set());
    };

    const problem = role.problem;
    const humans = (data?.items || []).filter(m => !m.bot).length;

    return (
        <section className="owners" aria-label={`Владельцы роли ${role.name}`}>
            <div className="owners-head">
                <h2><span className="role-dot" style={{ '--role': roleColor(role.color) }} />{role.name}</h2>
                <span className="muted">{data ? `${data.items.length} чел.` : ''}</span>
                {!problem && <button className="btn" onClick={() => onGrant(role)}>Выдать…</button>}
                {!problem && humans > 0 && <button className="btn btn-danger" disabled={busy} onClick={() => remove(null)}>Снять у всех</button>}
            </div>
            {problem && <p className="muted small">Из панели её не выдать и не снять: {ROLE_PROBLEMS[problem] || problem}.</p>}
            {data && data.items.length > 8 && (
                <input type="search" className="owners-search" placeholder="Найти среди владельцев" value={query} onChange={e => setQuery(e.target.value)} />
            )}
            {error && <p className="error">{error}</p>}
            <div className="owners-list" ref={listRef} onMouseDown={startMarquee}>
                {data && items.length === 0 && <p className="muted">{data.items.length === 0 ? 'Ни у кого нет этой роли.' : 'Никого не нашли.'}</p>}
                <ul>
                    {items.map(member => (
                        <li key={member.id}>
                            <div className={`owner ${selected.has(member.id) ? 'is-selected' : ''}`} data-owner={member.id}
                                role="option" aria-selected={selected.has(member.id)} tabIndex={0}
                                onClick={event => click(event, member.id)}
                                onDoubleClick={() => onOpenMember(member.id)}
                                onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); click({ ctrlKey: true }, member.id); } if (event.key === 'Enter') onOpenMember(member.id); }}>
                                <Avatar src={member.avatarURL} name={member.displayName} size={28} />
                                <span className="owner-name">{member.displayName}</span>
                                {member.bot && <span className="tile-flag tile-flag-bot">бот</span>}
                                {member.expiresAt && <span className="tile-flag" title={`до ${formatDateTime(member.expiresAt)}`}>{timeLeft(member.expiresAt)}</span>}
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
            {chosen.length > 0 && (
                <div className="action-bar">
                    <strong>Выбрано: {chosen.length}</strong>
                    {chosen.length === 1 && <button className="btn" onClick={() => onOpenMember(chosen[0])}>Открыть карточку</button>}
                    {!problem && <button className="btn btn-danger" disabled={busy} onClick={() => remove(chosen)}>Снять у выделенных</button>}
                    <button className="btn btn-quiet" onClick={() => setSelected(new Set())}>Сбросить <kbd>Esc</kbd></button>
                </div>
            )}
            {confirm && (
                <ConfirmRemove count={confirm.count} role={role} busy={busy}
                    onClose={() => setConfirm(null)} onConfirm={() => remove(confirm.userIds)} />
            )}
            {marquee && (
                <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} />
            )}
        </section>
    );
}

function RolesTab({ guildId, roles, revision, onOpenMember, onStartJob, toast }) {
    const [roleId, setRoleId] = useState(null);
    const [query, setQuery] = useState('');
    const [dialog, setDialog] = useState(null);
    const role = roles.find(r => r.id === roleId) || null;
    const shown = roles.filter(r => r.name.toLowerCase().includes(query.trim().toLowerCase()));

    return (
        <>
            <div className="toolbar">
                <input type="search" placeholder="Найти роль" value={query} onChange={e => setQuery(e.target.value)} />
                <button className="btn btn-primary" onClick={() => setDialog({ filter: { type: 'role' } })}>Массовая выдача…</button>
                <span className="muted small hint">Роли создают и настраивают в самом Discord.</span>
            </div>
            <div className="roles-layout">
                <ul className="role-list" aria-label="Роли сервера">
                    {shown.map(r => (
                        <li key={r.id}>
                            <button className={`role-row ${r.id === roleId ? 'is-active' : ''}`} aria-pressed={r.id === roleId} onClick={() => setRoleId(r.id)}>
                                <span className="role-dot" style={{ '--role': roleColor(r.color) }} />
                                <span className="role-row-name">{r.name}</span>
                                {r.problem && <span className="role-note">{ROLE_PROBLEMS[r.problem] || r.problem}</span>}
                                <span className="muted numeric">{r.memberCount}</span>
                            </button>
                        </li>
                    ))}
                </ul>
                {role
                    ? <Owners guildId={guildId} role={role} revision={revision} dialogOpen={Boolean(dialog)} onOpenMember={onOpenMember}
                        onStartJob={onStartJob} onGrant={r => setDialog({ roleId: r.id, add: true, filter: { type: 'role' } })} />
                    : <div className="empty"><h2>Выберите роль</h2><p>Покажем, у кого она есть, и дадим снять её у выделенных или у всех сразу.</p></div>}
            </div>
            {dialog && <MassRoleDialog guildId={guildId} initial={dialog} allRoles={roles} onClose={() => setDialog(null)} toast={toast} />}
        </>
    );
}

function PresetsTab({ guildId, revision, toast }) {
    const [presets, setPresets] = useState(null);
    const [error, setError] = useState(null);
    const [dialog, setDialog] = useState(null); // { preset|null }
    const [removing, setRemoving] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/presets`)
            .then(data => { if (!cancelled) setPresets(data.items); })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

    const remove = async () => {
        const result = await apiDelete(`/guilds/${guildId}/roles/presets/${removing.id}`);
        toast(result.ok ? `Пресет «${removing.name}» удалён` : describeError(result), result.ok ? {} : { tone: 'error' });
        setRemoving(null);
    };

    return (
        <>
            <div className="toolbar">
                <button className="btn btn-primary" onClick={() => setDialog({ preset: null })}>Новый пресет</button>
                <span className="muted small hint">Пресет применяют из карточки участника и при пропуске («Доп. роли…»).</span>
            </div>
            {error && <p className="error">{error}</p>}
            {presets && presets.length === 0 && (
                <div className="empty"><h2>Пресетов пока нет</h2><p>Пресет — именованный набор ролей, например «Ивентер» или «Хелпер». Выдаётся одним нажатием.</p></div>
            )}
            <ul className="presets">
                {(presets || []).map(preset => (
                    <li key={preset.id} className="preset">
                        <div className="preset-head">
                            <strong>{preset.name}</strong>
                            <button className="btn btn-quiet" onClick={() => setDialog({ preset })}>Изменить</button>
                            <button className="btn btn-quiet" onClick={() => setRemoving(preset)}>Удалить</button>
                        </div>
                        <ul className="roles">
                            {preset.roles.map(role => (
                                <RoleChip key={role.id} role={role} title={role.problem ? ROLE_PROBLEMS[role.problem] : undefined} />
                            ))}
                        </ul>
                        {preset.roles.some(r => r.problem) && <p className="muted small">Перечёркнутые роли сейчас не выдать — они будут пропущены.</p>}
                    </li>
                ))}
            </ul>
            {dialog && <PresetDialog guildId={guildId} preset={dialog.preset} onClose={() => setDialog(null)} toast={toast} />}
            {removing && (
                <Dialog title={`Удалить пресет «${removing.name}»?`} onClose={() => setRemoving(null)} onSubmit={remove} submitLabel="Удалить" submitTone="danger">
                    <p className="muted">Роли у людей останутся, удалится только сам набор.</p>
                </Dialog>
            )}
        </>
    );
}

function TempTab({ guildId, revision, onOpenMember, toast }) {
    const [items, setItems] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/temp`)
            .then(data => { if (!cancelled) setItems(data.items); })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

    const takeNow = async item => {
        const result = await apiDelete(`/guilds/${guildId}/roles/temp/${item.user.id}/${item.roleId}`);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(result.data.failed.length ? describeBulk('Роль снята', result.data) : `Роль «${item.roleName}» снята`);
    };

    return (
        <>
            <p className="muted small">Роли, выданные на время. Бот снимает их сам, проверка раз в минуту.</p>
            {error && <p className="error">{error}</p>}
            {items && items.length === 0 && <div className="empty"><h2>Временных ролей нет</h2><p>Выдать роль на срок можно из карточки участника или в «Массовой выдаче».</p></div>}
            {items && items.length > 0 && (
                <div className="table-wrap">
                    <table className="journal">
                        <thead><tr><th>Участник</th><th>Роль</th><th>Осталось</th><th>Выдал</th><th /></tr></thead>
                        <tbody>
                            {items.map(item => (
                                <tr key={`${item.user.id}:${item.roleId}`}>
                                    <td><MemberLink id={item.user.id} name={item.user.displayName} onOpen={onOpenMember} /></td>
                                    <td><span className="role-inline"><span className="role-dot" style={{ '--role': roleColor(item.color) }} />{item.roleName}</span></td>
                                    <td className="nowrap" title={formatDateTime(item.expiresAt)}>{timeLeft(item.expiresAt)}</td>
                                    <td><MemberLink id={item.grantedBy?.id} name={item.grantedBy?.displayName} onOpen={onOpenMember} /></td>
                                    <td>{item.editable && <button className="btn btn-quiet" onClick={() => takeNow(item)}>Снять сейчас</button>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

export default function RolesView({ guildId, revision, job, onJob, onOpenMember, toast }) {
    const [tab, setTab] = useState('roles');
    const [roles, setRoles] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => { setTab('roles'); }, [guildId]);
    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles`)
            .then(data => {
                if (cancelled) return;
                setRoles(data.items);
                setError(null);
                if (data.job) onJob(data.job);
            })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision, onJob]);

    const startJob = useCallback(async request => {
        const result = await apiPost(`/guilds/${guildId}/roles/jobs`, request);
        if (!result.ok) {
            toast(result.error === 'nobody' ? 'Менять некому: у всех уже так.' : describeError(result), { tone: 'error' });
            return false;
        }
        onJob(result.data.job);
        return true;
    }, [guildId, onJob, toast]);

    const retry = () => startJob({ roleId: job.roleId, add: job.add, filter: { type: 'users', userIds: job.failedIds || [] } });

    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Роли</h1>
                <div className="tabs" role="tablist">
                    {TABS.map(t => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>
            <JobBar job={job} onRetry={job?.failedIds?.length ? retry : null} onClose={() => onJob(null)} />
            {error && <p className="error">{error}</p>}
            {tab === 'roles' && roles && (
                <RolesTab guildId={guildId} roles={roles} revision={revision} onOpenMember={onOpenMember} onStartJob={startJob} toast={toast} />
            )}
            {tab === 'presets' && <PresetsTab guildId={guildId} revision={revision} toast={toast} />}
            {tab === 'temp' && <TempTab guildId={guildId} revision={revision} onOpenMember={onOpenMember} toast={toast} />}
            {tab === 'menus' && <RoleMenusTab guildId={guildId} revision={revision} toast={toast} />}
        </section>
    );
}
