import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS, accountAge, formatDateTime, formatTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';

const TABS = [
    { id: 'waiting', label: 'Ждут' },
    { id: 'handled', label: 'Пропущены сегодня' },
    { id: 'rejected', label: 'Отклонены сегодня' }
];

const SORTS = {
    oldest: { label: 'Сначала давно ждущие', fn: (a, b) => String(a.member.joinedAt).localeCompare(String(b.member.joinedAt)) },
    newest: { label: 'Сначала новые', fn: (a, b) => String(b.member.joinedAt).localeCompare(String(a.member.joinedAt)) },
    flagged: { label: 'Сначала с флагами', fn: (a, b) => b.member.flags.length - a.member.flags.length }
};

const STAMP_MS = 900;
const UNDO_TOAST_MS = 10000;

function Pass({ item, selected, busy, stamp, onSelect, onApprove, onKick, onOpenMember }) {
    const [kicking, setKicking] = useState(false);
    const [reason, setReason] = useState('');
    const { member } = item;

    return (
        <li
            className={`pass ${selected ? 'is-selected' : ''} ${stamp ? 'is-stamped' : ''}`}
            onClick={onSelect}
            aria-selected={selected}
        >
            <div className="pass-body">
                <Avatar src={member.avatarURL} name={member.displayName} size={48} />
                <div className="pass-info">
                    <div className="pass-name">
                        <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
                        <span className="muted">@{member.username}</span>
                    </div>
                    <dl className="pass-facts">
                        <div><dt>Зашёл</dt><dd title={formatDateTime(member.joinedAt)}>{timeAgo(member.joinedAt)}</dd></div>
                        <div><dt>Аккаунту</dt><dd>{accountAge(member.accountCreatedAt)}</dd></div>
                        <div><dt>ID</dt><dd className="numeric">{member.id}</dd></div>
                    </dl>
                    {member.flags.length > 0 && (
                        <ul className="flags">{member.flags.map(flag => <li key={flag}>{flag.replace(/^⚠️\s*/, '')}</li>)}</ul>
                    )}
                    {!item.card && <p className="muted small">Карточки в Discord нет — пропустить можно только отсюда.</p>}
                    {item.error && <p className="error small">{item.error}</p>}
                    {kicking && (
                        <form className="kick-form" onClick={e => e.stopPropagation()}
                            onSubmit={e => { e.preventDefault(); onKick(reason.trim()); }}>
                            <input autoFocus placeholder="Причина кика — её увидят в журнале" value={reason}
                                onChange={e => setReason(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Escape') setKicking(false); }} />
                            <button type="submit" className="btn btn-danger" disabled={busy || !reason.trim()}>Кикнуть</button>
                            <button type="button" className="btn btn-quiet" onClick={() => setKicking(false)}>Отмена</button>
                        </form>
                    )}
                </div>
            </div>
            <div className="pass-stub" onClick={e => e.stopPropagation()}>
                <button className="btn btn-stub" disabled={busy || kicking} onClick={() => onApprove('male')}>
                    Парень <kbd>M</kbd>
                </button>
                <button className="btn btn-stub" disabled={busy || kicking} onClick={() => onApprove('female')}>
                    Девушка <kbd>F</kbd>
                </button>
                <button className="btn btn-stub btn-stub-danger" disabled={busy || kicking} onClick={() => setKicking(true)}>
                    Кик
                </button>
            </div>
            {stamp && <div className="stamp" aria-hidden="true">{stamp}</div>}
        </li>
    );
}

function HandledRow({ item, onOpenMember }) {
    const { member, card, handledBy } = item;
    const result = card.status === 'approved' ? GENDER_LABELS[card.gender] : `Кик: ${card.reason || 'без причины'}`;
    return (
        <li className="handled">
            <Avatar src={member.avatarURL} name={member.displayName} size={32} />
            <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
            <span className={`result result-${card.status}`}>{result}</span>
            <span className="muted">
                <MemberLink id={handledBy?.id} name={handledBy?.displayName} onOpen={onOpenMember} />
            </span>
            <span className="muted numeric">{formatTime(card.handledAt)}</span>
        </li>
    );
}

export default function QueueView({ guildId, waiting, revision, onChanged, onOpenMember, toast }) {
    const [tab, setTab] = useState('waiting');
    const [sort, setSort] = useState('oldest');
    const [onlyFlagged, setOnlyFlagged] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [busy, setBusy] = useState({});      // userId -> true while a request runs
    const [errors, setErrors] = useState({});  // userId -> message
    const [leaving, setLeaving] = useState({}); // userId -> { item, stamp } shown briefly after a decision
    const [handled, setHandled] = useState(null);
    const listRef = useRef(null);

    useEffect(() => { setSelectedId(null); setLeaving({}); setErrors({}); }, [guildId]);

    // "Пропущены / Отклонены сегодня"
    useEffect(() => {
        if (tab === 'waiting') return;
        let cancelled = false;
        setHandled(null);
        apiGet(`/guilds/${guildId}/queue?tab=${tab}`)
            .then(data => { if (!cancelled) setHandled(data); })
            .catch(error => { if (!cancelled) setHandled({ items: [], error: describeError(error) }); });
        return () => { cancelled = true; };
    }, [guildId, tab, revision]);

    const items = useMemo(() => {
        const current = (waiting?.items || []).map(item => ({ ...item, error: errors[item.member.id] }));
        // Keep just-decided passes on screen for the stamp, even after the server dropped them
        for (const [id, entry] of Object.entries(leaving)) {
            if (!current.some(item => item.member.id === id)) current.push(entry.item);
        }
        const visible = onlyFlagged ? current.filter(item => item.member.flags.length > 0) : current;
        return [...visible].sort(SORTS[sort].fn);
    }, [waiting, leaving, errors, sort, onlyFlagged]);

    const decide = async (item, action, body) => {
        const id = item.member.id;
        setBusy(b => ({ ...b, [id]: true }));
        setErrors(e => ({ ...e, [id]: null }));
        const result = await apiPost(`/guilds/${guildId}/queue/${id}/${action}`, body);
        setBusy(b => ({ ...b, [id]: false }));

        if (!result.ok) {
            setErrors(e => ({ ...e, [id]: describeError(result) }));
            if (result.error === 'already_handled' || result.error === 'member_left') onChanged();
            return;
        }

        const stamp = action === 'kick' ? 'Кик' : 'Пропущен';
        setLeaving(l => ({ ...l, [id]: { item, stamp } }));
        setTimeout(() => setLeaving(l => { const next = { ...l }; delete next[id]; return next; }), STAMP_MS);
        if (selectedId === id) {
            const index = items.findIndex(i => i.member.id === id);
            setSelectedId(items[index + 1]?.member.id || items[index - 1]?.member.id || null);
        }
        onChanged();

        const name = item.member.displayName;
        if (action === 'approve') {
            toast(`Пропущен ${name} · ${GENDER_LABELS[body.gender]}`, {
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
    };

    // Keyboard: ↑/↓ choose a pass, M / F approve it, Esc clears the choice
    useEffect(() => {
        if (tab !== 'waiting') return undefined;
        const onKey = event => {
            if (event.target.closest('input, textarea, select') || event.ctrlKey || event.altKey || event.metaKey) return;
            const index = items.findIndex(item => item.member.id === selectedId);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
                setSelectedId(items[next]?.member.id || null);
            } else if (event.key === 'Escape') {
                setSelectedId(null);
            } else if (index >= 0 && !busy[selectedId] && !leaving[selectedId]) {
                const key = event.key.toLowerCase();
                // Russian layout: M → ь, F → а
                if (key === 'm' || key === 'ь') decide(items[index], 'approve', { gender: 'male' });
                if (key === 'f' || key === 'а') decide(items[index], 'approve', { gender: 'female' });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    useEffect(() => {
        listRef.current?.querySelector('.pass.is-selected')?.scrollIntoView({ block: 'nearest' });
    }, [selectedId]);

    const waitingCount = waiting?.items?.length ?? 0;

    return (
        <section className="view">
            <div className="view-head">
                <h1>Пропуск новичков</h1>
                <div className="tabs" role="tablist">
                    {TABS.map(t => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id}
                            className={`tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
                            {t.label}{t.id === 'waiting' ? ` · ${waitingCount}` : ''}
                        </button>
                    ))}
                </div>
            </div>

            {tab === 'waiting' && (
                <>
                    <div className="toolbar">
                        <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Сортировка">
                            {Object.entries(SORTS).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}
                        </select>
                        <label className="check">
                            <input type="checkbox" checked={onlyFlagged} onChange={e => setOnlyFlagged(e.target.checked)} />
                            Только с флагами
                        </label>
                        <span className="muted small hint">↑ ↓ — выбрать, M / F — пропустить</span>
                    </div>
                    {waiting?.error && <p className="error">{describeError(waiting.error)}</p>}
                    {!waiting && <p className="muted">Загружаем очередь…</p>}
                    {waiting && !waiting.error && items.length === 0 && (
                        <div className="empty">
                            <h2>{onlyFlagged ? 'Новичков с флагами нет' : 'Очередь пуста'}</h2>
                            <p>Новые люди появятся здесь сами, как только зайдут на сервер.</p>
                        </div>
                    )}
                    <ul className="passes" ref={listRef}>
                        {items.map(item => (
                            <Pass
                                key={item.member.id}
                                item={item}
                                selected={item.member.id === selectedId}
                                busy={Boolean(busy[item.member.id])}
                                stamp={leaving[item.member.id]?.stamp}
                                onSelect={() => setSelectedId(item.member.id)}
                                onApprove={gender => decide(item, 'approve', { gender })}
                                onKick={reason => decide(item, 'kick', { reason })}
                                onOpenMember={onOpenMember}
                            />
                        ))}
                    </ul>
                </>
            )}

            {tab !== 'waiting' && (
                <>
                    {!handled && <p className="muted">Загружаем…</p>}
                    {handled?.error && <p className="error">{handled.error}</p>}
                    {handled && !handled.error && handled.items.length === 0 && (
                        <div className="empty"><h2>{tab === 'handled' ? 'Сегодня ещё никого не пропустили' : 'Сегодня никого не кикнули'}</h2></div>
                    )}
                    <ul className="handled-list">
                        {handled?.items?.map(item => <HandledRow key={item.member.id} item={item} onOpenMember={onOpenMember} />)}
                    </ul>
                </>
            )}
        </section>
    );
}
