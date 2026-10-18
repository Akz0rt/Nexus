import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { describeBulk } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';
import EventDialog from './EventDialog.jsx';

const GROUPS = [
    { id: 'upcoming', label: 'Предстоящие' },
    { id: 'past', label: 'Прошедшие и отменённые' }
];
const STATUS = { scheduled: 'запись открыта', done: 'прошёл', cancelled: 'отменён' };

function formatWhen(iso) {
    return new Date(iso).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function untilText(iso) {
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (minutes < 0) return '';
    if (minutes < 60) return `через ${minutes} мин`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `через ${hours} ч`;
    return `через ${Math.round(hours / 24)} дн.`;
}

function EventCard({ guildId, event, channels, onOpenMember, onEdit, toast }) {
    const [busy, setBusy] = useState(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const open = event.status === 'scheduled';

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
        if (action === 'gather') {
            const data = result.data;
            const invited = data.invited?.length ? ` · приглашения в ЛС: ${data.invited.length}` : '';
            toast(`${describeBulk('Перемещено', data)}${invited}`, data.failed.length ? { tone: 'error', ttl: 8000 } : {});
        }
    };

    return (
        <li className={`event-card event-${event.status}`}>
            <div className="event-when">
                <strong>{formatWhen(event.startsAt)}</strong>
                <span className="muted small">{open ? untilText(event.startsAt) : STATUS[event.status]}</span>
            </div>
            <div className="event-body">
                <h2>{event.title} {event.repeatWeekly && <span className="tile-flag" title="Повторяется каждую неделю">каждую неделю</span>}</h2>
                {event.description && <p className="muted">{event.description}</p>}
                <p className="muted small">
                    Карточка в #{event.channel.name || 'удалённом канале'}
                    {event.voiceChannel && <> · сбор в «{event.voiceChannel.name || 'удалённый канал'}»</>}
                    {event.remindedAt && open && <> · напоминание отправлено</>}
                </p>
                <div className="event-going">
                    <span className="muted small">Идут · {event.going.length}</span>
                    <div className="mini-voice-people">
                        {event.going.slice(0, 24).map(user => (
                            <button key={user.id} className="avatar-button" title={user.displayName || user.id} onClick={() => onOpenMember(user.id)}>
                                <Avatar src={user.avatarURL} name={user.displayName} size={26} />
                            </button>
                        ))}
                        {event.going.length > 24 && <span className="muted small">+{event.going.length - 24}</span>}
                        {event.going.length === 0 && <span className="muted small">пока никого</span>}
                    </div>
                </div>
            </div>
            <div className="event-actions">
                {open && <button className="btn" onClick={() => onEdit(event)}>Изменить</button>}
                <button className="btn" disabled={busy || !event.going.length} onClick={() => run('squad')}>Сделать состав</button>
                <button className="btn" disabled={busy || !event.going.length || !event.voiceChannel}
                    title={event.voiceChannel ? '' : 'У ивента не выбран голосовой канал'} onClick={() => run('gather')}>
                    {busy === 'gather' ? 'Собираем…' : 'Собрать в канал'}
                </button>
                {open && <button className="btn btn-danger" onClick={() => setConfirmCancel(true)}>Отменить</button>}
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
    const [error, setError] = useState(null);
    const [dialog, setDialog] = useState(null); // { event|null }

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/meetups?group=${group}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, group, revision, eventRevision]);

    const items = data?.group === group ? data.items : null;
    return (
        <section className="view">
            <div className="view-head">
                <h1>Ивенты</h1>
                <div className="tabs" role="tablist">
                    {GROUPS.map(g => (
                        <button key={g.id} role="tab" aria-selected={group === g.id} className={`tab ${group === g.id ? 'is-active' : ''}`} onClick={() => setGroup(g.id)}>
                            {g.label}
                        </button>
                    ))}
                </div>
                <button className="btn btn-primary" disabled={!data} onClick={() => setDialog({ event: null })}>Новый ивент</button>
            </div>
            {error && <p className="error">{error}</p>}
            {!items && !error && <p className="muted">Загружаем…</p>}
            {items && items.length === 0 && (
                <div className="empty">
                    <h2>{group === 'upcoming' ? 'Ближайших ивентов нет' : 'Прошедших ивентов пока нет'}</h2>
                    {group === 'upcoming' && <p>Создайте ивент — бот опубликует карточку с кнопками «Иду» и «Не иду», напомнит записавшимся за 15 минут, а из них можно одним нажатием собрать состав в голосовой.</p>}
                </div>
            )}
            <ul className="events">
                {(items || []).map(event => (
                    <EventCard key={event.id} guildId={guildId} event={event} channels={data.channels} onOpenMember={onOpenMember}
                        onEdit={e => setDialog({ event: e })} toast={toast} />
                ))}
            </ul>
            {dialog && data && <EventDialog guildId={guildId} event={dialog.event} channels={data.channels} onClose={() => setDialog(null)} toast={toast} />}
        </section>
    );
}
