import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS, accountAge, describeAction, formatTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';

const BLOCKS = {
    tiles: 'Плитки',
    queue: 'Очередь на пропуск',
    voice: 'Голосовые',
    journal: 'Журнал',
    birthdays: 'Ближайшие дни рождения'
};
const DEFAULT_LAYOUT = Object.keys(BLOCKS).map(id => ({ id, hidden: false }));
const LAYOUT_KEY = 'panel.overview.layout';
const UNDO_TOAST_MS = 10000;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Per computer: which blocks this moderator wants and in what order
function readLayout() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (!Array.isArray(saved)) return DEFAULT_LAYOUT;
        const known = saved.filter(block => BLOCKS[block.id]);
        const missing = DEFAULT_LAYOUT.filter(block => !known.some(k => k.id === block.id));
        return [...known, ...missing];
    } catch {
        return DEFAULT_LAYOUT;
    }
}

function saveLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* per-machine convenience only */ }
}

function Tile({ label, value, note, onClick, tone }) {
    return (
        <button className={`tile-stat ${tone ? `tile-stat-${tone}` : ''}`} onClick={onClick}>
            <span className="tile-stat-value numeric">{value ?? '—'}</span>
            <span className="tile-stat-label">{label}</span>
            {note && <span className="tile-stat-note">{note}</span>}
        </button>
    );
}

function Block({ id, title, more, editing, index, count, hidden, onMove, onToggle, children }) {
    return (
        <section className={`block block-${id} ${hidden ? 'is-hidden' : ''} ${editing ? 'is-editing' : ''}`} aria-label={title}>
            <div className="block-head">
                <h2>{title}</h2>
                {editing ? (
                    <div className="block-edit">
                        <button className="btn btn-quiet" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Выше">↑</button>
                        <button className="btn btn-quiet" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Ниже">↓</button>
                        <button className="btn btn-quiet" onClick={onToggle}>{hidden ? 'Показать' : 'Скрыть'}</button>
                    </div>
                ) : more}
            </div>
            {!hidden && children}
        </section>
    );
}

export default function OverviewView({ guildId, revision, voiceRevision, waiting, seen, onView, onOpenMember, onChanged, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [layout, setLayout] = useState(readLayout);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState({});

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/overview`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

    // Voice changes come often and in bursts: refresh only the voice block once they settle
    useEffect(() => {
        if (!voiceRevision) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/overview?parts=voice`)
                .then(part => {
                    if (!cancelled) setData(d => (d ? { ...d, voice: part.voice, tiles: { ...d.tiles, inVoice: part.inVoice } } : d));
                })
                .catch(() => {});
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [guildId, voiceRevision]);

    const changeLayout = next => { setLayout(next); saveLayout(next); };
    const move = (index, delta) => {
        const next = [...layout];
        const [block] = next.splice(index, 1);
        next.splice(index + delta, 0, block);
        changeLayout(next);
    };
    const toggle = index => changeLayout(layout.map((block, i) => (i === index ? { ...block, hidden: !block.hidden } : block)));

    const approve = async (item, gender) => {
        const id = item.member.id;
        setBusy(b => ({ ...b, [id]: true }));
        const result = await apiPost(`/guilds/${guildId}/queue/${id}/approve`, { gender });
        setBusy(b => ({ ...b, [id]: false }));
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); onChanged(); return; }
        seen.markSeen([id]);
        onChanged();
        const name = item.member.displayName;
        toast(`Пропущен ${name} · ${GENDER_LABELS[gender]}`, {
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
    };

    const tiles = data?.tiles;
    const waitingCount = waiting?.items?.length ?? tiles?.waiting;
    const nameOf = id => data?.users?.[id]?.displayName || null;

    const render = {
        tiles: () => (
            <div className="tile-stats">
                <Tile label="Ждут пропуска" value={waitingCount} onClick={() => onView('queue')}
                    note={seen.newCount > 0 ? `новых ${seen.newCount}` : null} tone={seen.newCount > 0 ? 'hot' : null} />
                <Tile label="Пропущено сегодня" value={tiles?.approvedToday} onClick={() => onView('queue')} />
                <Tile label="В голосовых" value={tiles?.inVoice} onClick={() => onView('voice')} />
                <Tile label="Активные муты" value={tiles?.activeMutes} onClick={() => onView('moderation')} />
            </div>
        ),
        queue: () => {
            if (data && data.queue === null) return <p className="muted">Пропуск не настроен на этом сервере.</p>;
            if (data && data.queue.length === 0) return <p className="muted">Очередь пуста.</p>;
            return (
                <ul className="mini-queue">
                    {(data?.queue || []).map(item => (
                        <li key={item.member.id}>
                            <Avatar src={item.member.avatarURL} name={item.member.displayName} size={32} />
                            <div className="mini-queue-info">
                                <span>
                                    <MemberLink id={item.member.id} name={item.member.displayName} onOpen={onOpenMember} />
                                    {seen.isNew(item.member.id) && <span className="new-mark">новый</span>}
                                </span>
                                <span className="muted small">
                                    зашёл {timeAgo(item.member.joinedAt)} · аккаунту {accountAge(item.member.accountCreatedAt)}
                                    {item.member.flags.length > 0 && <span className="flag-inline"> · {item.member.flags.length} флаг.</span>}
                                </span>
                            </div>
                            <button className="btn" disabled={busy[item.member.id]} onClick={() => approve(item, 'male')}>Парень</button>
                            <button className="btn" disabled={busy[item.member.id]} onClick={() => approve(item, 'female')}>Девушка</button>
                        </li>
                    ))}
                </ul>
            );
        },
        voice: () => (data?.voice?.length === 0
            ? <p className="muted">В голосовых никого.</p>
            : (
                <ul className="mini-voice">
                    {(data?.voice || []).map(channel => (
                        <li key={channel.id}>
                            <button className="mini-voice-channel" onClick={() => onView('voice')}>
                                <span className="mini-voice-name">{channel.name}</span>
                                <span className="muted small">{channel.category} · {channel.members.length}</span>
                            </button>
                            <div className="mini-voice-people">
                                {channel.members.slice(0, 12).map(member => (
                                    <button key={member.id} className="avatar-button" title={member.displayName} onClick={() => onOpenMember(member.id)}>
                                        <Avatar src={member.avatarURL} name={member.displayName} size={26} />
                                        {(member.serverMute || member.serverDeaf) && <span className="avatar-dot" aria-label="выключен сервером" />}
                                    </button>
                                ))}
                                {channel.members.length > 12 && <span className="muted small">+{channel.members.length - 12}</span>}
                            </div>
                        </li>
                    ))}
                </ul>
            )),
        journal: () => (data?.journal?.length === 0
            ? <p className="muted">Записей пока нет.</p>
            : (
                <ol className="mini-journal">
                    {(data?.journal || []).map(entry => (
                        <li key={entry.id}>
                            <span className="numeric muted small">{formatTime(entry.createdAt)}</span>
                            <span>{describeAction(entry)}</span>
                            <span className="muted small">
                                {(entry.targetIds || []).slice(0, 2).map(id => (
                                    <MemberLink key={id} id={id} name={nameOf(id)} onOpen={onOpenMember} />
                                ))}
                                {entry.actorId && <> · <MemberLink id={entry.actorId} name={nameOf(entry.actorId)} onOpen={onOpenMember} /></>}
                            </span>
                        </li>
                    ))}
                </ol>
            )),
        birthdays: () => (data?.birthdays?.length === 0
            ? <p className="muted">В ближайшую неделю дней рождения нет.</p>
            : (
                <ul className="mini-birthdays">
                    {(data?.birthdays || []).map(item => (
                        <li key={item.id} className={item.inDays === 0 ? 'is-today' : ''}>
                            <Avatar src={item.avatarURL} name={item.displayName} size={26} />
                            <MemberLink id={item.id} name={item.displayName} onOpen={onOpenMember} />
                            <span className="muted small">
                                {item.day} {MONTHS[item.month - 1]} · {item.inDays === 0 ? 'сегодня' : item.inDays === 1 ? 'завтра' : `через ${item.inDays} дн.`}
                            </span>
                        </li>
                    ))}
                </ul>
            ))
    };

    const more = {
        queue: <button className="btn btn-quiet" onClick={() => onView('queue')}>Все →</button>,
        voice: <button className="btn btn-quiet" onClick={() => onView('voice')}>Доска →</button>,
        journal: <button className="btn btn-quiet" onClick={() => onView('journal')}>Все →</button>
    };

    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Обзор</h1>
                <button className={`btn ${editing ? 'btn-primary' : ''}`} onClick={() => setEditing(e => !e)}>{editing ? 'Готово' : 'Настроить'}</button>
                {editing && <button className="btn btn-quiet" onClick={() => changeLayout(DEFAULT_LAYOUT)}>Как было</button>}
            </div>
            {editing && <p className="muted small">Стрелками поменяйте порядок блоков, «Скрыть» уберёт ненужные. Сохраняется на этом компьютере.</p>}
            {error && <p className="error">{error}</p>}
            {!data && !error && <p className="muted">Загружаем…</p>}
            {data && (
                <div className="overview">
                    {layout.map((block, index) => (editing || !block.hidden) && (
                        <Block key={block.id} id={block.id} title={BLOCKS[block.id]} more={more[block.id]} editing={editing}
                            index={index} count={layout.length} hidden={block.hidden}
                            onMove={delta => move(index, delta)} onToggle={() => toggle(index)}>
                            {render[block.id]()}
                        </Block>
                    ))}
                </div>
            )}
        </section>
    );
}
