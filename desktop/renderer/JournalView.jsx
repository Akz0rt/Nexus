import React, { useEffect, useMemo, useState } from 'react';
import { apiGet, describeError } from './api.js';
import { ACTION_LABELS, GENDER_LABELS, SOURCE_LABELS, formatDateTime, toCsv } from './format.js';
import { MemberLink } from './Avatar.jsx';

const EMPTY_FILTERS = { action: '', source: '', actorId: '', targetId: '', since: '', until: '' };
const EXPORT_PAGE = 200;
const EXPORT_MAX_PAGES = 25; // up to 5000 rows

function buildQuery(filters, cursor, limit) {
    const params = new URLSearchParams();
    for (const key of ['action', 'source', 'actorId', 'targetId']) if (filters[key]) params.set(key, filters[key]);
    // Date inputs are local days: from 00:00 of "since" to the end of "until"
    if (filters.since) params.set('since', new Date(`${filters.since}T00:00:00`).toISOString());
    if (filters.until) params.set('until', new Date(`${filters.until}T23:59:59.999`).toISOString());
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const text = params.toString();
    return text ? `?${text}` : '';
}

/** Does a live entry belong under the current filters? */
function matches(entry, filters) {
    if (filters.action && entry.action !== filters.action) return false;
    if (filters.source && entry.source !== filters.source) return false;
    if (filters.actorId && entry.actorId !== filters.actorId) return false;
    if (filters.targetId && !(entry.targetIds || []).includes(filters.targetId)) return false;
    if (filters.since && entry.createdAt < new Date(`${filters.since}T00:00:00`).toISOString()) return false;
    if (filters.until && entry.createdAt > new Date(`${filters.until}T23:59:59.999`).toISOString()) return false;
    return true;
}

function describeAction(entry) {
    const label = ACTION_LABELS[entry.action] || entry.action;
    const gender = GENDER_LABELS[entry.details?.gender];
    return gender ? `${label} · ${gender}` : label;
}

export default function JournalView({ guildId, liveEvents, onOpenMember, toast }) {
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [items, setItems] = useState([]);
    const [users, setUsers] = useState({});
    const [cursor, setCursor] = useState(null);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState(null);

    const load = async nextCursor => {
        setLoading(true);
        try {
            const page = await apiGet(`/guilds/${guildId}/audit${buildQuery(filters, nextCursor)}`);
            setItems(list => (nextCursor ? [...list, ...page.items] : page.items));
            setUsers(map => ({ ...map, ...page.users }));
            setCursor(page.cursor);
            setError(null);
        } catch (err) {
            setError(describeError(err));
        }
        setLoading(false);
    };

    useEffect(() => { load(null); }, [guildId, filters]);

    // Live entries on top, only those matching the filters and not loaded yet
    const rows = useMemo(() => {
        const known = new Set(items.map(item => item.id));
        return [...liveEvents.filter(entry => !known.has(entry.id) && matches(entry, filters)), ...items];
    }, [items, liveEvents, filters]);

    const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));
    const nameOf = id => users[id]?.displayName || null;
    const filtered = Object.values(filters).some(Boolean);

    const exportCsv = async () => {
        setExporting(true);
        try {
            const all = [];
            const names = { ...users };
            let next = null;
            for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
                const data = await apiGet(`/guilds/${guildId}/audit${buildQuery(filters, next, EXPORT_PAGE)}`);
                all.push(...data.items);
                Object.assign(names, data.users);
                next = data.cursor;
                if (!next) break;
            }
            const label = id => (id ? `${names[id]?.displayName || ''} (${id})`.trim() : 'бот');
            const csv = toCsv([
                ['Время', 'Кто', 'Действие', 'Над кем', 'Причина', 'Источник'],
                ...all.map(entry => [
                    formatDateTime(entry.createdAt, true),
                    entry.actorId ? label(entry.actorId) : (entry.actorTag || 'бот'),
                    describeAction(entry),
                    (entry.targetIds || []).map(label).join(', '),
                    entry.reason || '',
                    SOURCE_LABELS[entry.source] || entry.source
                ])
            ]);
            const stamp = new Date().toISOString().slice(0, 10);
            const result = await window.panel.saveCsv(`журнал-${stamp}.csv`, csv);
            if (result.saved) toast(`Сохранено строк: ${all.length}${next ? ' (достигнут предел 5000)' : ''}`);
        } catch (err) {
            toast(`Не удалось выгрузить: ${describeError(err)}`, { tone: 'error' });
        }
        setExporting(false);
    };

    return (
        <section className="view">
            <div className="view-head">
                <h1>Журнал действий</h1>
                <button className="btn" onClick={exportCsv} disabled={exporting}>
                    {exporting ? 'Выгружаем…' : 'Выгрузить в CSV'}
                </button>
            </div>

            <div className="toolbar filters">
                <select value={filters.action} onChange={e => setFilter('action', e.target.value)} aria-label="Действие">
                    <option value="">Все действия</option>
                    {Object.entries(ACTION_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <select value={filters.source} onChange={e => setFilter('source', e.target.value)} aria-label="Источник">
                    <option value="">Любой источник</option>
                    {Object.entries(SOURCE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <label className="field-inline">С <input type="date" value={filters.since} onChange={e => setFilter('since', e.target.value)} /></label>
                <label className="field-inline">по <input type="date" value={filters.until} onChange={e => setFilter('until', e.target.value)} /></label>
                {filters.actorId && (
                    <button className="chip" onClick={() => setFilter('actorId', '')} title="Убрать фильтр">
                        Модератор: {nameOf(filters.actorId) || filters.actorId} ×
                    </button>
                )}
                {filters.targetId && (
                    <button className="chip" onClick={() => setFilter('targetId', '')} title="Убрать фильтр">
                        Участник: {nameOf(filters.targetId) || filters.targetId} ×
                    </button>
                )}
                {filtered && <button className="btn btn-quiet" onClick={() => setFilters(EMPTY_FILTERS)}>Сбросить</button>}
            </div>
            <p className="muted small">Клик по имени открывает карточку, ⏷ рядом с именем оставляет только записи этого человека. Записи хранятся 30 дней.</p>

            {error && <p className="error">{error}</p>}
            <div className="table-wrap">
                <table className="journal">
                    <thead>
                        <tr><th>Время</th><th>Кто</th><th>Действие</th><th>Над кем</th><th>Причина</th><th>Источник</th></tr>
                    </thead>
                    <tbody>
                        {rows.map(entry => (
                            <tr key={entry.id}>
                                <td className="numeric nowrap">{formatDateTime(entry.createdAt, true)}</td>
                                <td>
                                    {entry.actorId ? (
                                        <span className="who">
                                            <MemberLink id={entry.actorId} name={nameOf(entry.actorId)} onOpen={onOpenMember} />
                                            <button className="filter-by" title="Только его действия" onClick={() => setFilter('actorId', entry.actorId)}>⏷</button>
                                        </span>
                                    ) : <span className="muted">{entry.actorTag || 'бот'}</span>}
                                </td>
                                <td>{describeAction(entry)}</td>
                                <td>
                                    {(entry.targetIds || []).map(id => (
                                        <span className="who" key={id}>
                                            <MemberLink id={id} name={nameOf(id)} onOpen={onOpenMember} />
                                            <button className="filter-by" title="Только записи о нём" onClick={() => setFilter('targetId', id)}>⏷</button>
                                        </span>
                                    ))}
                                </td>
                                <td className="reason">{entry.reason || ''}</td>
                                <td><span className={`source source-${entry.source}`}>{SOURCE_LABELS[entry.source] || entry.source}</span></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {!loading && rows.length === 0 && (
                <div className="empty">
                    <h2>{filtered ? 'Под эти фильтры записей нет' : 'Записей пока нет'}</h2>
                    {filtered && <p>Попробуйте сбросить фильтры или расширить период.</p>}
                </div>
            )}
            {loading && <p className="muted">Загружаем…</p>}
            {cursor && !loading && <button className="btn" onClick={() => load(cursor)}>Показать ещё</button>}
        </section>
    );
}
