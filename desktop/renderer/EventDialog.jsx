import React, { useState } from 'react';
import { apiPost, apiPut, describeError } from './api.js';
import Dialog from './Dialog.jsx';
import EventPreview from './EventPreview.jsx';

const FIELD_ERRORS = {
    invalid_title: 'Введите название.',
    invalid_time: 'Время должно быть в будущем и не дальше чем через год.',
    invalid_duration: 'Выберите длительность из списка.',
    channel_not_found: 'Выберите существующий канал.',
    role_not_found: 'Этой роли больше нет — выберите другую.',
    role_not_mentionable: 'Эту роль бот упомянуть не может: включите «Разрешить всем упоминать эту роль» или дайте боту право упоминать всех.',
    bot_cannot_channel: 'Бот не может писать в этот канал: нужны «Просматривать», «Отправлять сообщения» и «Встраивать ссылки».'
};

const DURATION_LABELS = { 30: '30 мин', 60: '1 ч', 90: '1,5 ч', 120: '2 ч', 180: '3 ч' };

/** "2026-10-24T21:00" for <input type="datetime-local"> in the moderator's own time zone. */
function toLocalInput(iso) {
    const date = iso ? new Date(iso) : new Date(Date.now() + 24 * 3600 * 1000);
    if (!iso) date.setMinutes(0, 0, 0);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Create or edit an event; the card's preview sits beside the form. */
export default function EventDialog({ guildId, event, channels, roles = [], durations = [30, 60, 90, 120, 180], onClose, toast }) {
    const textChannels = channels.filter(c => !c.voice);
    const voiceChannels = channels.filter(c => c.voice);
    const [title, setTitle] = useState(event?.title || '');
    const [description, setDescription] = useState(event?.description || '');
    const [startsAt, setStartsAt] = useState(toLocalInput(event?.startsAt));
    const [durationMinutes, setDurationMinutes] = useState(event?.durationMinutes || '');
    const [channelId, setChannelId] = useState(event?.channel.id || textChannels[0]?.id || '');
    const [voiceChannelId, setVoiceChannelId] = useState(event?.voiceChannel?.id || '');
    const [mentionRoleId, setMentionRoleId] = useState(event?.mentionRole?.id || '');
    const [repeatWeekly, setRepeatWeekly] = useState(Boolean(event?.repeatWeekly));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // A role saved earlier that the bot can no longer ping still shows, so the form doesn't drop it silently
    const roleOptions = event?.mentionRole && !roles.some(r => r.id === event.mentionRole.id)
        ? [...roles, { id: event.mentionRole.id, name: `${event.mentionRole.name || 'удалённая роль'} (бот не может упомянуть)` }]
        : roles;

    const submit = async () => {
        if (!title.trim()) { setError(FIELD_ERRORS.invalid_title); return; }
        setBusy(true);
        const body = {
            title, description, startsAt: new Date(startsAt).toISOString(), durationMinutes: durationMinutes ? Number(durationMinutes) : null,
            channelId, voiceChannelId: voiceChannelId || null, mentionRoleId: mentionRoleId || null, repeatWeekly
        };
        const result = event
            ? await apiPut(`/guilds/${guildId}/meetups/${event.id}`, body)
            : await apiPost(`/guilds/${guildId}/meetups`, body);
        setBusy(false);
        if (!result.ok) { setError(FIELD_ERRORS[result.error] || describeError(result)); return; }
        toast(event ? 'Ивент обновлён, карточка в Discord тоже' : `Ивент «${result.data.event.title}» опубликован`);
        onClose();
    };

    const label = c => `${c.category ? `${c.category} · ` : ''}${c.voice ? '' : '#'}${c.name}`;
    return (
        <Dialog title={event ? 'Изменить ивент' : 'Новый ивент'} onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={event ? 'Сохранить' : 'Опубликовать'} wide>
            <div className="event-form">
                <div className="event-form-fields">
                    <label className="field">
                        Название
                        <input autoFocus value={title} maxLength={100} placeholder="Мафия" onChange={e => setTitle(e.target.value)} />
                    </label>
                    <label className="field">
                        Описание (необязательно)
                        <textarea rows={3} value={description} maxLength={1000} placeholder="Ведущий — Kira. Правила в #мафия-правила" onChange={e => setDescription(e.target.value)} />
                    </label>
                    <div className="settings-grid">
                        <label className="field">
                            Когда (ваше время)
                            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
                        </label>
                        <label className="field">
                            Длительность
                            <select value={durationMinutes} onChange={e => setDurationMinutes(e.target.value)}>
                                <option value="">не указана</option>
                                {durations.map(d => <option key={d} value={d}>{DURATION_LABELS[d] || `${d} мин`}</option>)}
                            </select>
                        </label>
                        <label className="field">
                            Карточка в канале
                            <select value={channelId} onChange={e => setChannelId(e.target.value)}>
                                {textChannels.map(c => <option key={c.id} value={c.id}>{label(c)}</option>)}
                            </select>
                        </label>
                        <label className="field">
                            Голосовой канал (куда собирать)
                            <select value={voiceChannelId} onChange={e => setVoiceChannelId(e.target.value)}>
                                <option value="">— не нужен —</option>
                                {voiceChannels.map(c => <option key={c.id} value={c.id}>{label(c)}</option>)}
                            </select>
                        </label>
                        <label className="field">
                            Роль для упоминания
                            <select value={mentionRoleId} onChange={e => setMentionRoleId(e.target.value)}>
                                <option value="">— никого не упоминать —</option>
                                {roleOptions.map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
                            </select>
                        </label>
                    </div>
                    <label className="check">
                        <input type="checkbox" checked={repeatWeekly} onChange={e => setRepeatWeekly(e.target.checked)} />
                        Повторять каждую неделю — после начала бот сам опубликует ивент на следующую неделю
                    </label>
                    <p className="muted small">
                        {mentionRoleId ? 'Роль упомянем один раз — когда карточка появится. ' : ''}
                        За 15 минут до начала бот упомянет записавшихся в этом канале.
                        {event?.mentionRole && ' При изменении роль заново не упоминается.'}
                    </p>
                    {error && <p className="error">{error}</p>}
                </div>
                <EventPreview title={title} description={description} startsAt={startsAt} durationMinutes={Number(durationMinutes) || null}
                    voiceChannel={voiceChannels.find(c => c.id === voiceChannelId)} role={roles.find(r => r.id === mentionRoleId) || null}
                    repeatWeekly={repeatWeekly} />
            </div>
        </Dialog>
    );
}
