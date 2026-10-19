import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { ErrorState, EmptyState, Skeleton } from './States.jsx';
import { formatDateTime } from './format.js';
import Avatar from './Avatar.jsx';
import ChannelPicker from './ChannelPicker.jsx';
import SplitDialog from './SplitDialog.jsx';
import SquadsPanel from './SquadsPanel.jsx';
import PunishDialog from './PunishDialog.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import FilterMenu from './FilterMenu.jsx';
import SelectionBar from './SelectionBar.jsx';
import Dialog from './Dialog.jsx';
import { ChannelEditDialog, GatherDialog, SquadDialog } from './VoiceDialogs.jsx';
import { RoleDialog } from './RoleDialogs.jsx';
import useSelection, { marqueeStyle } from './useSelection.js';

const FILTERS_KEY = 'panel.voice.filters';
const DRAG_TYPE = 'application/x-nexus-users';

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

/** «0 мин», «34 мин», «1 ч 08» */
function inChannel(iso) {
    if (!iso) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 60) return `${minutes} мин`;
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')}`;
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

const Svg = ({ children, className = '', label }) => (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}>
        <title>{label}</title>
        {children}
    </svg>
);
const MicOff = props => (
    <Svg {...props}><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6" /><path d="M19 10v2a7 7 0 0 1-.6 2.8M5 10v2a7 7 0 0 0 12 5" /><path d="M12 19v3M3 3l18 18" /></Svg>
);
const SoundOff = props => (
    <Svg {...props}><path d="M3 18v-6a9 9 0 0 1 14.5-7.1M21 12v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" /><path d="M3 3l18 18" /></Svg>
);
const Camera = props => (
    <Svg {...props}><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3z" /></Svg>
);
const Lock = props => (
    <Svg {...props}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>
);

function tileTooltip(tile) {
    const lines = [`Роли: ${tile.topRoles.map(role => role.name).join(', ') || 'нет'}`];
    if (tile.serverMute) lines.push('Микрофон выключен сервером');
    if (tile.serverDeaf) lines.push('Звук выключен сервером');
    if (tile.mutedUntil) lines.push(`Мут до ${formatDateTime(tile.mutedUntil)}`);
    lines.push('Двойной клик — карточка');
    return lines.join('\n');
}

function Tile({ tile, selected, match, canDrag, onClick, onToggle, onOpen, onDragStart }) {
    return (
        <li
            data-select={tile.id}
            className={`tile ${selected ? 'is-selected' : ''} ${match ? 'is-match' : ''}`}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            title={tileTooltip(tile)}
            draggable={canDrag}
            onClick={onClick}
            onDoubleClick={() => onOpen(tile.id)}
            onKeyDown={event => {
                if (event.key === 'Enter') onOpen(tile.id);
                if (event.key === ' ') { event.preventDefault(); onToggle(); }
            }}
            onDragStart={event => onDragStart(event, tile)}
        >
            <Avatar id={tile.id} src={tile.avatarURL} name={tile.displayName} size={24} />
            <span className="tile-name">
                {tile.displayName}
                {tile.bot && <span className="muted"> · бот</span>}
                {tile.moderator && <span className="mod-mark" title="Модератор" />}
                {tile.mutedUntil && <span className="tile-flag">мут</span>}
            </span>
            <span className="tile-icons">
                {tile.streaming && <span className="live">LIVE</span>}
                {tile.video && <Camera label="Камера" />}
                {(tile.serverMute || tile.selfMute) && (
                    <MicOff className={tile.serverMute ? 'is-server' : ''} label={tile.serverMute ? 'Микрофон выключен сервером' : 'Сам выключил микрофон'} />
                )}
                {tile.serverDeaf && <SoundOff className="is-server" label="Звук выключен сервером" />}
                {!tile.serverDeaf && tile.selfDeaf && <SoundOff label="Сам выключил звук" />}
            </span>
            <span className="tile-time muted small numeric">{inChannel(tile.since)}</span>
        </li>
    );
}

export default function VoiceView({ guildId, myId, revision, voiceRevision, onOpenMember, toast }) {
    const [board, setBoard] = useState(null);
    const [error, setError] = useState(null);
    const [retry, setRetry] = useState(0);
    const [squads, setSquads] = useState(null);
    const [reloadSquads, setReloadSquads] = useState(0);
    const [filters, setFilters] = useState(readFilters);
    const [categoryMenu, setCategoryMenu] = useState(false);
    const [dialog, setDialog] = useState(null);
    const [lastSplit, setLastSplit] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const ghostRef = useRef(null);
    const loaded = useRef(false);
    useTicker();

    // Board: Discord voice states, refetched (debounced) on every live change
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/voice`)
                .then(data => { if (!cancelled) { setBoard(data); setError(null); loaded.current = true; } })
                .catch(err => { if (!cancelled) setError(err); });
        }, loaded.current ? 250 : 0);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [guildId, revision, voiceRevision, retry]);

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

    const inCategory = useMemo(() => categories.filter(category => !filters.category || (category.id || 'none') === filters.category), [categories, filters.category]);
    // «Скрыть пустые»: empty channels fold into a row of chips (still drop targets)
    const shown = useMemo(() => inCategory
        .map(category => ({ ...category, channels: filters.hideEmpty ? category.channels.filter(channel => channel.members.length > 0) : category.channels }))
        .filter(category => category.channels.length > 0), [inCategory, filters.hideEmpty]);
    const emptyChannels = filters.hideEmpty ? inCategory.flatMap(category => category.channels.filter(channel => channel.members.length === 0)) : [];

    const order = shown.flatMap(category => category.channels.flatMap(channel => channel.members.map(m => m.id)));
    const dialogOpen = Boolean(dialog);
    // Ctrl+A: first the channel of the last click, a second press — everyone on the board
    const selectAll = current => {
        const channel = selection.anchor && where.get(selection.anchor)?.channel;
        const inThis = channel ? channel.members.map(m => m.id) : [];
        const channelDone = inThis.length > 0 && inThis.every(id => current.has(id));
        return inThis.length > 0 && !channelDone ? inThis : order;
    };
    const selection = useSelection(order, { paused: dialogOpen, selectAll });
    const selectedTiles = selection.chosen.map(id => where.get(id)?.tile).filter(Boolean);
    const selectedIds = selectedTiles.map(tile => tile.id);
    const needle = filters.query.trim().toLowerCase();

    // --- actions: group ones run as background tasks (progress in the tray) -------------

    const startTask = async (path, body) => {
        const result = await apiPost(`/guilds/${guildId}${path}`, { ...body, background: true });
        if (!result.ok) toast(result.error === 'nobody' ? 'Некого трогать: в канале никого нет или всё уже сделано.' : describeError(result), { tone: 'error' });
        return result.ok;
    };

    const moveTo = (channelId, userIds) => (userIds.length ? startTask('/voice/move', { userIds, channelId }) : null);
    const applyAction = (action, userIds) => startTask(`/voice/${action}`, { userIds });

    const disconnect = userIds => {
        if (userIds.length >= 3) setDialog({ type: 'disconnect', userIds });
        else applyAction('disconnect', userIds);
    };

    const channelAction = async (channel, id) => {
        const base = `/voice/channels/${channel.id}`;
        if (id === 'select') selection.setSelected(new Set(channel.members.map(m => m.id)));
        if (id === 'gather') setDialog({ type: 'gather', channel });
        if (id === 'moveAll') setDialog({ type: 'move', userIds: channel.members.map(m => m.id), excludeIds: [channel.id], title: `Перенести всех из «${channel.name}» в…` });
        if (id === 'split') setDialog({ type: 'split', channel });
        if (id === 'edit') setDialog({ type: 'edit', channel });
        if (id === 'muteAll' || id === 'unmuteAll') {
            const on = id === 'muteAll';
            const exceptIds = [myId, ...channel.members.filter(m => selection.selected.has(m.id)).map(m => m.id)];
            await startTask(`${base}/mute-all`, { on, exceptIds });
        }
        if (id === 'gatherBack') {
            if (await startTask('/voice/gather', { channelId: channel.id, fromChannelIds: lastSplit.targetChannelIds })) setLastSplit(null);
        }
        if (id === 'lock') {
            const result = await apiPost(`/guilds/${guildId}${base}/lock`, { locked: !channel.locked });
            if (!result.ok) toast(describeError(result), { tone: 'error' });
            else toast(channel.locked ? `«${channel.name}» открыт для всех` : `«${channel.name}» закрыт: зайти могут только те, кому разрешено отдельно`);
        }
    };

    const channelMenu = channel => {
        const people = channel.members.length;
        const selectedHere = channel.members.filter(m => selection.selected.has(m.id)).length;
        const item = (id, label, enabled) => ({ label, onSelect: () => channelAction(channel, id), disabled: !enabled });
        return [
            item('select', 'Выбрать всех', people > 0),
            item('gather', 'Собрать сюда…', can.move),
            item('moveAll', 'Перенести всех в…', can.move && people > 0),
            item('muteAll', selectedHere > 0 ? 'Замутить всех, кроме меня и выделенных' : 'Замутить всех, кроме меня', can.mute && people > 0),
            item('unmuteAll', 'Размутить всех', can.mute && channel.members.some(m => m.serverMute)),
            item('split', 'Разбить на команды…', can.move && people >= 2),
            lastSplit?.sourceChannelId === channel.id && item('gatherBack', 'Собрать обратно', can.move),
            item('lock', channel.locked ? 'Открыть для всех' : 'Закрыть для всех', can.channels && can.roles),
            item('edit', 'Лимит и название…', can.channels)
        ].filter(Boolean);
    };

    // --- drag and drop -------------------------------------------------------------------

    const onDragStart = (event, tile) => {
        const ids = selection.selected.has(tile.id) ? selectedIds : [tile.id];
        if (!selection.selected.has(tile.id)) selection.setSelected(new Set([tile.id]));
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
            moveTo(channel.id, JSON.parse(raw).filter(id => where.get(id)?.channel.id !== channel.id));
        }
    });

    // --- render ----------------------------------------------------------------------------

    if (error && !board) return <div className="view"><h1>Голосовые</h1><ErrorState what="голосовые" error={error} onRetry={() => setRetry(n => n + 1)} /></div>;
    if (!board) return <div className="view"><h1>Голосовые</h1><Skeleton rows={4} height={120} /></div>;

    const busyChannels = categories.flatMap(c => c.channels).filter(c => c.members.length > 0).length;
    const allMuted = selectedTiles.length > 0 && selectedTiles.every(tile => tile.serverMute);
    const allDeaf = selectedTiles.length > 0 && selectedTiles.every(tile => tile.serverDeaf);
    const splitSource = lastSplit && categories.flatMap(c => c.channels).find(c => c.id === lastSplit.sourceChannelId);
    const categoryLabel = filters.category ? categories.find(c => (c.id || 'none') === filters.category)?.name || 'Категория' : 'Категория';

    return (
        <div className="view view-wide voice-view">
            <div className="view-head">
                <h1>Голосовые <span className="view-sub numeric">{where.size} в голосе · {busyChannels} {plural(busyChannels, 'канал', 'канала', 'каналов')}</span></h1>
                <input type="search" className="voice-search" value={filters.query} onChange={e => setFilters(f => ({ ...f, query: e.target.value }))}
                    placeholder="Найти по нику" aria-label="Найти на доске" />
                <FilterMenu label={categoryLabel} active={Boolean(filters.category)} open={categoryMenu}
                    onToggle={() => setCategoryMenu(o => !o)} onClose={() => setCategoryMenu(false)}>
                    <button type="button" role="menuitemradio" aria-checked={!filters.category} className="menu-entry"
                        onClick={() => { setFilters(f => ({ ...f, category: '' })); setCategoryMenu(false); }}>Все категории</button>
                    {categories.map(category => (
                        <button key={category.id || 'none'} type="button" role="menuitemradio" aria-checked={filters.category === (category.id || 'none')} className="menu-entry"
                            onClick={() => { setFilters(f => ({ ...f, category: category.id || 'none' })); setCategoryMenu(false); }}>{category.name}</button>
                    ))}
                </FilterMenu>
                <button type="button" className="filter-chip" aria-pressed={filters.hideEmpty} onClick={() => setFilters(f => ({ ...f, hideEmpty: !f.hideEmpty }))}>Скрыть пустые</button>
            </div>
            <div className="voice-legend">
                <span><MicOff label="Выключил сам" /> выключил сам</span>
                <span><MicOff className="is-server" label="Выключен сервером" /> выключен сервером</span>
                <span><SoundOff className="is-server" label="Заглушён сервером" /> заглушён сервером</span>
                <span><span className="live">LIVE</span> стримит</span>
                <span className="voice-hint">Клик — выбрать · рамка — группа · Shift — добавить · перетащите на канал</span>
            </div>

            {splitSource && (
                <div className="split-banner">
                    <span>Команды разосланы из «{splitSource.name}».</span>
                    <button className="btn" disabled={!can.move} onClick={() => channelAction(splitSource, 'gatherBack')}>Собрать обратно</button>
                    <button className="btn btn-quiet" onClick={() => setLastSplit(null)}>Скрыть</button>
                </div>
            )}

            <div className="voice-layout">
                <div className="board" ref={selection.listRef} onMouseDown={selection.startMarquee}>
                    {shown.length === 0 && emptyChannels.length === 0 && (
                        <EmptyState icon="voice" title="Каналов не видно" text="Снимите фильтры или проверьте, что у бота есть доступ к голосовым каналам." />
                    )}
                    {shown.length === 0 && emptyChannels.length > 0 && <EmptyState icon="voice" title="В голосе никого" />}
                    {shown.map(category => (
                        <section key={category.id || 'none'} className="category">
                            <h3>{category.name}</h3>
                            <div className="channels">
                                {category.channels.map(channel => {
                                    const full = channel.userLimit > 0 && channel.members.length >= channel.userLimit;
                                    return (
                                        <article key={channel.id} {...dropProps(channel)}
                                            className={`channel ${dropTarget === channel.id ? 'is-drop' : ''} ${channel.id === board.myChannelId ? 'is-mine' : ''}`}>
                                            <header className="channel-head">
                                                <span className="channel-name">
                                                    {channel.locked && <Lock label="Закрыт для всех" />}
                                                    {channel.name}
                                                    {channel.stage && <span className="muted small"> · сцена</span>}
                                                </span>
                                                <span className={`small numeric ${full ? 'is-full' : 'muted'}`} title={full ? 'Канал заполнен' : undefined}>
                                                    {channel.userLimit ? `${channel.members.length} / ${channel.userLimit}` : channel.members.length}
                                                </span>
                                                <OverflowMenu items={channelMenu(channel)} label={`Меню канала ${channel.name}`} />
                                            </header>
                                            {channel.members.length === 0
                                                ? <p className="channel-empty muted small">пусто — можно перетащить сюда</p>
                                                : (
                                                    <ul className="tiles" role="listbox" aria-multiselectable="true" aria-label={channel.name}>
                                                        {channel.members.map(tile => (
                                                            <Tile key={tile.id} tile={tile}
                                                                selected={selection.selected.has(tile.id)}
                                                                match={Boolean(needle) && tile.displayName.toLowerCase().includes(needle)}
                                                                canDrag={Boolean(can.move)}
                                                                onClick={event => selection.click(event, tile.id)}
                                                                onToggle={() => selection.toggle(tile.id)}
                                                                onOpen={onOpenMember} onDragStart={onDragStart} />
                                                        ))}
                                                    </ul>
                                                )}
                                        </article>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                    {emptyChannels.length > 0 && (
                        <div className="empty-channels">
                            <span className="muted">Пустые:</span>
                            {emptyChannels.map(channel => (
                                <span key={channel.id} {...dropProps(channel)} className={`empty-chip ${dropTarget === channel.id ? 'is-drop' : ''}`}>
                                    {channel.locked && <Lock label="Закрыт для всех" />}{channel.name}
                                </span>
                            ))}
                            <span className="muted small">— на них тоже можно перетаскивать</span>
                        </div>
                    )}
                </div>

                <SquadsPanel
                    guildId={guildId}
                    squads={squads}
                    inVoice={where}
                    canManage={Boolean(can.move)}
                    onNew={() => setDialog({ type: 'squad', squad: null })}
                    onSelect={ids => selection.setSelected(new Set(ids))}
                    onGather={squad => setDialog({ type: 'squadGather', squad })}
                    onEdit={squad => setDialog({ type: 'squad', squad })}
                    onChanged={() => setReloadSquads(n => n + 1)}
                    toast={toast}
                />
            </div>

            <SelectionBar floating escHint names={selectedTiles.map(tile => tile.displayName)} onClear={selection.clear}>
                <button className="btn btn-primary" disabled={!can.move} onClick={() => setDialog({ type: 'move', userIds: selectedIds })}>Переместить в…</button>
                <button className="btn" disabled={!can.mute} onClick={() => applyAction(allMuted ? 'unmute' : 'mute', selectedIds)}>
                    {allMuted ? 'Вкл. микро' : 'Выкл. микро'}
                </button>
                <button className="btn" disabled={!can.deafen} onClick={() => applyAction(allDeaf ? 'undeafen' : 'deafen', selectedIds)}>
                    {allDeaf ? 'Вернуть звук' : 'Заглушить'}
                </button>
                <button className="btn" disabled={!can.timeout} onClick={() => setDialog({ type: 'timeout' })}>Тайм-аут…</button>
                <button className="btn btn-danger" disabled={!can.move} onClick={() => disconnect(selectedIds)}>Отключить</button>
                <button className="btn" disabled={!can.move} onClick={() => setDialog({ type: 'squad', squad: null })}>В состав</button>
                <OverflowMenu label="Ещё: роль, карточка" items={[
                    { label: 'Роль…', onSelect: () => setDialog({ type: 'role' }), disabled: !can.roles },
                    selectedTiles.length === 1 && { label: 'Открыть карточку', onSelect: () => onOpenMember(selectedTiles[0].id) }
                ]} />
            </SelectionBar>

            {selection.marquee && <div className="marquee" style={marqueeStyle(selection.marquee)} />}
            <div className="drag-ghost" ref={ghostRef} aria-hidden="true" />

            {dialog?.type === 'move' && (
                <ChannelPicker guildId={guildId} categories={categories} title={dialog.title} excludeIds={dialog.excludeIds}
                    onClose={() => setDialog(null)}
                    onPick={channel => { setDialog(null); moveTo(channel.id, dialog.userIds.filter(id => where.get(id)?.channel.id !== channel.id)); }} />
            )}
            {dialog?.type === 'squadGather' && (
                <ChannelPicker guildId={guildId} categories={categories} title={`Собрать «${dialog.squad.name}» в…`}
                    onClose={() => setDialog(null)}
                    onPick={channel => { setDialog(null); startTask(`/voice/squads/${dialog.squad.id}/gather`, { channelId: channel.id }); }} />
            )}
            {dialog?.type === 'split' && (
                <SplitDialog guildId={guildId} channel={dialog.channel} categories={categories} myId={myId}
                    onClose={() => setDialog(null)}
                    onDone={(data, split) => setLastSplit(split)} />
            )}
            {dialog?.type === 'gather' && (
                <GatherDialog guildId={guildId} channel={dialog.channel} categories={categories}
                    onClose={() => setDialog(null)} onDone={() => {}} />
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
            {dialog?.type === 'disconnect' && (
                <Dialog title={`Отключить ${dialog.userIds.length} от голоса?`} submitLabel="Отключить" submitTone="danger"
                    onClose={() => setDialog(null)}
                    onSubmit={() => { const ids = dialog.userIds; setDialog(null); applyAction('disconnect', ids); }}>
                    <p className="muted small">{dialog.userIds.map(id => where.get(id)?.tile.displayName || id).slice(0, 10).join(', ')}</p>
                    <p className="muted small">Вернуть их в канал одной кнопкой не получится — зайти обратно они смогут сами.</p>
                </Dialog>
            )}
        </div>
    );
}
