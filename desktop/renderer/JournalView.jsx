import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';
import { ACTION_GROUPS, ACTION_LABELS, SOURCE_LABELS, UNDO_LABELS, describeAction, describeMessage, formatDateTime, journalTone, journalWhat, timeAgo, toCsv } from './format.js';
import { MemberLink } from './Avatar.jsx';
import Icon from './icons.jsx';
import Dialog from './Dialog.jsx';

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
    if (filters.action) {
        const group = filters.action.endsWith('.*') ? filters.action.slice(0, -1) : null;
        if (group ? !entry.action.startsWith(group) : entry.action !== filters.action) return false;
    }
    if (filters.source && entry.source !== filters.source) return false;
    if (filters.actorId && entry.actorId !== filters.actorId) return false;
    if (filters.targetId && !(entry.targetIds || []).includes(filters.targetId)) return false;
    if (filters.since && entry.createdAt < new Date(`${filters.since}T00:00:00`).toISOString()) return false;
    if (filters.until && entry.createdAt > new Date(`${filters.until}T23:59:59.999`).toISOString()) return false;
    return true;
}

/** Message entries have no actor when nobody knows who deleted it (Discord doesn't always say). */
function actorText(entry) {
    if (entry.actorTag) return entry.actorTag;
    return entry.action.startsWith('message.') ? 'неизвестно' : 'бот';
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const localDay = iso => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** «Сегодня», «Вчера», «17 октября» */
function dayTitle(iso) {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (localDay(iso) === localDay(today)) return 'Сегодня';
    if (localDay(iso) === localDay(yesterday)) return 'Вчера';
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Rows grouped by local day, newest first: [{ key, title, entries }] */
function byDay(rows) {
    const groups = [];
    for (const entry of rows) {
        const key = localDay(entry.createdAt);
        if (groups.at(-1)?.key !== key) groups.push({ key, title: dayTitle(entry.createdAt), entries: [] });
        groups.at(-1).entries.push(entry);
    }
    return groups;
}

const TARGETS_SHOWN = 3;

/** Reason column: the reason, or the message text for the message log. */
function reasonText(entry) {
    return entry.action.startsWith('message.') ? describeMessage(entry) : (entry.reason || '');
}

function presetFilters(preset) {
    if (!preset) return EMPTY_FILTERS;
    const { nonce, ...rest } = preset;
    return { ...EMPTY_FILTERS, ...rest };
}

export default function JournalView({ guildId, liveEvents, preset, onOpenMember, toast }) {
    const [filters, setFilters] = useState(() => presetFilters(preset));
    // Opened from another screen with filters (e.g. a moderator from the stats)
    const appliedPreset = useRef(preset?.nonce);
    useEffect(() => {
        if (!preset || preset.nonce === appliedPreset.current) return;
        appliedPreset.current = preset.nonce;
        setFilters(presetFilters(preset));
    }, [preset]);
    const [items, setItems] = useState([]);
    const [users, setUsers] = useState({});
    const [cursor, setCursor] = useState(null);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(null);        // entry id with its details shown
    const [undoing, setUndoing] = useState(null);  // entry waiting for confirmation
    const [busy, setBusy] = useState(false);
    const [undone, setUndone] = useState({});      // entry id -> undone here just now

    const load = async nextCursor => {
        setLoading(true);
        try {
            const page = await apiGet(`/guilds/${guildId}/audit${buildQuery(filters, nextCursor)}`);
            setItems(list => (nextCursor ? [...list, ...page.items] : page.items));
            setUsers(map => ({ ...map, ...page.users }));
            setCursor(page.cursor);
            setError(null);
        } catch (err) {
            setError(err);
        }
        setLoading(false);
    };

    useEffect(() => { load(null); }, [guildId, filters]);

    // Live entries on top, only those matching the filters and not loaded yet
    const rows = useMemo(() => {
        const known = new Set(items.map(item => item.id));
        // Newest first: the days below are cut from this order
        return [...liveEvents.filter(entry => !known.has(entry.id) && matches(entry, filters)), ...items]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }, [items, liveEvents, filters]);

    const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));
    const nameOf = id => users[id]?.displayName || null;
    const filtered = Object.values(filters).some(Boolean);
    const groups = useMemo(() => byDay(rows), [rows]);
    const namesOf = entry => (entry.targetIds || []).map(id => nameOf(id) || id);

    const undo = async entry => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/audit/${entry.id}/undo`);
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        setUndoing(null);
        const failed = result.data.failed || [];
        if (failed.length === 0) setUndone(map => ({ ...map, [entry.id]: true }));
        toast(failed.length ? `${UNDO_LABELS[entry.action]}: не вышло у ${failed.length}` : `Готово: ${UNDO_LABELS[entry.action].toLowerCase()}`,
            failed.length ? { tone: 'error' } : {});
    };

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
                    entry.actorId ? label(entry.actorId) : actorText(entry),
                    describeAction(entry),
                    (entry.targetIds || []).map(label).join(', '),
                    reasonText(entry),
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
                    {Object.entries(ACTION_GROUPS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
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
            <p className="muted small">Клик по строке раскрывает подробности и «Отменить». Удалённые и изменённые сообщения видны только из каналов, которые вы можете читать. Записи хранятся 30 дней.</p>

            {error && <ErrorState what="журнал" error={error} onRetry={() => load(null)} />}
            {groups.map(group => (
                <section key={group.key} className="journal-day" aria-label={group.title}>
                    <h2>{group.title}</h2>
                    <ol className="journal-list">
                        {group.entries.map(entry => {
                            const isOpen = open === entry.id;
                            const targets = entry.targetIds || [];
                            const wasUndone = entry.undoneAt || undone[entry.id];
                            const canUndo = UNDO_LABELS[entry.action] && targets.length > 0 && !wasUndone;
                            const extra = reasonText(entry);
                            return (
                                <li key={entry.id} className={`journal-row ${isOpen ? 'is-open' : ''}`}>
                                    <div className="journal-line" onClick={event => { if (!event.target.closest('button')) setOpen(isOpen ? null : entry.id); }}>
                                        <span className={`journal-dot tone-${journalTone(entry.action)}`} aria-hidden="true" />
                                        <span className="journal-text">
                                            {entry.actorId
                                                ? <MemberLink id={entry.actorId} name={nameOf(entry.actorId) || entry.actorTag} onOpen={onOpenMember} />
                                                : <strong className="muted">{actorText(entry)}</strong>}
                                            <span className="journal-arrow" aria-label="→">→</span>
                                            {targets.length === 0 && <strong>сервер</strong>}
                                            {targets.slice(0, TARGETS_SHOWN).map((id, i) => (
                                                <React.Fragment key={id}>
                                                    {i > 0 && ', '}
                                                    <MemberLink id={id} name={nameOf(id)} onOpen={onOpenMember} />
                                                </React.Fragment>
                                            ))}
                                            {targets.length > TARGETS_SHOWN && <span className="muted"> и ещё {targets.length - TARGETS_SHOWN}</span>}
                                            <span className="journal-what"> · {journalWhat(entry)}</span>
                                            {wasUndone && <span className="journal-undone">отменено</span>}
                                        </span>
                                        <time className="muted small numeric" dateTime={entry.createdAt} title={formatDateTime(entry.createdAt, true)}>{timeAgo(entry.createdAt)}</time>
                                        <button type="button" className="journal-toggle" aria-expanded={isOpen} aria-label={isOpen ? 'Скрыть подробности' : 'Подробности'}
                                            onClick={() => setOpen(isOpen ? null : entry.id)}>
                                            <Icon name="chevron" size={14} />
                                        </button>
                                    </div>
                                    {isOpen && (
                                        <div className="journal-details">
                                            <dl>
                                                <div><dt>Когда</dt><dd className="numeric">{formatDateTime(entry.createdAt, true)}</dd></div>
                                                <div><dt>Где</dt><dd>{SOURCE_LABELS[entry.source] || entry.source}</dd></div>
                                                {extra && <div><dt>{entry.action.startsWith('message.') ? 'Текст' : 'Причина'}</dt><dd className={entry.action.startsWith('message.') ? 'message-text' : ''}>{extra}</dd></div>}
                                                {targets.length > TARGETS_SHOWN && <div><dt>Все</dt><dd>{namesOf(entry).join(', ')}</dd></div>}
                                                {wasUndone && <div><dt>Отменил</dt><dd>{entry.undoneByTag || (undone[entry.id] ? 'вы' : '—')}{entry.undoneAt && ` · ${formatDateTime(entry.undoneAt)}`}</dd></div>}
                                            </dl>
                                            <div className="journal-details-actions">
                                                {entry.actorId && <button type="button" className="btn btn-small" onClick={() => setFilter('actorId', entry.actorId)}>Только этот модератор</button>}
                                                {targets.length === 1 && <button type="button" className="btn btn-small" onClick={() => setFilter('targetId', targets[0])}>Только этот участник</button>}
                                                <span className="toolbar-spacer" />
                                                {canUndo && <button type="button" className="btn btn-small btn-primary" onClick={() => setUndoing(entry)}>{UNDO_LABELS[entry.action]}…</button>}
                                            </div>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </section>
            ))}
            {!loading && rows.length === 0 && !error && (
                <EmptyState icon="journal" title={filtered ? 'Под эти фильтры записей нет' : 'Записей пока нет'}
                    text={filtered ? 'Попробуйте сбросить фильтры или расширить период.' : null} />
            )}
            {loading && <Skeleton rows={6} height={40} />}
            {undoing && (
                <Dialog title={`${UNDO_LABELS[undoing.action]}?`} onClose={() => setUndoing(null)} onSubmit={() => undo(undoing)}
                    submitLabel={UNDO_LABELS[undoing.action]} busy={busy}>
                    <p>{namesOf(undoing).slice(0, 10).join(', ')}{undoing.targetIds.length > 10 ? ` и ещё ${undoing.targetIds.length - 10}` : ''} · {journalWhat(undoing)}</p>
                    <p className="muted small">
                        {undoing.action === 'verification.approved' && 'Бот снимет роль парня или девушки и доп. роли, выданные при пропуске, вернёт @АНверефи — человек снова окажется в очереди. '}
                        {undoing.action === 'booster.passed' && 'Бот снимет роль «Бустер-аккаунт» и срок — аккаунт снова окажется в очереди. '}
                        В журнал попадёт, что это отменили вы.
                    </p>
                </Dialog>
            )}
            {cursor && !loading && <button className="btn" onClick={() => load(cursor)}>Показать ещё</button>}
        </section>
    );
}
