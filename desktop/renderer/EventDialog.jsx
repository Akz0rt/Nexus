import React, { useState } from 'react';
import { apiPost, apiPut, describeError } from './api.js';
import Dialog from './Dialog.jsx';

const FIELD_ERRORS = {
    invalid_title: 'Введите название.',
    invalid_time: 'Время должно быть в будущем и не дальше чем через год.',
    channel_not_found: 'Выберите существующий канал.',
    bot_cannot_channel: 'Бот не может писать в этот канал: нужны «Просматривать», «Отправлять сообщения» и «Встраивать ссылки».'
};

/** "2026-10-24T21:00" for <input type="datetime-local"> in the moderator's own time zone. */
function toLocalInput(iso) {
    const date = iso ? new Date(iso) : new Date(Date.now() + 24 * 3600 * 1000);
    if (!iso) date.setMinutes(0, 0, 0);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Create or edit an event. */
export default function EventDialog({ guildId, event, channels, onClose, toast }) {
    const textChannels = channels.filter(c => !c.voice);
    const voiceChannels = channels.filter(c => c.voice);
    const [title, setTitle] = useState(event?.title || '');
    const [description, setDescription] = useState(event?.description || '');
    const [startsAt, setStartsAt] = useState(toLocalInput(event?.startsAt));
    const [channelId, setChannelId] = useState(event?.channel.id || textChannels[0]?.id || '');
    const [voiceChannelId, setVoiceChannelId] = useState(event?.voiceChannel?.id || '');
    const [repeatWeekly, setRepeatWeekly] = useState(Boolean(event?.repeatWeekly));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async () => {
        if (!title.trim()) { setError(FIELD_ERRORS.invalid_title); return; }
        setBusy(true);
        const body = { title, description, startsAt: new Date(startsAt).toISOString(), channelId, voiceChannelId: voiceChannelId || null, repeatWeekly };
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
            </div>
            <label className="check">
                <input type="checkbox" checked={repeatWeekly} onChange={e => setRepeatWeekly(e.target.checked)} />
                Повторять каждую неделю — после начала бот сам опубликует ивент на следующую неделю
            </label>
            <p className="muted small">Участники записываются кнопкой «Иду» под карточкой. За 15 минут до начала бот упомянет записавшихся в этом канале.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}
