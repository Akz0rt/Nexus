import React, { useEffect, useRef, useState } from 'react';
import { apiPatch, apiPost, apiPut, describeError } from './api.js';
import Dialog from './Dialog.jsx';
import Avatar from './Avatar.jsx';

/** Rename a voice channel and change its user limit. */
export function ChannelEditDialog({ guildId, channel, onClose, toast }) {
    const [name, setName] = useState(channel.name);
    const [limit, setLimit] = useState(String(channel.userLimit || 0));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async () => {
        const userLimit = Number(limit);
        if (!Number.isInteger(userLimit) || userLimit < 0 || userLimit > 99) { setError('Лимит — число от 0 до 99.'); return; }
        setBusy(true);
        const result = await apiPatch(`/guilds/${guildId}/voice/channels/${channel.id}`, { name, userLimit });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        toast('Канал сохранён');
        onClose();
    };

    return (
        <Dialog title="Лимит и название" onClose={onClose} onSubmit={submit} submitLabel="Сохранить" busy={busy}>
            <label className="field">
                Название
                <input autoFocus value={name} maxLength={100} onChange={e => setName(e.target.value)} />
            </label>
            <label className="field">
                Лимит участников (0 — без лимита)
                <input type="number" min="0" max="99" value={limit} onChange={e => setLimit(e.target.value)} />
            </label>
            <p className="muted small">Discord разрешает переименовать канал только дважды за 10 минут.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

/**
 * Create a squad from the selection, or edit one: rename, drop members,
 * or replace its members with the current selection.
 */
export function SquadDialog({ guildId, squad, selection, onClose, onSaved, toast }) {
    const [name, setName] = useState(squad?.name || '');
    const [members, setMembers] = useState(squad ? squad.members : selection);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const nameRef = useRef(null);
    useEffect(() => { nameRef.current?.focus(); }, []);

    const submit = async () => {
        if (!name.trim()) { setError('Введите название.'); return; }
        if (members.length === 0) { setError('В составе никого нет.'); return; }
        setBusy(true);
        const body = { name: name.trim(), memberIds: members.map(m => m.id) };
        const result = squad
            ? await apiPut(`/guilds/${guildId}/voice/squads/${squad.id}`, body)
            : await apiPost(`/guilds/${guildId}/voice/squads`, body);
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        toast(squad ? `Состав «${body.name}» сохранён` : `Состав «${body.name}» создан`);
        onSaved();
        onClose();
    };

    return (
        <Dialog title={squad ? 'Изменить состав' : 'Сохранить как состав'} onClose={onClose} onSubmit={submit} submitLabel="Сохранить" busy={busy}>
            <label className="field">
                Название
                <input ref={nameRef} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="Мафия, пятница" />
            </label>
            <div className="field">
                Участники: {members.length}
                <ul className="squad-members">
                    {members.map(member => (
                        <li key={member.id}>
                            <Avatar src={member.avatarURL} name={member.displayName} size={22} />
                            <span>{member.displayName || member.id}</span>
                            <button type="button" className="btn btn-quiet" aria-label={`Убрать ${member.displayName || member.id}`}
                                onClick={() => setMembers(list => list.filter(m => m.id !== member.id))}>✕</button>
                        </li>
                    ))}
                </ul>
            </div>
            {squad && selection.length > 0 && (
                <button type="button" className="btn" onClick={() => setMembers(selection)}>Заменить выделенными на доске ({selection.length})</button>
            )}
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

/** "Собрать сюда": everyone from the ticked channels into this one. */
export function GatherDialog({ guildId, channel, categories, onClose, onDone }) {
    const others = categories.map(category => ({
        ...category,
        channels: category.channels.filter(c => c.id !== channel.id && c.members.length > 0)
    })).filter(category => category.channels.length > 0);
    const [picked, setPicked] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const toggle = ids => setPicked(set => {
        const next = new Set(set);
        const allOn = ids.every(id => next.has(id));
        ids.forEach(id => (allOn ? next.delete(id) : next.add(id)));
        return next;
    });

    const submit = async () => {
        if (picked.size === 0) { setError('Отметьте каналы, откуда собирать.'); return; }
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/voice/gather`, { channelId: channel.id, fromChannelIds: [...picked] });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        onDone(result.data);
        onClose();
    };

    return (
        <Dialog title={`Собрать в «${channel.name}»`} onClose={onClose} onSubmit={submit} submitLabel="Собрать" busy={busy}>
            {others.length === 0 && <p className="muted">В других каналах никого нет.</p>}
            <div className="picker-list">
                {others.map(category => (
                    <section key={category.id || 'none'}>
                        <h3>
                            <label className="check">
                                <input type="checkbox" checked={category.channels.every(c => picked.has(c.id))}
                                    onChange={() => toggle(category.channels.map(c => c.id))} />
                                {category.name} — вся категория
                            </label>
                        </h3>
                        <ul className="check-list">
                            {category.channels.map(c => (
                                <li key={c.id}>
                                    <label className="check">
                                        <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle([c.id])} />
                                        {c.name} <span className="muted small">· {c.members.length} чел.</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}
