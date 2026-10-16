import React, { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, describeError } from './api.js';
import { SOURCE_LABELS, formatDateTime, formatDurationMs, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import PunishDialog, { useModerationOptions } from './PunishDialog.jsx';

const TABS = [
    { id: 'active', label: 'Активные наказания' },
    { id: 'bans', label: 'Баны' },
    { id: 'warnings', label: 'Варны' }
];
const TAB_KEY = 'panel.moderation.tab';

function readTab() {
    try { return localStorage.getItem(TAB_KEY) || 'active'; } catch { return 'active'; }
}

function Who({ actor, source, onOpenMember }) {
    if (actor) return <MemberLink id={actor.id} name={actor.displayName} onOpen={onOpenMember} />;
    return <span className="muted">{source === 'auto' ? 'бот, эскалация' : 'не через Nexus'}</span>;
}

/** Re-render every 30 s so "осталось 42 мин" stays current. */
function useTicker() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick(n => n + 1), 30 * 1000);
        return () => clearInterval(timer);
    }, []);
}

function ActiveTab({ data, guildId, onOpenMember, onChanged, toast }) {
    useTicker();
    const [busy, setBusy] = useState(null);

    const lift = async (kind, user) => {
        setBusy(user.id);
        const result = await apiPost(`/guilds/${guildId}/moderation/${user.id}/${kind}`);
        setBusy(null);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(kind === 'unmute' ? `Мут снят: ${user.displayName || user.id}` : `Разбанен: ${user.displayName || user.id}`);
        onChanged();
    };

    if (data.mutes.length === 0 && data.bans.length === 0) {
        return (
            <div className="empty">
                <h2>Сейчас никто не наказан</h2>
                <p>Здесь появятся муты и временные баны с таймером до конца.</p>
            </div>
        );
    }

    const rows = [
        ...data.mutes.map(item => ({ kind: 'mute', user: item.member, ...item })),
        ...data.bans.map(item => ({ kind: 'ban', ...item }))
    ].sort((a, b) => a.until.localeCompare(b.until));

    return (
        <ul className="punishments">
            {rows.map(row => (
                <li key={`${row.kind}:${row.user.id}`} className={`punishment punishment-${row.kind}`}>
                    <Avatar src={row.user.avatarURL} name={row.user.displayName} size={36} />
                    <div className="punishment-who">
                        <MemberLink id={row.user.id} name={row.user.displayName || row.user.id} onOpen={onOpenMember} />
                        <span className="muted small">{row.reason || 'причина неизвестна'}</span>
                    </div>
                    <div className="punishment-kind">
                        <span className={`badge badge-${row.kind}`}>{row.kind === 'mute' ? 'Мут' : 'Временный бан'}</span>
                        <span className="small muted">выдал <Who actor={row.actor} source={row.source} onOpenMember={onOpenMember} /></span>
                    </div>
                    <div className="punishment-time">
                        <strong className="numeric">{timeLeft(row.until)}</strong>
                        <span className="muted small numeric">до {formatDateTime(row.until)}</span>
                    </div>
                    <button className="btn" disabled={busy === row.user.id}
                        onClick={() => lift(row.kind === 'mute' ? 'unmute' : 'unban', row.user)}>
                        {row.kind === 'mute' ? 'Снять мут' : 'Разбанить'}
                    </button>
                </li>
            ))}
        </ul>
    );
}

function BansTab({ data, guildId, onOpenMember, onChanged, onBanById, toast }) {
    const [query, setQuery] = useState('');
    const [confirming, setConfirming] = useState(null);

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return data.items;
        return data.items.filter(item => [item.user.id, item.user.username, item.user.displayName, item.reason]
            .some(value => value && value.toLowerCase().includes(needle)));
    }, [data.items, query]);

    const unban = async user => {
        const result = await apiPost(`/guilds/${guildId}/moderation/${user.id}/unban`);
        setConfirming(null);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Разбанен: ${user.displayName || user.id}`);
        onChanged();
    };

    return (
        <>
            <div className="toolbar">
                <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Ник, ID или причина" aria-label="Поиск по банам" />
                <span className="muted small">Банов: {data.items.length}</span>
                <button className="btn hint" onClick={onBanById}>Забанить по ID</button>
            </div>
            {shown.length === 0 && (
                <div className="empty">
                    <h2>{query ? 'Никого не нашли' : 'Банов нет'}</h2>
                </div>
            )}
            <div className="table-wrap">
                {shown.length > 0 && (
                    <table className="journal">
                        <thead><tr><th>Кто</th><th>Причина</th><th>Забанил</th><th>Когда</th><th>Срок</th><th /></tr></thead>
                        <tbody>
                            {shown.map(item => (
                                <tr key={item.user.id}>
                                    <td>
                                        <span className="who-cell">
                                            <Avatar src={item.user.avatarURL} name={item.user.displayName} size={24} />
                                            <span>
                                                {item.user.displayName || item.user.id}
                                                <span className="muted small numeric"> {item.user.id}</span>
                                            </span>
                                        </span>
                                    </td>
                                    <td className="reason">{item.reason || '—'}</td>
                                    <td>{item.actor ? <MemberLink id={item.actor.id} name={item.actor.displayName} onOpen={onOpenMember} /> : <span className="muted">—</span>}</td>
                                    <td className="numeric nowrap">{item.bannedAt ? formatDateTime(item.bannedAt) : <span className="muted">раньше 30 дней</span>}</td>
                                    <td className="nowrap">{item.until ? `до ${formatDateTime(item.until)}` : 'навсегда'}</td>
                                    <td className="nowrap">
                                        {confirming === item.user.id ? (
                                            <span className="confirm">
                                                <button className="btn btn-danger" onClick={() => unban(item.user)}>Да, разбанить</button>
                                                <button className="btn btn-quiet" onClick={() => setConfirming(null)}>Нет</button>
                                            </span>
                                        ) : (
                                            <button className="btn" onClick={() => setConfirming(item.user.id)}>Разбанить</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </>
    );
}

/** "2 варна → мут 1 ч · 5 → предложение бана" from the server's escalation rules */
function describeEscalation(rules) {
    return (rules || []).map((rule, index) => {
        const what = rule.action === 'timeout' ? `мут ${formatDurationMs(rule.durationMs)}` : 'предложение бана';
        return `${rule.warns}${index === 0 ? ' варна' : ''} → ${what}`;
    }).join(' · ');
}

function WarningsTab({ data, guildId, onOpenMember, onChanged, toast }) {
    const [byMember, setByMember] = useState(false);
    const options = useModerationOptions(guildId);

    const remove = async warn => {
        const result = await apiDelete(`/guilds/${guildId}/moderation/warnings/${warn.id}`);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Варн снят: ${warn.user?.displayName || warn.user?.id}`);
        onChanged();
    };

    const groups = useMemo(() => {
        const map = new Map();
        for (const warn of data.items) {
            const key = warn.user.id;
            if (!map.has(key)) map.set(key, { user: warn.user, warns: [] });
            map.get(key).warns.push(warn);
        }
        return [...map.values()].sort((a, b) => b.warns.length - a.warns.length);
    }, [data.items]);

    if (data.items.length === 0) {
        return (
            <div className="empty">
                <h2>Активных варнов нет</h2>
                <p>Варн выдаётся из карточки участника или командой /warn. Через 30 дней он сгорает сам.</p>
            </div>
        );
    }

    return (
        <>
            <div className="toolbar">
                <label className="check"><input type="checkbox" checked={byMember} onChange={() => setByMember(v => !v)} /> По участникам</label>
                <span className="muted small hint">{describeEscalation(options?.escalation)}</span>
            </div>
            {byMember ? (
                <ul className="warn-groups">
                    {groups.map(group => (
                        <li key={group.user.id}>
                            <span className="warn-count numeric">{group.warns.length}</span>
                            <MemberLink id={group.user.id} name={group.user.displayName || group.user.id} onOpen={onOpenMember} />
                            <span className="muted small">{group.warns.map(w => w.reason).join(', ')}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="table-wrap">
                    <table className="journal">
                        <thead><tr><th>Кому</th><th>Причина</th><th>Выдал</th><th>Когда</th><th>Сгорит</th><th /></tr></thead>
                        <tbody>
                            {data.items.map(warn => (
                                <tr key={warn.id}>
                                    <td>
                                        <MemberLink id={warn.user.id} name={warn.user.displayName || warn.user.id} onOpen={onOpenMember} />
                                        <span className="warn-count-inline numeric" title="Активных варнов у него">{warn.activeCount}</span>
                                    </td>
                                    <td className="reason">{warn.reason}</td>
                                    <td>
                                        {warn.actor
                                            ? <MemberLink id={warn.actor.id} name={warn.actor.displayName} onOpen={onOpenMember} />
                                            : <span className="muted">бот</span>}
                                        <span className="source"> · {SOURCE_LABELS[warn.source] || warn.source}</span>
                                    </td>
                                    <td className="numeric nowrap">{formatDateTime(warn.createdAt)}</td>
                                    <td className="numeric nowrap">{formatDateTime(warn.expiresAt)}</td>
                                    <td><button className="btn" onClick={() => remove(warn)}>Снять</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

const ENDPOINTS = { active: 'active', bans: 'bans', warnings: 'warnings' };

export default function ModerationView({ guildId, revision, onOpenMember, toast }) {
    const [tab, setTab] = useState(readTab);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const [banById, setBanById] = useState(false);

    useEffect(() => {
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* per-viewer convenience only */ }
    }, [tab]);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/moderation/${ENDPOINTS[tab]}`)
            .then(result => { if (!cancelled) { setData({ tab, ...result }); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, tab, revision, reload]);

    const onChanged = () => setReload(n => n + 1);
    const ready = data?.tab === tab;
    const props = { data, guildId, onOpenMember, onChanged, toast };

    return (
        <section className="view">
            <div className="view-head">
                <h1>Модерация</h1>
                <div className="tabs" role="tablist">
                    {TABS.map(item => (
                        <button key={item.id} role="tab" aria-selected={tab === item.id}
                            className={`tab ${tab === item.id ? 'is-active' : ''}`} onClick={() => setTab(item.id)}>
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>
            {error && <p className="error">{error}</p>}
            {!ready && !error && <p className="muted">Загружаем…</p>}
            {ready && tab === 'active' && <ActiveTab {...props} />}
            {ready && tab === 'bans' && <BansTab {...props} onBanById={() => setBanById(true)} />}
            {ready && tab === 'warnings' && <WarningsTab {...props} />}
            {banById && (
                <PunishDialog guildId={guildId} kind="ban" target={null}
                    onClose={() => setBanById(false)} onDone={onChanged} toast={toast} />
            )}
        </section>
    );
}
