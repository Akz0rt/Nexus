import React, { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';
import { formatDateTime, untilText } from './format.js';
import Avatar from './Avatar.jsx';
import { Chip } from './Chips.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import Dialog from './Dialog.jsx';
import EventDialog from './EventDialog.jsx';
import WeekStrip from './WeekStrip.jsx';

const GROUPS = [
    { id: 'upcoming', label: 'Предстоящие' },
    { id: 'past', label: 'Прошедшие' }
];
const STATUS = { done: 'прошёл', cancelled: 'отменён' };
// Each upcoming event keeps its colour in the week strip and on its card
const TONES = ['amber', 'ink', 'presence', 'ok', 'accent'];
const DAY_MS = 24 * 60 * 60 * 1000;

const timeOf = iso => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** «00:34 · через 3 ч», «идёт · до 23:00», «прошёл» */
function whenLine(event, now = Date.now()) {
    const range = `${timeOf(event.startsAt)}${event.durationMinutes ? `–${timeOf(event.endsAt)}` : ''}`;
    if (event.status === 'cancelled') return `${range} · отменён`;
    if (event.status === 'done') return Date.parse(event.endsAt) > now ? `${range} · идёт, запись закрыта` : `${range} · прошёл`;
    return `${range} · ${untilText(event.startsAt, now) || 'начинается'}`;
}

function EventCard({ guildId, event, tone, cardRef, onOpenMember, onEdit, toast }) {
    const [busy, setBusy] = useState(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const open = event.status === 'scheduled';
    const live = event.status === 'done' && Date.parse(event.endsAt) > Date.now();
    const soon = open && Date.parse(event.startsAt) - Date.now() < DAY_MS;
    const date = new Date(event.startsAt);
    const going = event.going;

    const run = async (action, body) => {
        setBusy(action);
        const result = await apiPost(`/guilds/${guildId}/meetups/${event.id}/${action}`, body);
        setBusy(null);
        if (!result.ok) {
            toast(result.error === 'nobody_going' ? 'Никто ещё не записался.' : describeError(result), { tone: 'error' });
            return;
        }
        if (action === 'squad') toast('Состав сохранён — он в списке составов на доске голосовых');
        if (action === 'cancel') { toast('Ивент отменён'); setConfirmCancel(false); }
    };

    // Why «Собрать в канал» can't run, shown under it
    const gatherProblem = !going.length ? 'Собирать некого — никто не записался'
        : !event.voiceChannel ? 'Не выбран голосовой канал — укажите его в «Изменить»'
            : null;
    const names = going.map(user => user.displayName || 'кто-то');
    const meta = [
        `Карточка в #${event.channel.name || 'удалённом канале'}`,
        event.voiceChannel && `сбор в «${event.voiceChannel.name || 'удалённый канал'}»`,
        event.mentionRole && `упоминание @${event.mentionRole.name || 'удалённой роли'}`,
        open && (event.remindedAt ? 'напоминание отправлено' : 'напомним за 15 мин')
    ].filter(Boolean).join(' · ');

    return (
        <li ref={cardRef} className={`event-card tone-${open || live ? tone : 'muted'} event-${event.status}`}>
            <div className="event-date" aria-hidden="true">
                <span>{date.toLocaleDateString('ru-RU', { weekday: 'short' })}</span>
                <strong>{date.getDate()}</strong>
                <span>{date.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')}</span>
            </div>
            <div className="event-body">
                <div className="event-title">
                    <h2>{event.title}</h2>
                    {event.repeatWeekly && <Chip tone="amber">каждую неделю</Chip>}
                    <span className={`event-when ${soon ? 'is-soon' : ''}`} title={formatDateTime(event.startsAt)}>{whenLine(event)}</span>
                </div>
                {event.description && <p className="event-description">{event.description}</p>}
                <p className="muted small">{meta}</p>
                {going.length === 0
                    ? <p className="event-going muted">Пока никто не записался</p>
                    : (
                        <div className="event-going">
                            <span className="avatar-stack">
                                {going.slice(0, 5).map(user => (
                                    <button key={user.id} type="button" className="avatar-button" title={user.displayName || user.id} onClick={() => onOpenMember(user.id)}>
                                        <Avatar id={user.id} src={user.avatarURL} name={user.displayName} size={26} />
                                    </button>
                                ))}
                            </span>
                            <span title={names.join(', ')}>
                                Идут {going.length}{going.length <= 5 ? `: ${names.join(', ')}` : ''}
                            </span>
                        </div>
                    )}
            </div>
            <div className="event-actions">
                <div className="event-actions-main">
                    <button type="button" className="btn btn-primary" disabled={Boolean(busy) || Boolean(gatherProblem) || event.status === 'cancelled'}
                        onClick={() => run('gather', { background: true })}>
                        {busy === 'gather' ? 'Запускаем…' : 'Собрать в канал'}
                    </button>
                    <OverflowMenu label={`Ещё для «${event.title}»: сделать состав${open ? ', отменить ивент' : ''}`} items={[
                        { label: 'Сделать состав', onSelect: () => run('squad'), disabled: !going.length || Boolean(busy), title: going.length ? undefined : 'Никто не записался' },
                        open && { label: 'Отменить ивент…', onSelect: () => setConfirmCancel(true), end: true, danger: true }
                    ]} />
                </div>
                {open && <button type="button" className="btn" onClick={() => onEdit(event)}>Изменить</button>}
                {gatherProblem && event.status !== 'cancelled' && <span className="event-actions-note">{gatherProblem}</span>}
            </div>
            {confirmCancel && (
                <Dialog title={`Отменить «${event.title}»?`} onClose={() => setConfirmCancel(false)} onSubmit={() => run('cancel')}
                    submitLabel="Отменить ивент" submitTone="danger" busy={busy === 'cancel'}>
                    <p className="muted">Карточка в Discord будет зачёркнута, кнопки записи пропадут. Записавшимся бот ничего не пишет.
                        {event.repeatWeekly && ' Повтор на следующую неделю тоже не создастся.'}</p>
                </Dialog>
            )}
        </li>
    );
}

export default function EventsView({ guildId, revision, eventRevision, onOpenMember, toast }) {
    const [group, setGroup] = useState('upcoming');
    const [data, setData] = useState(null);
    const [counts, setCounts] = useState({});
    const [error, setError] = useState(null);
    const [retry, setRetry] = useState(0);
    const [dialog, setDialog] = useState(null); // { event|null }
    const [flash, setFlash] = useState(null);
    const cards = useRef(new Map());

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/meetups?group=${group}`)
            .then(result => {
                if (cancelled) return;
                setData(result);
                setError(null);
                setCounts(c => ({ ...c, [group]: result.items.length }));
            })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, group, revision, eventRevision, retry]);

    const items = data?.group === group ? data.items : null;
    const tones = new Map((group === 'upcoming' ? items || [] : []).map((event, index) => [event.id, TONES[index % TONES.length]]));
    const weekEnd = Date.now() + 7 * DAY_MS;
    const week = (group === 'upcoming' ? items || [] : [])
        .filter(event => Date.parse(event.startsAt) < weekEnd)
        .map(event => ({ ...event, tone: tones.get(event.id) }));

    const pick = id => {
        const node = cards.current.get(id);
        node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlash(id);
        setTimeout(() => setFlash(f => (f === id ? null : f)), 1200);
    };

    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Ивенты</h1>
                <span className="toolbar-spacer" />
                <div className="tabs" role="tablist">
                    {GROUPS.map(g => (
                        <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={`tab ${group === g.id ? 'is-active' : ''}`} onClick={() => setGroup(g.id)}>
                            {g.label}{g.id === 'upcoming' && counts.upcoming ? ` · ${counts.upcoming}` : ''}
                        </button>
                    ))}
                </div>
                <button type="button" className="btn btn-primary" disabled={!data} onClick={() => setDialog({ event: null })}>+ Новый ивент</button>
            </div>
            {group === 'upcoming' && items && <WeekStrip events={week} onPick={pick} />}
            {error && <ErrorState what="ивенты" error={error} onRetry={() => setRetry(n => n + 1)} />}
            {!items && !error && <Skeleton rows={3} height={120} />}
            {items && items.length === 0 && (
                <EmptyState icon="events" title={group === 'upcoming' ? 'Ближайших ивентов нет' : 'Прошедших ивентов пока нет'}
                    text={group === 'upcoming' ? 'Бот опубликует карточку с кнопками «Иду» и «Не иду», напомнит записавшимся за 15 минут, а из них можно одним нажатием собрать состав в голосовой.' : null}
                    action={group === 'upcoming' ? <button type="button" className="btn btn-primary" onClick={() => setDialog({ event: null })}>+ Новый ивент</button> : null} />
            )}
            <ul className="events">
                {(items || []).map(event => (
                    <EventCard key={event.id} guildId={guildId} event={event} tone={tones.get(event.id) || 'muted'}
                        cardRef={node => { if (node) cards.current.set(event.id, node); else cards.current.delete(event.id); if (node) node.classList.toggle('is-flash', flash === event.id); }}
                        onOpenMember={onOpenMember} onEdit={e => setDialog({ event: e })} toast={toast} />
                ))}
            </ul>
            {dialog && data && (
                <EventDialog guildId={guildId} event={dialog.event} channels={data.channels} roles={data.roles} durations={data.durations}
                    onClose={() => setDialog(null)} toast={toast} />
            )}
        </section>
    );
}
