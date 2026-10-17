import React, { useMemo, useState } from 'react';
import { apiPost, describeError } from './api.js';
import Dialog from './Dialog.jsx';

function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * "Разбить на команды": pick who stays (the host) and the team channels, see the
 * random teams, reshuffle until happy, then send everyone off in one go.
 */
export default function SplitDialog({ guildId, channel, categories, myId, onDone, onClose }) {
    const players = channel.members.filter(member => !member.bot);
    const home = categories.find(category => category.channels.some(c => c.id === channel.id));
    const candidates = categories.flatMap(category => category.channels).filter(c => c.id !== channel.id);
    const nearbyEmpty = (home?.channels || []).filter(c => c.id !== channel.id && c.members.length === 0).map(c => c.id);

    const [stays, setStays] = useState(() => new Set(players.some(p => p.id === myId) ? [myId] : []));
    const [targets, setTargets] = useState(() => nearbyEmpty.slice(0, 2));
    const [seed, setSeed] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const teams = useMemo(() => {
        const going = shuffle(players.filter(p => !stays.has(p.id)));
        const result = new Map(targets.map(id => [id, []]));
        going.forEach((player, index) => result.get(targets[index % targets.length])?.push(player));
        return result;
        // Not on board refreshes (the teams mustn't reshuffle under your eyes); seed = "Перемешать"
    }, [stays, targets, seed]);

    const toggle = (set, id) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    };
    const toggleTarget = id => setTargets(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]));

    const submit = async () => {
        if (targets.length < 2) { setError('Выберите хотя бы два канала для команд.'); return; }
        const moves = [...teams.entries()].flatMap(([channelId, members]) => members.map(member => ({ userId: member.id, channelId })));
        if (moves.length === 0) { setError('Некого рассылать.'); return; }
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/voice/move`, { moves, kind: 'split', sourceChannelId: channel.id });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        onDone(result.data, { sourceChannelId: channel.id, targetChannelIds: targets });
        onClose();
    };

    const nameOf = id => candidates.find(c => c.id === id)?.name || id;

    return (
        <Dialog title={`Разбить «${channel.name}» на команды`} onClose={onClose} onSubmit={submit} submitLabel="Разослать" busy={busy} wide>
            <div className="split-grid">
                <div className="field">
                    Остаются в канале
                    <ul className="check-list">
                        {players.map(player => (
                            <li key={player.id}>
                                <label className="check">
                                    <input type="checkbox" checked={stays.has(player.id)} onChange={() => setStays(set => toggle(set, player.id))} />
                                    {player.displayName}
                                </label>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="field">
                    Каналы для команд
                    <ul className="check-list">
                        {candidates.map(c => (
                            <li key={c.id}>
                                <label className="check">
                                    <input type="checkbox" checked={targets.includes(c.id)} onChange={() => toggleTarget(c.id)} />
                                    {c.name}
                                    {c.members.length > 0 && <span className="muted small">· {c.members.length} чел.</span>}
                                </label>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {targets.length >= 2 && (
                <div className="teams">
                    {[...teams.entries()].map(([id, members], index) => (
                        <section key={id} className="team">
                            <h3><span className="team-no">{index + 1}</span>{nameOf(id)}</h3>
                            <ul>{members.map(member => <li key={member.id}>{member.displayName}</li>)}</ul>
                            {members.length === 0 && <p className="muted small">пусто</p>}
                        </section>
                    ))}
                </div>
            )}
            <div>
                <button type="button" className="btn" onClick={() => setSeed(n => n + 1)} disabled={targets.length < 2}>Перемешать</button>
            </div>
            <p className="muted small">После рассылки людей можно перетаскивать между каналами вручную, а «Собрать обратно» вернёт всех сюда.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}
