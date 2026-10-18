import React, { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut, describeError } from './api.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';

const TABS = [
    { id: 'upcoming', label: 'Ближайшие' },
    { id: 'all', label: 'Все' },
    { id: 'calendar', label: 'Календарь' }
];
const RANGES = [{ days: 0, label: 'Сегодня' }, { days: 7, label: '7 дней' }, { days: 30, label: '30 дней' }];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const ERRORS = {
    invalid_date: 'Такой даты нет.',
    member_not_found: 'Этого человека нет на сервере.',
    birthday_not_found: 'Дня рождения уже нет.',
    not_today: 'Поздравить сейчас можно только того, у кого день рождения сегодня.',
    already_congratulated: 'Уже поздравлен (или пропущен) в этом году.',
    no_channel: 'Канал поздравлений не настроен — его выбирают в старой веб-панели.'
};
const errorText = result => ERRORS[result.error] || describeError(result);

function whenText(item) {
    if (item.inDays === 0) return 'сегодня';
    if (item.inDays === 1) return 'завтра';
    return `через ${item.inDays} дн.`;
}

/** Add someone's birthday (pick a member) or change one. */
function BirthdayDialog({ guildId, item, onClose, toast }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [member, setMember] = useState(item ? item.user : null);
    const [month, setMonth] = useState(item?.month || 1);
    const [day, setDay] = useState(item?.day || 1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        const q = query.trim();
        if (item || q.length < 2) { setResults([]); return undefined; }
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/members/search?q=${encodeURIComponent(q)}`)
                .then(data => { if (!cancelled) setResults(data.items.slice(0, 8)); })
                .catch(() => {});
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query, guildId, item]);

    useEffect(() => { if (day > DAYS_IN_MONTH[month - 1]) setDay(DAYS_IN_MONTH[month - 1]); }, [month, day]);

    const submit = async () => {
        if (!member) { setError('Выберите участника.'); return; }
        setBusy(true);
        const result = await apiPut(`/guilds/${guildId}/birthdays/${member.id}`, { month, day });
        setBusy(false);
        if (!result.ok) { setError(errorText(result)); return; }
        toast(`День рождения ${member.displayName || ''}: ${day} ${MONTHS[month - 1]}`);
        onClose();
    };

    return (
        <Dialog title={item ? `День рождения: ${item.user.displayName}` : 'Добавить день рождения'} onClose={onClose} onSubmit={submit}
            submitLabel="Сохранить" busy={busy}>
            {!item && (
                member ? (
                    <div className="picked">
                        <Avatar src={member.avatarURL} name={member.displayName} size={28} />
                        <strong>{member.displayName}</strong>
                        <button type="button" className="btn btn-quiet" onClick={() => setMember(null)}>Другой</button>
                    </div>
                ) : (
                    <>
                        <input type="search" autoFocus placeholder="Ник, ID или @упоминание" value={query} onChange={e => setQuery(e.target.value)} />
                        <ul className="preset-pick">
                            {results.map(m => (
                                <li key={m.id}>
                                    <button type="button" className="picker-item" onClick={() => setMember(m)}>
                                        <span>{m.displayName}</span><span className="muted small">@{m.username}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )
            )}
            <div className="settings-grid">
                <label className="field">
                    День
                    <select value={day} onChange={e => setDay(Number(e.target.value))}>
                        {Array.from({ length: DAYS_IN_MONTH[month - 1] }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                </label>
                <label className="field">
                    Месяц
                    <select value={month} onChange={e => setMonth(Number(e.target.value))}>
                        {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                    </select>
                </label>
            </div>
            <p className="muted small">Год не нужен: бот поздравляет каждый год и возраст не показывает.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

function Row({ item, guildId, onOpenMember, onEdit, onDelete, toast, onChanged, showActions = true }) {
    const [busy, setBusy] = useState(false);
    const act = async (action, done) => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/birthdays/${item.user.id}/${action}`);
        setBusy(false);
        if (!result.ok) { toast(errorText(result), { tone: 'error' }); return; }
        toast(done);
        onChanged();
    };
    return (
        <li className={`birthday-row ${item.inDays === 0 ? 'is-today' : ''}`}>
            <Avatar src={item.user.avatarURL} name={item.user.displayName} size={32} />
            <div className="birthday-who">
                <MemberLink id={item.user.id} name={item.user.displayName} onOpen={onOpenMember} />
                <span className="muted small">{item.day} {MONTHS[item.month - 1]} · {whenText(item)}{item.done ? ' · поздравлен' : ''}</span>
            </div>
            {showActions && (
                <div className="birthday-actions">
                    {item.inDays === 0 && !item.done && <button className="btn btn-primary" disabled={busy} onClick={() => act('congratulate', `Поздравление для ${item.user.displayName} отправлено`)}>Поздравить сейчас</button>}
                    {!item.done && <button className="btn btn-quiet" disabled={busy} onClick={() => act('skip', 'В этом году бот его не поздравит')}>Пропустить в этом году</button>}
                    <button className="btn btn-quiet" onClick={() => onEdit(item)}>Изменить</button>
                    <button className="btn btn-quiet" onClick={() => onDelete(item)}>Удалить</button>
                </div>
            )}
        </li>
    );
}

function Calendar({ items, today, onOpenMember }) {
    const [offset, setOffset] = useState(0);
    const [year, month] = useMemo(() => {
        const [y, m] = today.split('-').map(Number);
        const date = new Date(y, m - 1 + offset, 1);
        return [date.getFullYear(), date.getMonth()];
    }, [today, offset]);
    const days = new Date(year, month + 1, 0).getDate();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Monday first
    const byDay = new Map();
    for (const item of items) {
        if (item.month !== month + 1) continue;
        // 29 February shows on the 28th in other years
        const day = Math.min(item.day, days);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(item);
    }
    const todayParts = today.split('-').map(Number);
    return (
        <div className="calendar">
            <div className="calendar-head">
                <button className="btn btn-quiet" onClick={() => setOffset(o => o - 1)} aria-label="Предыдущий месяц">←</button>
                <h2>{MONTH_NAMES[month]} {year}</h2>
                <button className="btn btn-quiet" onClick={() => setOffset(o => o + 1)} aria-label="Следующий месяц">→</button>
                {offset !== 0 && <button className="btn btn-quiet" onClick={() => setOffset(0)}>Сегодня</button>}
            </div>
            <div className="calendar-grid">
                {WEEKDAYS.map(d => <div key={d} className="calendar-weekday muted small">{d}</div>)}
                {Array.from({ length: lead }, (_, i) => <div key={`lead${i}`} />)}
                {Array.from({ length: days }, (_, i) => i + 1).map(day => {
                    const isToday = todayParts[0] === year && todayParts[1] === month + 1 && todayParts[2] === day;
                    const people = byDay.get(day) || [];
                    return (
                        <div key={day} className={`calendar-day ${isToday ? 'is-today' : ''} ${people.length ? 'has-people' : ''}`}>
                            <span className="calendar-date numeric">{day}</span>
                            <div className="calendar-people">
                                {people.slice(0, 4).map(item => (
                                    <button key={item.user.id} className="avatar-button" title={item.user.displayName} onClick={() => onOpenMember(item.user.id)}>
                                        <Avatar src={item.user.avatarURL} name={item.user.displayName} size={22} />
                                    </button>
                                ))}
                                {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default function BirthdaysView({ guildId, revision, onOpenMember, toast }) {
    const [tab, setTab] = useState('upcoming');
    const [range, setRange] = useState(7);
    const [query, setQuery] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const [dialog, setDialog] = useState(null); // { item|null }
    const [removing, setRemoving] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/birthdays`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision, reload]);

    const onChanged = () => setReload(n => n + 1);
    const remove = async () => {
        const result = await apiDelete(`/guilds/${guildId}/birthdays/${removing.user.id}`);
        toast(result.ok ? 'День рождения удалён' : errorText(result), result.ok ? {} : { tone: 'error' });
        setRemoving(null);
        onChanged();
    };

    const items = data?.items || [];
    const upcoming = items.filter(item => item.inDays <= range);
    const needle = query.trim().toLowerCase();
    const all = [...items]
        .filter(item => !needle || String(item.user.displayName || '').toLowerCase().includes(needle))
        .sort((a, b) => a.month - b.month || a.day - b.day);
    const rowProps = { guildId, onOpenMember, onEdit: item => setDialog({ item }), onDelete: setRemoving, toast, onChanged };

    return (
        <section className="view">
            <div className="view-head">
                <h1>Дни рождения</h1>
                <div className="tabs" role="tablist">
                    {TABS.map(t => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
                    ))}
                </div>
                <button className="btn btn-primary" onClick={() => setDialog({ item: null })}>Добавить</button>
            </div>
            {data && (
                <p className="muted small">
                    Бот поздравляет каждый день в {data.settings.checkTime} ({data.settings.timezone})
                    {data.settings.congratsChannel ? ` в #${data.settings.congratsChannel}` : ', но канал поздравлений не выбран'}.
                    Время и каналы меняются в старой веб-панели. Участники сами указывают день рождения командой /birthday-set.
                </p>
            )}
            {error && <p className="error">{error}</p>}
            {!data && !error && <p className="muted">Загружаем…</p>}

            {data && tab === 'upcoming' && (
                <>
                    <div className="segmented" role="group" aria-label="Период">
                        {RANGES.map(r => (
                            <button key={r.days} className={`tab ${range === r.days ? 'is-active' : ''}`} aria-pressed={range === r.days} onClick={() => setRange(r.days)}>{r.label}</button>
                        ))}
                    </div>
                    {upcoming.length === 0 && <div className="empty"><h2>{range === 0 ? 'Сегодня дней рождения нет' : 'В этот период дней рождения нет'}</h2></div>}
                    <ul className="birthday-list">{upcoming.map(item => <Row key={item.user.id} item={item} {...rowProps} />)}</ul>
                </>
            )}
            {data && tab === 'all' && (
                <>
                    <div className="toolbar">
                        <input type="search" placeholder="Найти по нику" value={query} onChange={e => setQuery(e.target.value)} />
                        <span className="muted small hint">Всего: {items.length}</span>
                    </div>
                    <ul className="birthday-list">{all.map(item => <Row key={item.user.id} item={item} {...rowProps} />)}</ul>
                </>
            )}
            {data && tab === 'calendar' && <Calendar items={items} today={data.today} onOpenMember={onOpenMember} />}

            {dialog && <BirthdayDialog guildId={guildId} item={dialog.item} onClose={() => { setDialog(null); onChanged(); }} toast={toast} />}
            {removing && (
                <Dialog title={`Удалить день рождения ${removing.user.displayName}?`} onClose={() => setRemoving(null)} onSubmit={remove} submitLabel="Удалить" submitTone="danger">
                    <p className="muted">Бот перестанет его поздравлять. Участник может снова указать дату командой /birthday-set.</p>
                </Dialog>
            )}
        </section>
    );
}
