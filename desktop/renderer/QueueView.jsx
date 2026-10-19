import React, { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS, ROLE_PROBLEMS, accountAge, formatDateTime, formatTime, waitLabel } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import { ExtraRolesDialog, useAssignable } from './RoleDialogs.jsx';
import { Chip, FilterChip, StatusPill } from './Chips.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import FilterMenu from './FilterMenu.jsx';
import SelectionBar from './SelectionBar.jsx';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';
import Dialog from './Dialog.jsx';
import PunishDialog from './PunishDialog.jsx';
import useSelection, { marqueeStyle } from './useSelection.js';

const TABS = [
    { id: 'waiting', label: 'Ждут' },
    { id: 'handled', label: 'Пропущены сегодня' },
    { id: 'rejected', label: 'Отклонены' }
];

const SORTS = {
    oldest: { label: 'Сначала давно ждущие', fn: (a, b) => String(a.member.joinedAt).localeCompare(String(b.member.joinedAt)) },
    newest: { label: 'Сначала новые', fn: (a, b) => String(b.member.joinedAt).localeCompare(String(a.member.joinedAt)) },
    flagged: { label: 'Сначала с флагами', fn: (a, b) => b.member.flags.length - a.member.flags.length }
};

const HOUR_MS = 60 * 60 * 1000;
const LONG_WAIT_MS = 5 * HOUR_MS; // «Ждёт» turns amber after this
// "Когда зашли": newcomers vs. old accounts that have held the role for months
const JOINED = {
    all: { label: 'Зашли когда угодно', test: () => true },
    day: { label: 'Зашли за последние сутки', test: age => age <= 24 * HOUR_MS },
    week: { label: 'Зашли за последнюю неделю', test: age => age <= 7 * 24 * HOUR_MS },
    month: { label: 'Зашли за последний месяц', test: age => age <= 30 * 24 * HOUR_MS },
    older: { label: 'Ждут больше месяца', test: age => age > 30 * 24 * HOUR_MS }
};
const JOINED_KEY = 'panel.queue.joined';
const DENSITY_KEY = 'panel.queue.density';

function readStored(key, allowed, fallback) {
    try {
        const value = localStorage.getItem(key);
        return allowed.includes(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

function store(key, value) {
    try { localStorage.setItem(key, value); } catch { /* remembered per machine only */ }
}

const STAMP_MS = 900;
const UNDO_TOAST_MS = 10000;

/** «@Lev», «vanity» or «—» and the key the invite filter groups by */
function inviteLabel(invite) {
    if (!invite) return { key: 'unknown', text: '—', title: 'Неизвестно: бот не видел, по какой ссылке зашёл' };
    if (invite.vanity) return { key: 'vanity', text: 'vanity', title: 'Личная ссылка сервера' };
    if (invite.inviter) return { key: invite.inviter.id, text: `@${invite.inviter.displayName || invite.inviter.id}`, title: invite.code ? `discord.gg/${invite.code}` : undefined };
    return { key: 'unknown', text: invite.code || '—', title: invite.code ? `discord.gg/${invite.code}` : undefined };
}

function KickDialog({ names, busy, onClose, onKick }) {
    const [reason, setReason] = useState('');
    const many = names.length > 1;
    return (
        <Dialog title={many ? `Кикнуть ${names.length}?` : `Кикнуть ${names[0]}?`} onClose={onClose}
            onSubmit={() => reason.trim() && onKick(reason.trim())} submitLabel={many ? `Кикнуть ${names.length}` : 'Кикнуть'} submitTone="danger" busy={busy}>
            {many && <p className="muted small">{names.slice(0, 8).join(', ')}{names.length > 8 ? ` и ещё ${names.length - 8}` : ''}</p>}
            <label className="field">
                Причина — её увидят в журнале
                <input autoFocus value={reason} onChange={e => setReason(e.target.value)} maxLength={400} />
            </label>
            <p className="muted small">Человек сможет вернуться по приглашению.</p>
        </Dialog>
    );
}

function Row({ item, detailed, selected, focused, busy, stamp, isNew, viewers, extraRoles, onClickRow, onToggle, onApprove, onKick, onBan, onExtras, onClearExtras, onOpenMember }) {
    const { member } = item;
    const waitedMs = Date.now() - Date.parse(member.joinedAt || 0);
    const invite = inviteLabel(item.invite);
    const menu = [
        onExtras && { label: extraRoles.length ? 'Изменить доп. роли…' : 'Доп. роли…', onSelect: onExtras },
        { label: 'Открыть карточку', onSelect: () => onOpenMember(member.id) },
        { label: 'Кикнуть…', onSelect: onKick, end: true },
        { label: 'Забанить…', onSelect: onBan, end: true, danger: true }
    ];
    return (
        <>
            <tr data-select={member.id} aria-selected={selected}
                className={`queue-row ${selected ? 'is-selected' : ''} ${focused ? 'is-focused' : ''} ${stamp ? 'is-stamped' : ''} ${detailed ? 'has-detail' : ''}`}
                onClick={event => { if (!event.target.closest('button, input, a, [role="menu"]')) onClickRow(event); }}
                onDoubleClick={event => { if (!event.target.closest('button, input')) onOpenMember(member.id); }}>
                <td className="queue-check">
                    <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Выбрать ${member.displayName}`} />
                </td>
                <td>
                    <span className="queue-who">
                        <Avatar id={member.id} src={member.avatarURL} name={member.displayName} size={32} />
                        <span className="queue-names">
                            <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
                            <span className="muted small">@{member.username}</span>
                        </span>
                    </span>
                </td>
                <td>
                    {member.flags.length === 0
                        ? <span className="dash" aria-label="Флагов нет">—</span>
                        : <span className="queue-flags">{member.flags.map(flag => <Chip key={flag.code} tone={flag.tone}>{flag.label}</Chip>)}</span>}
                </td>
                <td className={`numeric nowrap ${waitedMs > LONG_WAIT_MS ? 'is-long-wait' : ''}`} title={`Зашёл ${formatDateTime(member.joinedAt)}`}>
                    {waitLabel(member.joinedAt)}
                </td>
                <td className="numeric nowrap" title={`Создан ${formatDateTime(member.accountCreatedAt)}`}>{accountAge(member.accountCreatedAt)}</td>
                <td className="nowrap queue-invite" title={invite.title}>{invite.text}</td>
                <td className="nowrap">
                    {viewers.length > 0 && <StatusPill tone="presence">Смотрит {viewers.join(', ')}</StatusPill>}
                    {viewers.length === 0 && isNew && <span className="queue-new">новый</span>}
                    {viewers.length === 0 && !isNew && !item.card && <span className="muted small" title="Карточки в Discord нет — пропустить можно только отсюда">без карточки</span>}
                </td>
                <td className="queue-decide">
                    {stamp ? <span className="row-stamp">{stamp}</span> : (
                        <>
                            <button type="button" className="btn btn-decide" disabled={busy} onClick={() => onApprove('male')}>Парень <kbd>M</kbd></button>
                            <button type="button" className="btn btn-decide" disabled={busy} onClick={() => onApprove('female')}>Девушка <kbd>F</kbd></button>
                            <OverflowMenu items={menu} label={`Ещё для ${member.displayName}: доп. роли, карточка, кик, бан`} />
                        </>
                    )}
                </td>
            </tr>
            {(detailed || item.error) && (
                <tr className={`queue-detail ${selected ? 'is-selected' : ''}`}>
                    <td />
                    <td colSpan={7}>
                        {detailed && (
                            <span className="queue-detail-line">
                                {extraRoles.length > 0 ? (
                                    <>
                                        <span className="muted small">Доп. роли:</span>
                                        {extraRoles.map(role => (
                                            <span key={role.id} className="role" style={{ '--role': role.color === '#000000' ? 'var(--muted)' : role.color }}>{role.name}</span>
                                        ))}
                                        <button type="button" className="btn btn-quiet btn-small" onClick={onClearExtras} aria-label="Убрать доп. роли">✕</button>
                                    </>
                                ) : onExtras && <button type="button" className="btn btn-quiet btn-small" onClick={onExtras}>+ Доп. роли…</button>}
                                <span className="muted small">зашёл {formatDateTime(member.joinedAt)} · ID {member.id}</span>
                            </span>
                        )}
                        {item.error && <p className="error small">{item.error}</p>}
                    </td>
                </tr>
            )}
        </>
    );
}

function HandledRow({ item, onOpenMember }) {
    const { member, card, handledBy } = item;
    const result = card.status === 'approved' ? GENDER_LABELS[card.gender] : `Кик: ${card.reason || 'без причины'}`;
    return (
        <li className="handled">
            <Avatar id={member.id} src={member.avatarURL} name={member.displayName} size={32} />
            <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
            <span className={`result result-${card.status}`}>{result}</span>
            <span className="muted">
                <MemberLink id={handledBy?.id} name={handledBy?.displayName} onOpen={onOpenMember} />
            </span>
            <span className="muted numeric" title={formatDateTime(card.handledAt)}>{formatTime(card.handledAt)}</span>
        </li>
    );
}

export default function QueueView({ guildId, waiting, seen, revision, presence = [], myId, onChanged, onOpenMember, toast }) {
    const [tab, setTab] = useState('waiting');
    const [sort, setSort] = useState('oldest');
    const [filters, setFilters] = useState({ flagged: false, young: false, unseen: false, invite: null });
    const [joined, setJoined] = useState(() => readStored(JOINED_KEY, Object.keys(JOINED), 'all'));
    const [density, setDensity] = useState(() => readStored(DENSITY_KEY, ['compact', 'detailed'], 'compact'));
    const [focusedId, setFocusedId] = useState(null);
    const [busy, setBusy] = useState({});       // userId -> true while a request runs
    const [errors, setErrors] = useState({});   // userId -> message
    const [leaving, setLeaving] = useState({}); // userId -> { item, stamp } shown briefly after a decision
    const [handled, setHandled] = useState(null);
    const [handledRetry, setHandledRetry] = useState(0);
    const [extras, setExtras] = useState({});   // userId -> extra role ids for the approval
    const [extrasFor, setExtrasFor] = useState(null); // member whose «Доп. роли» dialog is open
    const [kicking, setKicking] = useState(null);     // [items] waiting for a kick reason
    const [approving, setApproving] = useState(null); // { items, gender } — 3+ people: asked first
    const [banning, setBanning] = useState(null);     // member to ban
    const [groupBusy, setGroupBusy] = useState(false);
    const [openMenu, setOpenMenu] = useState(null); // 'invite' | 'joined' — the filter menu that is open
    const { roles: assignable } = useAssignable(guildId);
    const roleOf = id => assignable?.find(r => r.id === id) || null;
    const youngDays = waiting?.youngAccountDays ?? 7;

    useEffect(() => { setFocusedId(null); setLeaving({}); setErrors({}); setExtras({}); }, [guildId]);

    // «Пропущены / Отклонены сегодня»
    useEffect(() => {
        if (tab === 'waiting') return undefined;
        let cancelled = false;
        setHandled(null);
        apiGet(`/guilds/${guildId}/queue?tab=${tab}`)
            .then(data => { if (!cancelled) setHandled(data); })
            .catch(error => { if (!cancelled) setHandled({ items: [], error }); });
        return () => { cancelled = true; };
    }, [guildId, tab, revision, handledRetry]);

    const all = useMemo(() => (waiting?.items || []).map(item => ({ ...item, error: errors[item.member.id] })), [waiting, errors]);
    const isYoung = item => item.member.flags.some(flag => flag.code === 'young');

    const items = useMemo(() => {
        const current = [...all];
        // Keep just-decided rows on screen for the stamp, even after the server dropped them
        for (const [id, entry] of Object.entries(leaving)) {
            if (!current.some(item => item.member.id === id)) current.push(entry.item);
        }
        const now = Date.now();
        const visible = current.filter(item => leaving[item.member.id] || (
            (!filters.flagged || item.member.flags.length > 0)
            && (!filters.young || isYoung(item))
            && (!filters.unseen || seen.isNew(item.member.id))
            && (!filters.invite || inviteLabel(item.invite).key === filters.invite)
            && JOINED[joined].test(now - Date.parse(item.member.joinedAt || 0))));
        return [...visible].sort(SORTS[sort].fn);
    }, [all, leaving, sort, filters, seen, joined]);

    const ids = items.filter(item => !leaving[item.member.id]).map(item => item.member.id);
    const dialogOpen = Boolean(extrasFor || kicking || approving || banning);
    const selection = useSelection(ids, { paused: dialogOpen || tab !== 'waiting' });
    const chosenItems = selection.chosen.map(id => items.find(item => item.member.id === id)).filter(Boolean);

    // Who else has this newcomer's card open: «Смотрит Kira»
    const viewersOf = useMemo(() => {
        const map = new Map();
        for (const user of presence) {
            if (!user.viewingId || user.id === myId) continue;
            if (!map.has(user.viewingId)) map.set(user.viewingId, []);
            map.get(user.viewingId).push(user.displayName || user.id);
        }
        return map;
    }, [presence, myId]);

    const counts = {
        flagged: all.filter(item => item.member.flags.length > 0).length,
        young: all.filter(isYoung).length,
        unseen: all.filter(item => seen.isNew(item.member.id)).length
    };
    const inviteGroups = useMemo(() => {
        const groups = new Map();
        for (const item of all) {
            const label = inviteLabel(item.invite);
            const group = groups.get(label.key) || { key: label.key, text: label.key === 'unknown' ? 'Неизвестно' : label.text, count: 0 };
            group.count++;
            groups.set(label.key, group);
        }
        return [...groups.values()].sort((a, b) => b.count - a.count);
    }, [all]);
    const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));

    const dropExtras = id => setExtras(x => { const next = { ...x }; delete next[id]; return next; });

    /** One decision; returns true when it went through. `quiet` — part of a group action (one toast for all). */
    const decide = async (item, action, body, { quiet = false } = {}) => {
        const id = item.member.id;
        setBusy(b => ({ ...b, [id]: true }));
        setErrors(e => ({ ...e, [id]: null }));
        const extraIds = action === 'approve' ? (extras[id] || []) : [];
        const result = await apiPost(`/guilds/${guildId}/queue/${id}/${action}`, extraIds.length ? { ...body, roleIds: extraIds } : body);
        setBusy(b => ({ ...b, [id]: false }));

        if (!result.ok) {
            setErrors(e => ({ ...e, [id]: describeError(result) }));
            if (result.error === 'already_handled' || result.error === 'member_left') onChanged();
            return false;
        }

        const stamp = action === 'kick' ? 'Кик' : 'Пропущен';
        setLeaving(l => ({ ...l, [id]: { item, stamp } }));
        setTimeout(() => setLeaving(l => { const next = { ...l }; delete next[id]; return next; }), STAMP_MS);
        if (focusedId === id) {
            const index = ids.indexOf(id);
            setFocusedId(ids[index + 1] || ids[index - 1] || null);
        }
        onChanged();
        if (quiet) return true;

        const name = item.member.displayName;
        if (action === 'approve') {
            dropExtras(id);
            const skipped = result.data.skippedRoles || [];
            const added = extraIds.length - skipped.length;
            const note = (added > 0 ? ` · +${added} доп. ${added === 1 ? 'роль' : 'роли'}` : '')
                + (skipped.length ? ` · не выданы: ${skipped.map(r => `${r.name || 'удалённая'} (${ROLE_PROBLEMS[r.code] || r.code})`).join(', ')}` : '');
            toast(`Пропущен ${name} · ${GENDER_LABELS[body.gender]}${note}`, {
                tone: skipped.length ? 'error' : null,
                ttl: UNDO_TOAST_MS,
                action: {
                    label: 'Отменить',
                    onClick: async () => {
                        const undo = await apiPost(`/guilds/${guildId}/queue/${id}/undo`);
                        toast(undo.ok ? `${name} снова в очереди` : describeError(undo), { tone: undo.ok ? null : 'error' });
                        onChanged();
                    }
                }
            });
        } else {
            toast(`Кикнут ${name}`);
        }
        return true;
    };

    /** The same decision for several people, one after another, one toast at the end. */
    const decideMany = async (group, action, body) => {
        if (group.length === 1) { await decide(group[0], action, body); return; }
        setGroupBusy(true);
        const done = [];
        const failed = [];
        for (const item of group) {
            if (await decide(item, action, body, { quiet: true })) done.push(item.member.id);
            else failed.push(item.member.displayName);
        }
        setGroupBusy(false);
        selection.clear();
        if (action === 'approve') done.forEach(dropExtras);
        const verb = action === 'kick' ? 'Кикнуто' : `Пропущено · ${GENDER_LABELS[body.gender]}:`;
        const text = `${verb} ${done.length} из ${group.length}${failed.length ? ` · не вышло: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}` : ''}`;
        // A pass is reversible (a kick is not): «Отменить» puts all of them back in the queue
        const undo = action === 'approve' && done.length ? {
            label: 'Отменить',
            onClick: async () => {
                let back = 0;
                for (const id of done) if ((await apiPost(`/guilds/${guildId}/queue/${id}/undo`)).ok) back++;
                toast(back === done.length ? `Снова в очереди: ${back}` : `Вернули ${back} из ${done.length} — для остальных время на отмену вышло`,
                    back === done.length ? {} : { tone: 'error' });
                onChanged();
            }
        } : undefined;
        toast(text, { tone: failed.length ? 'error' : null, ttl: undo ? UNDO_TOAST_MS : 8000, action: undo });
    };

    const approve = (group, gender) => {
        if (group.length >= 3) setApproving({ items: group, gender });
        else decideMany(group, 'approve', { gender });
    };

    // Keyboard: ↑/↓ move the row focus, Space marks it, M / F let in, K kicks, Enter opens the card
    useEffect(() => {
        if (tab !== 'waiting' || dialogOpen) return undefined;
        const onKey = event => {
            if (event.target.closest('input, textarea, select, [role="menu"], [role="dialog"]') || event.ctrlKey || event.altKey || event.metaKey) return;
            // Space / Enter on a focused button, link or tab press that control, not the row
            if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('button, a, [role="tab"], [role="button"]')) return;
            const index = ids.indexOf(focusedId);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = event.key === 'ArrowDown' ? Math.min(index + 1, ids.length - 1) : Math.max(index - 1, 0);
                setFocusedId(ids[next] || null);
                return;
            }
            if (index < 0 || busy[focusedId]) return;
            const item = items.find(i => i.member.id === focusedId);
            const key = event.key.toLowerCase();
            if (event.key === ' ') { event.preventDefault(); selection.toggle(focusedId); }
            else if (event.key === 'Enter') onOpenMember(focusedId);
            // Russian layout: M → ь, F → а, K → л
            else if (key === 'm' || key === 'ь') decide(item, 'approve', { gender: 'male' });
            else if (key === 'f' || key === 'а') decide(item, 'approve', { gender: 'female' });
            else if (key === 'k' || key === 'л') setKicking([item]);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    useEffect(() => {
        if (!focusedId) return;
        selection.listRef.current?.querySelector('.queue-row.is-focused')?.scrollIntoView({ block: 'nearest' });
        seen.markSeen([focusedId]); // the row focus counts as having seen that newcomer
    }, [focusedId, seen.markSeen]); // eslint-disable-line react-hooks/exhaustive-deps

    const waitingCount = waiting?.items?.length ?? 0;
    const shownCount = ids.length;
    const filtered = filters.flagged || filters.young || filters.unseen || filters.invite || joined !== 'all';
    const tabLabel = id => {
        if (id === 'waiting') return `Ждут · ${shownCount === waitingCount ? waitingCount : `${shownCount} из ${waitingCount}`}`;
        const count = waiting?.counts?.[id];
        return count === undefined ? TABS.find(t => t.id === id).label : `${TABS.find(t => t.id === id).label} · ${count}`;
    };
    const inviteText = filters.invite ? inviteGroups.find(g => g.key === filters.invite)?.text || 'Инвайт' : 'Инвайт';

    return (
        <section className="view view-wide queue-view">
            <div className="view-head">
                <h1>Пропуск новичков</h1>
                <div className="tabs" role="tablist">
                    {TABS.map(t => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id}
                            className={`tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
                            {tabLabel(t.id)}
                        </button>
                    ))}
                </div>
            </div>

            {tab === 'waiting' && (
                <>
                    <div className="toolbar queue-toolbar">
                        <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Сортировка">
                            {Object.entries(SORTS).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}
                        </select>
                        <FilterChip active={filters.flagged} count={counts.flagged} onClick={() => setFilter('flagged', !filters.flagged)}>С флагами</FilterChip>
                        <FilterChip active={filters.young} count={counts.young} onClick={() => setFilter('young', !filters.young)}>Аккаунт младше {youngDays} дн.</FilterChip>
                        {counts.unseen > 0 && (
                            <>
                                <FilterChip active={filters.unseen} count={counts.unseen} onClick={() => setFilter('unseen', !filters.unseen)}>Новые</FilterChip>
                                <button type="button" className="icon-button icon-button-quiet" onClick={seen.markAllSeen}
                                    aria-label="Отметить всех просмотренными" title="Отметить всех просмотренными">✓</button>
                            </>
                        )}
                        <FilterMenu label={inviteText} active={Boolean(filters.invite)} open={openMenu === 'invite'}
                            onToggle={() => setOpenMenu(m => (m === 'invite' ? null : 'invite'))} onClose={() => setOpenMenu(null)}>
                            <button type="button" role="menuitem" className="menu-entry" onClick={() => { setFilter('invite', null); setOpenMenu(null); }}>Все инвайты</button>
                            <div className="menu-sep" role="separator" />
                            {inviteGroups.map(group => (
                                <button key={group.key} type="button" role="menuitem" className="menu-entry menu-entry-count"
                                    onClick={() => { setFilter('invite', group.key); setOpenMenu(null); }}>
                                    <span>{group.text}</span><span className="muted numeric">{group.count}</span>
                                </button>
                            ))}
                            {waiting && waiting.invitesTracked === false && <p className="muted small menu-note">Бот не видит инвайты: дайте ему «Управлять сервером».</p>}
                        </FilterMenu>
                        <FilterMenu label={joined === 'all' ? 'Когда зашли' : JOINED[joined].label} active={joined !== 'all'} open={openMenu === 'joined'}
                            onToggle={() => setOpenMenu(m => (m === 'joined' ? null : 'joined'))} onClose={() => setOpenMenu(null)}>
                            {Object.entries(JOINED).map(([id, j]) => (
                                <button key={id} type="button" role="menuitemradio" aria-checked={joined === id} className="menu-entry"
                                    onClick={() => { setJoined(id); store(JOINED_KEY, id); setOpenMenu(null); }}>{j.label}</button>
                            ))}
                        </FilterMenu>
                        <span className="toolbar-spacer" />
                        <span className="muted small queue-keys-hint">M / F — пропуск · K — кик</span>
                        <div className="segmented segmented-small" role="group" aria-label="Плотность списка">
                            {[['compact', 'Компактно'], ['detailed', 'Подробно']].map(([id, label]) => (
                                <button key={id} type="button" className={`tab ${density === id ? 'is-active' : ''}`} aria-pressed={density === id}
                                    onClick={() => { setDensity(id); store(DENSITY_KEY, id); }}>{label}</button>
                            ))}
                        </div>
                    </div>

                    <SelectionBar names={chosenItems.map(item => item.member.displayName)} onClear={selection.clear}>
                        <button type="button" className="btn" disabled={groupBusy} onClick={() => approve(chosenItems, 'male')}>Парень</button>
                        <button type="button" className="btn" disabled={groupBusy} onClick={() => approve(chosenItems, 'female')}>Девушка</button>
                        <button type="button" className="btn btn-danger" disabled={groupBusy} onClick={() => setKicking(chosenItems)}>Кикнуть {chosenItems.length}</button>
                    </SelectionBar>

                    {waiting?.error && <ErrorState what="очередь" error={waiting.error} onRetry={onChanged} />}
                    {!waiting && <Skeleton rows={6} height={58} />}
                    {waiting && !waiting.error && items.length === 0 && (
                        waitingCount === 0
                            ? <EmptyState icon="queue" title="Очередь пуста" text="Новые люди появятся здесь сами, как только зайдут на сервер." />
                            : <EmptyState icon="queue" title="Под эти фильтры никто не подходит" text={`Всего в очереди ${waitingCount}.`}
                                action={filtered && <button type="button" className="btn" onClick={() => { setFilters({ flagged: false, young: false, unseen: false, invite: null }); setJoined('all'); store(JOINED_KEY, 'all'); }}>Сбросить фильтры</button>} />
                    )}
                    {items.length > 0 && (
                        <div className="queue-table-wrap" ref={selection.listRef} onMouseDown={selection.startMarquee}>
                            <table className={`queue-table ${density === 'detailed' ? 'is-detailed' : ''}`}>
                                <thead>
                                    <tr>
                                        <th className="queue-check">
                                            <input type="checkbox" aria-label="Выбрать всех"
                                                checked={ids.length > 0 && selection.chosen.length === ids.length}
                                                ref={el => { if (el) el.indeterminate = selection.chosen.length > 0 && selection.chosen.length < ids.length; }}
                                                onChange={() => selection.setSelected(selection.chosen.length === ids.length ? new Set() : new Set(ids))} />
                                        </th>
                                        <th>Участник</th>
                                        <th>Флаги</th>
                                        <th>Ждёт</th>
                                        <th>Аккаунт</th>
                                        <th>Инвайт</th>
                                        <th>Статус</th>
                                        <th className="queue-decide">Решение</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map(item => {
                                        const id = item.member.id;
                                        return (
                                            <Row
                                                key={id}
                                                item={item}
                                                detailed={density === 'detailed'}
                                                selected={selection.selected.has(id)}
                                                focused={focusedId === id}
                                                busy={Boolean(busy[id]) || groupBusy}
                                                stamp={leaving[id]?.stamp}
                                                isNew={seen.isNew(id)}
                                                viewers={viewersOf.get(id) || []}
                                                extraRoles={(extras[id] || []).map(roleOf).filter(Boolean)}
                                                onClickRow={event => { selection.click(event, id); setFocusedId(id); }}
                                                onToggle={() => { selection.toggle(id); setFocusedId(id); }}
                                                onApprove={gender => decide(item, 'approve', { gender })}
                                                onKick={() => setKicking([item])}
                                                onBan={() => setBanning(item.member)}
                                                onExtras={assignable?.length ? () => setExtrasFor(item.member) : null}
                                                onClearExtras={() => dropExtras(id)}
                                                onOpenMember={onOpenMember}
                                            />
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {selection.marquee && <div className="marquee" style={marqueeStyle(selection.marquee)} />}

                    {extrasFor && (
                        <ExtraRolesDialog guildId={guildId} name={extrasFor.displayName} value={extras[extrasFor.id] || []}
                            excludeIds={waiting?.reservedRoleIds || []}
                            onClose={() => setExtrasFor(null)}
                            onPick={roleIds => { setExtras(x => ({ ...x, [extrasFor.id]: roleIds })); setExtrasFor(null); }} />
                    )}
                    {kicking && (
                        <KickDialog names={kicking.map(item => item.member.displayName)} busy={groupBusy}
                            onClose={() => setKicking(null)}
                            onKick={async reason => { const group = kicking; setKicking(null); await decideMany(group, 'kick', { reason }); }} />
                    )}
                    {approving && (
                        <Dialog title={`Пропустить ${approving.items.length} как «${GENDER_LABELS[approving.gender]}»?`} onClose={() => setApproving(null)}
                            onSubmit={async () => { const { items: group, gender } = approving; setApproving(null); await decideMany(group, 'approve', { gender }); }}
                            submitLabel={`Пропустить ${approving.items.length}`} busy={groupBusy}>
                            <p className="muted small">{approving.items.map(item => item.member.displayName).slice(0, 10).join(', ')}{approving.items.length > 10 ? ` и ещё ${approving.items.length - 10}` : ''}</p>
                            <p className="muted small">Доп. роли, выбранные для каждого, тоже выдадутся.</p>
                        </Dialog>
                    )}
                    {banning && (
                        <PunishDialog guildId={guildId} kind="ban" target={banning}
                            onClose={() => setBanning(null)} onDone={onChanged} toast={toast} />
                    )}
                </>
            )}

            {tab !== 'waiting' && (
                <>
                    {!handled && <Skeleton rows={4} height={52} />}
                    {handled?.error && <ErrorState what="список" error={handled.error} onRetry={() => setHandledRetry(n => n + 1)} />}
                    {handled && !handled.error && handled.items.length === 0 && (
                        <EmptyState icon="queue" title={tab === 'handled' ? 'Сегодня ещё никого не пропустили' : 'Сегодня никого не кикнули'} />
                    )}
                    <ul className="handled-list">
                        {handled?.items?.map(item => <HandledRow key={item.member.id} item={item} onOpenMember={onOpenMember} />)}
                    </ul>
                </>
            )}
        </section>
    );
}
