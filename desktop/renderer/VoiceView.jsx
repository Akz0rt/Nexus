import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { describeBulk, formatDateTime, formatSince } from './format.js';
import Avatar from './Avatar.jsx';
import ChannelPicker from './ChannelPicker.jsx';
import SplitDialog from './SplitDialog.jsx';
import SquadsPanel from './SquadsPanel.jsx';
import PunishDialog from './PunishDialog.jsx';
import { ChannelEditDialog, GatherDialog, SquadDialog } from './VoiceDialogs.jsx';
import { RoleDialog } from './RoleDialogs.jsx';

const FILTERS_KEY = 'panel.voice.filters';
const DRAG_TYPE = 'application/x-nexus-users';
const BULK_VERBS = {
    mute: 'Микро выключен',
    unmute: 'Микро включён',
    deafen: 'Звук выключен',
    undeafen: 'Звук включён',
    disconnect: 'Отключено'
};

function readFilters() {
    try {
        return { hideEmpty: false, category: '', ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}'), query: '' };
    } catch {
        return { hideEmpty: false, category: '', query: '' };
    }
}

/** Re-render every 30 s so "12 мин в канале" stays current. */
function useTicker() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick(n => n + 1), 30 * 1000);
        return () => clearInterval(timer);
    }, []);
}

const Icon = ({ children, className = '', label }) => (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}>
        <title>{label}</title>
        {children}
    </svg>
);
const MicOff = props => (
    <Icon {...props}><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6" /><path d="M19 10v2a7 7 0 0 1-.6 2.8M5 10v2a7 7 0 0 0 12 5" /><path d="M12 19v3M3 3l18 18" /></Icon>
);
const SoundOff = props => (
    <Icon {...props}><path d="M3 18v-6a9 9 0 0 1 14.5-7.1M21 12v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" /><path d="M3 3l18 18" /></Icon>
);
const Camera = props => (
    <Icon {...props}><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3z" /></Icon>
);
const Lock = props => (
    <Icon {...props}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>
);

function tileTooltip(tile) {
    const lines = [`Роли: ${tile.topRoles.map(role => role.name).join(', ') || 'нет'}`];
    if (tile.serverMute) lines.push('Микрофон выключен сервером');
    if (tile.serverDeaf) lines.push('Звук выключен сервером');
    if (tile.mutedUntil) lines.push(`Мут до ${formatDateTime(tile.mutedUntil)}`);
    lines.push('Двойной клик — карточка');
    return lines.join('\n');
}

function Tile({ tile, channel, selected, match, canDrag, onClick, onOpen, onDragStart }) {
    return (
        <li
            data-tile={tile.id}
            className={`tile ${selected ? 'is-selected' : ''} ${match ? 'is-match' : ''}`}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            title={tileTooltip(tile)}
            draggable={canDrag}
            onClick={event => onClick(event, tile, channel)}
            onDoubleClick={() => onOpen(tile.id)}
            onKeyDown={event => {
                if (event.key === 'Enter') onOpen(tile.id);
                if (event.key === ' ') { event.preventDefault(); onClick({ ctrlKey: true }, tile, channel); }
            }}
            onDragStart={event => onDragStart(event, tile)}
        >
            <Avatar src={tile.avatarURL} name={tile.displayName} size={28} />
            <span className="tile-name">
                {tile.displayName}
                {tile.moderator && <span className="mod-mark" title="Модератор" />}
                {tile.bot && <span className="tile-flag tile-flag-bot">бот</span>}
                {tile.mutedUntil && <span className="tile-flag">мут</span>}
            </span>
            <span className="tile-icons">
                {tile.streaming && <span className="live">LIVE</span>}
                {tile.video && <Camera label="Камера" />}
                {(tile.serverMute || tile.selfMute) && (
                    <MicOff className={tile.serverMute ? 'is-server' : ''} label={tile.serverMute ? 'Микрофон выключен сервером' : 'Сам выключил микрофон'} />
                )}
                {(tile.serverDeaf || tile.selfDeaf) && (
                    <SoundOff className={tile.serverDeaf ? 'is-server' : ''} label={tile.serverDeaf ? 'Звук выключен сервером' : 'Сам выключил звук'} />
                )}
            </span>
            <span className="tile-time muted small numeric">{formatSince(tile.since)}</span>
        </li>
    );
}

function ChannelMenu({ channel, can, hasSplit, selectedHere, onAction, onClose }) {
    const ref = useRef(null);
    useEffect(() => {
        // The ⋯ buttons toggle menus themselves
        const onDown = event => { if (!ref.current?.contains(event.target) && !event.target.closest('.channel-more')) onClose(); };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [onClose]);

    const people = channel.members.length;
    const items = [
        { id: 'select', label: 'Выбрать всех', enabled: people > 0 },
        { id: 'gather', label: 'Собрать сюда…', enabled: can.move },
        { id: 'moveAll', label: 'Перенести всех в…', enabled: can.move && people > 0 },
        { id: 'muteAll', label: selectedHere > 0 ? 'Замутить всех, кроме меня и выделенных' : 'Замутить всех, кроме меня', enabled: can.mute && people > 0 },
        { id: 'unmuteAll', label: 'Размутить всех', enabled: can.mute && channel.members.some(m => m.serverMute) },
        { id: 'split', label: 'Разбить на команды…', enabled: can.move && people >= 2 },
        hasSplit && { id: 'gatherBack', label: 'Собрать обратно', enabled: can.move },
        { id: 'lock', label: channel.locked ? 'Открыть для всех' : 'Закрыть для всех', enabled: can.channels && can.roles },
        { id: 'edit', label: 'Лимит и название…', enabled: can.channels }
    ].filter(Boolean);

    return (
        <ul className="channel-menu" ref={ref} role="menu">
            {items.map(item => (
                <li key={item.id}>
                    <button type="button" role="menuitem" disabled={!item.enabled} onClick={() => { onClose(); onAction(item.id); }}>
                        {item.label}
                    </button>
                </li>
            ))}
        </ul>
    );
}

export default function VoiceView({ guildId, myId, revision, voiceRevision, onOpenMember, toast }) {
    const [board, setBoard] = useState(null);
    const [error, setError] = useState(null);
    const [squads, setSquads] = useState(null);
    const [reloadSquads, setReloadSquads] = useState(0);
    const [selected, setSelected] = useState(() => new Set());
    const [anchor, setAnchor] = useState(null); // { userId, channelId } of the last click
    const [filters, setFilters] = useState(readFilters);
    const [menu, setMenu] = useState(null); // channel id
    const [dialog, setDialog] = useState(null);
    const [lastSplit, setLastSplit] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const [marquee, setMarquee] = useState(null);
    const boardRef = useRef(null);
    const ghostRef = useRef(null);
    const loaded = useRef(false);
    useTicker();

    // Board: Discord voice states, refetched (debounced) on every live change
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/voice`)
                .then(data => { if (!cancelled) { setBoard(data); setError(null); loaded.current = true; } })
                .catch(err => { if (!cancelled) setError(describeError(err)); });
        }, loaded.current ? 250 : 0);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [guildId, revision, voiceRevision]);

    useEffect(() => { loaded.current = false; setBoard(null); setSelected(new Set()); setLastSplit(null); }, [guildId]);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/voice/squads`)
            .then(data => { if (!cancelled) setSquads(data.items); })
            .catch(() => { if (!cancelled) setSquads([]); });
        return () => { cancelled = true; };
    }, [guildId, revision, reloadSquads]);

    useEffect(() => {
        try {
            localStorage.setItem(FILTERS_KEY, JSON.stringify({ hideEmpty: filters.hideEmpty, category: filters.category }));
        } catch { /* per-viewer convenience only */ }
    }, [filters.hideEmpty, filters.category]);

    const can = board?.can || {};
    const categories = board?.categories || [];

    /** userId -> { tile, channel } for everyone in voice */
    const where = useMemo(() => {
        const map = new Map();
        for (const category of categories) {
            for (const channel of category.channels) {
                for (const tile of channel.members) map.set(tile.id, { tile, channel });
            }
        }
        return map;
    }, [categories]);

    // People who left voice drop out of the selection
    useEffect(() => {
        setSelected(prev => {
            const next = new Set([...prev].filter(id => where.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [where]);

    const shown = useMemo(() => categories
        .filter(category => !filters.category || (category.id || 'none') === filters.category)
        .map(category => ({
            ...category,
            channels: filters.hideEmpty ? category.channels.filter(channel => channel.members.length > 0) : category.channels
        }))
        .filter(category => category.channels.length > 0), [categories, filters.category, filters.hideEmpty]);

    const needle = filters.query.trim().toLowerCase();
    const selectedTiles = [...selected].map(id => where.get(id)?.tile).filter(Boolean);
    const selectedIds = selectedTiles.map(tile => tile.id);

    // --- selection ------------------------------------------------------------------

    const clickTile = useCallback((event, tile, channel) => {
        if (event.detail > 1) return; // the second click of a double click opens the card
        if (event.shiftKey && anchor?.channelId === channel.id) {
            const ids = channel.members.map(m => m.id);
            const [from, to] = [ids.indexOf(anchor.userId), ids.indexOf(tile.id)].sort((a, b) => a - b);
            const range = ids.slice(from, to + 1);
            setSelected(prev => new Set([...(event.ctrlKey ? prev : []), ...range]));
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            setSelected(prev => {
                const next = new Set(prev);
                if (next.has(tile.id)) next.delete(tile.id); else next.add(tile.id);
                return next;
            });
        } else {
            setSelected(prev => (prev.size === 1 && prev.has(tile.id) ? new Set() : new Set([tile.id])));
        }
        setAnchor({ userId: tile.id, channelId: channel.id });
    }, [anchor]);

    const selectChannel = channel => {
        setSelected(new Set(channel.members.map(m => m.id)));
        setAnchor({ userId: channel.members[0]?.id, channelId: channel.id });
    };

    useEffect(() => {
        const onKey = event => {
            if (dialog || event.target.closest?.('input, select, textarea')) return;
            if (event.key === 'Escape') { setSelected(new Set()); setMenu(null); }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                const channel = anchor && where.get(anchor.userId)?.channel;
                const inChannel = channel ? channel.members.map(m => m.id) : [];
                const all = shown.flatMap(category => category.channels.flatMap(c => c.members.map(m => m.id)));
                const channelDone = inChannel.length > 0 && inChannel.every(id => selected.has(id));
                setSelected(new Set(inChannel.length > 0 && !channelDone ? inChannel : all));
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dialog, anchor, where, shown, selected]);

    // Rubber band: drag on empty board space selects every tile it touches (Shift adds)
    const startMarquee = event => {
        if (event.button !== 0 || event.target.closest('[data-tile], button, input, select, label, .channel-menu')) return;
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
            const hits = [...boardRef.current.querySelectorAll('[data-tile]')].filter(el => {
                const r = el.getBoundingClientRect();
                return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
            }).map(el => el.dataset.tile);
            setSelected(new Set([...base, ...hits]));
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setMarquee(null);
            if (!moved && !event.shiftKey) setSelected(new Set()); // click on empty space
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    // --- actions --------------------------------------------------------------------

    const report = (result, verb, { undo, retry } = {}) => {
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return null; }
        const data = result.data;
        const actions = [];
        if (undo && data.moves?.length) actions.push({ label: 'Отменить', onClick: () => undoMoves(data.moves) });
        if (retry && data.failed.length) actions.push({ label: 'Повторить для неудачных', onClick: () => retry(data.failed.map(f => f.userId)) });
        toast(describeBulk(verb, data), {
            actions,
            ttl: actions.length ? 10000 : 5000,
            tone: data.done.length === 0 ? 'error' : undefined
        });
        return data;
    };

    const undoMoves = async moves => {
        const result = await apiPost(`/guilds/${guildId}/voice/move`, {
            moves: moves.map(move => ({ userId: move.userId, channelId: move.from })),
            kind: 'undo'
        });
        report(result, 'Возвращено');
    };

    const moveTo = async (channelId, userIds) => {
        if (userIds.length === 0) return;
        const result = await apiPost(`/guilds/${guildId}/voice/move`, { userIds, channelId });
        report(result, 'Перемещено', { undo: true, retry: ids => moveTo(channelId, ids) });
    };

    const applyAction = async (action, userIds) => {
        const result = await apiPost(`/guilds/${guildId}/voice/${action}`, { userIds });
        report(result, BULK_VERBS[action], { retry: ids => applyAction(action, ids) });
    };

    const channelAction = async (channel, id) => {
        const base = `/guilds/${guildId}/voice/channels/${channel.id}`;
        if (id === 'select') selectChannel(channel);
        if (id === 'gather') setDialog({ type: 'gather', channel });
        if (id === 'moveAll') setDialog({ type: 'move', userIds: channel.members.map(m => m.id), excludeIds: [channel.id], title: `Перенести всех из «${channel.name}» в…` });
        if (id === 'split') setDialog({ type: 'split', channel });
        if (id === 'edit') setDialog({ type: 'edit', channel });
        if (id === 'muteAll' || id === 'unmuteAll') {
            const on = id === 'muteAll';
            const exceptIds = [myId, ...channel.members.filter(m => selected.has(m.id)).map(m => m.id)];
            report(await apiPost(`${base}/mute-all`, { on, exceptIds }), on ? 'Микро выключен' : 'Микро включён');
        }
        if (id === 'gatherBack') {
            const result = await apiPost(`/guilds/${guildId}/voice/gather`, { channelId: channel.id, fromChannelIds: lastSplit.targetChannelIds });
            if (report(result, 'Собрано', { undo: true })) setLastSplit(null);
        }
        if (id === 'lock') {
            const result = await apiPost(`${base}/lock`, { locked: !channel.locked });
            if (!result.ok) toast(describeError(result), { tone: 'error' });
            else toast(channel.locked ? `«${channel.name}» открыт для всех` : `«${channel.name}» закрыт: зайти могут только те, кому разрешено отдельно`);
        }
    };

    const onDragStart = (event, tile) => {
        const ids = selected.has(tile.id) ? selectedIds : [tile.id];
        if (!selected.has(tile.id)) setSelected(new Set([tile.id]));
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
        event.dataTransfer.effectAllowed = 'move';
        if (ghostRef.current) {
            ghostRef.current.textContent = ids.length === 1 ? tile.displayName : `${ids.length} чел.`;
            event.dataTransfer.setDragImage(ghostRef.current, 12, 12);
        }
    };

    const dropProps = channel => ({
        onDragOver: event => {
            if (!can.move || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (dropTarget !== channel.id) setDropTarget(channel.id);
        },
        onDragLeave: event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(current => (current === channel.id ? null : current));
        },
        onDrop: event => {
            setDropTarget(null);
            const raw = event.dataTransfer.getData(DRAG_TYPE);
            if (!raw) return;
            event.preventDefault();
            const ids = JSON.parse(raw).filter(id => where.get(id)?.channel.id !== channel.id);
            moveTo(channel.id, ids);
        }
    });

    // --- render ---------------------------------------------------------------------

    if (error && !board) return <div className="view"><h1>Голосовые</h1><p className="error">{error}</p></div>;
    if (!board) return <div className="view"><h1>Голосовые</h1><p className="muted">Загружаем доску…</p></div>;

    const inVoiceCount = where.size;
    const allMuted = selectedTiles.length > 0 && selectedTiles.every(tile => tile.serverMute);
    const allDeaf = selectedTiles.length > 0 && selectedTiles.every(tile => tile.serverDeaf);
    const splitSource = lastSplit && categories.flatMap(c => c.channels).find(c => c.id === lastSplit.sourceChannelId);

    return (
        <div className="view view-wide">
            <div className="view-head">
                <h1>Голосовые</h1>
                <span className="muted numeric">в голосе {inVoiceCount}</span>
            </div>
            <div className="toolbar">
                <input type="search" value={filters.query} onChange={e => setFilters(f => ({ ...f, query: e.target.value }))}
                    placeholder="Найти по нику" aria-label="Найти на доске" />
                <select value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))} aria-label="Категория">
                    <option value="">Все категории</option>
                    {categories.map(category => <option key={category.id || 'none'} value={category.id || 'none'}>{category.name}</option>)}
                </select>
                <label className="check">
                    <input type="checkbox" checked={filters.hideEmpty} onChange={e => setFilters(f => ({ ...f, hideEmpty: e.target.checked }))} />
                    Скрыть пустые
                </label>
                <span className="hint muted small">Рамка мышью — выделить · <kbd>Ctrl</kbd>+<kbd>A</kbd> — весь канал · перетащите на канал, чтобы перенести</span>
            </div>

            {splitSource && (
                <div className="split-banner">
                    <span>Команды разосланы из «{splitSource.name}».</span>
                    <button className="btn" disabled={!can.move} onClick={() => channelAction(splitSource, 'gatherBack')}>Собрать обратно</button>
                    <button className="btn btn-quiet" onClick={() => setLastSplit(null)}>Скрыть</button>
                </div>
            )}

            <div className="voice-layout">
                <div className="board" ref={boardRef} onMouseDown={startMarquee}>
                    {shown.length === 0 && (
                        <div className="empty"><h2>Каналов не видно</h2><p>Снимите фильтры или проверьте, что у бота есть доступ к голосовым каналам.</p></div>
                    )}
                    {shown.map(category => (
                        <section key={category.id || 'none'} className="category">
                            <h3>{category.name}</h3>
                            <div className="channels">
                                {category.channels.map(channel => {
                                    const selectedHere = channel.members.filter(m => selected.has(m.id)).length;
                                    return (
                                        <article key={channel.id} {...dropProps(channel)}
                                            className={`channel ${dropTarget === channel.id ? 'is-drop' : ''} ${channel.id === board.myChannelId ? 'is-mine' : ''}`}>
                                            <header className="channel-head">
                                                <span className="channel-name">
                                                    {channel.locked && <Lock label="Закрыт для всех" />}
                                                    {channel.name}
                                                    {channel.stage && <span className="muted small"> · сцена</span>}
                                                </span>
                                                <span className="muted small numeric">
                                                    {channel.members.length}{channel.userLimit ? `/${channel.userLimit}` : ''}
                                                </span>
                                                <button type="button" className="btn btn-quiet channel-more" aria-label={`Меню канала ${channel.name}`}
                                                    aria-expanded={menu === channel.id} onClick={() => setMenu(m => (m === channel.id ? null : channel.id))}>⋯</button>
                                                {menu === channel.id && (
                                                    <ChannelMenu channel={channel} can={can} selectedHere={selectedHere}
                                                        hasSplit={lastSplit?.sourceChannelId === channel.id}
                                                        onAction={id => channelAction(channel, id)} onClose={() => setMenu(null)} />
                                                )}
                                            </header>
                                            {channel.members.length === 0
                                                ? <p className="channel-empty muted small">пусто</p>
                                                : (
                                                    <ul className="tiles" role="listbox" aria-multiselectable="true" aria-label={channel.name}>
                                                        {channel.members.map(tile => (
                                                            <Tile key={tile.id} tile={tile} channel={channel}
                                                                selected={selected.has(tile.id)}
                                                                match={Boolean(needle) && tile.displayName.toLowerCase().includes(needle)}
                                                                canDrag={Boolean(can.move)}
                                                                onClick={clickTile} onOpen={onOpenMember} onDragStart={onDragStart} />
                                                        ))}
                                                    </ul>
                                                )}
                                        </article>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>

                <SquadsPanel
                    guildId={guildId}
                    squads={squads}
                    inVoice={where}
                    canManage={Boolean(can.move)}
                    onSelect={ids => setSelected(new Set(ids))}
                    onGather={squad => setDialog({ type: 'squadGather', squad })}
                    onEdit={squad => setDialog({ type: 'squad', squad })}
                    onChanged={() => setReloadSquads(n => n + 1)}
                    toast={toast}
                />
            </div>

            {selectedTiles.length > 0 && (
                <div className="action-bar" role="toolbar" aria-label="Действия с выделенными">
                    <strong className="numeric">Выбрано: {selectedTiles.length}</strong>
                    <button className="btn btn-primary" disabled={!can.move} onClick={() => setDialog({ type: 'move', userIds: selectedIds })}>Переместить в…</button>
                    <button className="btn" disabled={!can.mute} onClick={() => applyAction(allMuted ? 'unmute' : 'mute', selectedIds)}>
                        {allMuted ? 'Включить микро' : 'Выключить микро'}
                    </button>
                    <button className="btn" disabled={!can.deafen} onClick={() => applyAction(allDeaf ? 'undeafen' : 'deafen', selectedIds)}>
                        {allDeaf ? 'Вернуть звук' : 'Заглушить'}
                    </button>
                    <button className="btn" disabled={!can.move} onClick={() => applyAction('disconnect', selectedIds)}>Отключить</button>
                    <button className="btn" disabled={!can.timeout} onClick={() => setDialog({ type: 'timeout' })}>Тайм-аут…</button>
                    <button className="btn" disabled={!can.roles} onClick={() => setDialog({ type: 'role' })}>Роль…</button>
                    <button className="btn" disabled={!can.move} onClick={() => setDialog({ type: 'squad', squad: null })}>Сохранить как состав</button>
                    {selectedTiles.length === 1 && <button className="btn btn-quiet" onClick={() => onOpenMember(selectedTiles[0].id)}>Карточка</button>}
                    <button className="btn btn-quiet" onClick={() => setSelected(new Set())}>Сбросить <kbd>Esc</kbd></button>
                </div>
            )}

            {marquee && (
                <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} />
            )}
            <div className="drag-ghost" ref={ghostRef} aria-hidden="true" />

            {dialog?.type === 'move' && (
                <ChannelPicker guildId={guildId} categories={categories} title={dialog.title} excludeIds={dialog.excludeIds}
                    onClose={() => setDialog(null)}
                    onPick={channel => { setDialog(null); moveTo(channel.id, dialog.userIds.filter(id => where.get(id)?.channel.id !== channel.id)); }} />
            )}
            {dialog?.type === 'squadGather' && (
                <ChannelPicker guildId={guildId} categories={categories} title={`Собрать «${dialog.squad.name}» в…`}
                    onClose={() => setDialog(null)}
                    onPick={async channel => {
                        setDialog(null);
                        const result = await apiPost(`/guilds/${guildId}/voice/squads/${dialog.squad.id}/gather`, { channelId: channel.id });
                        const data = report(result, 'Собрано', { undo: true });
                        if (data?.invited?.length) toast(`Приглашение в ЛС отправлено: ${data.invited.length} чел. не были в голосе`);
                    }} />
            )}
            {dialog?.type === 'split' && (
                <SplitDialog guildId={guildId} channel={dialog.channel} categories={categories} myId={myId}
                    onClose={() => setDialog(null)}
                    onDone={(data, split) => { setLastSplit(split); report({ ok: true, data }, 'Разослано', { undo: true }); }} />
            )}
            {dialog?.type === 'gather' && (
                <GatherDialog guildId={guildId} channel={dialog.channel} categories={categories}
                    onClose={() => setDialog(null)} onDone={data => report({ ok: true, data }, 'Собрано', { undo: true })} />
            )}
            {dialog?.type === 'edit' && (
                <ChannelEditDialog guildId={guildId} channel={dialog.channel} onClose={() => setDialog(null)} toast={toast} />
            )}
            {dialog?.type === 'role' && (
                <RoleDialog guildId={guildId} userIds={selectedIds} onClose={() => setDialog(null)} toast={toast} />
            )}
            {dialog?.type === 'squad' && (
                <SquadDialog guildId={guildId} squad={dialog.squad} selection={selectedTiles}
                    onClose={() => setDialog(null)} onSaved={() => setReloadSquads(n => n + 1)} toast={toast} />
            )}
            {dialog?.type === 'timeout' && (
                <PunishDialog guildId={guildId} kind="mute"
                    targets={selectedTiles.map(tile => ({ id: tile.id, displayName: tile.displayName }))}
                    onClose={() => setDialog(null)} toast={toast} />
            )}
        </div>
    );
}
