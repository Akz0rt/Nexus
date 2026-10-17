import React, { useState } from 'react';
import { apiDelete, describeError } from './api.js';

/**
 * Saved squads beside the board. «Выделить» marks the members now in voice,
 * «Собрать» brings them to a channel (the rest get a DM invite).
 */
export default function SquadsPanel({ guildId, squads, inVoice, canManage, onSelect, onGather, onEdit, onChanged, toast }) {
    const [confirming, setConfirming] = useState(null);

    const remove = async squad => {
        const result = await apiDelete(`/guilds/${guildId}/voice/squads/${squad.id}`);
        setConfirming(null);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Состав «${squad.name}» удалён`);
        onChanged();
    };

    return (
        <aside className="squads" aria-label="Составы">
            <h2>Составы</h2>
            {squads === null && <p className="muted small">Загружаем…</p>}
            {squads?.length === 0 && (
                <p className="muted small">Выделите людей на доске и нажмите «Сохранить как состав», чтобы потом собирать их в одно касание.</p>
            )}
            <ul>
                {(squads || []).map(squad => {
                    const here = squad.members.filter(member => inVoice.has(member.id));
                    return (
                        <li key={squad.id} className="squad">
                            <div className="squad-head">
                                <strong>{squad.name}</strong>
                                <span className="muted small numeric">в голосе {here.length} из {squad.members.length}</span>
                            </div>
                            {confirming === squad.id ? (
                                <div className="squad-actions">
                                    <span className="small">Удалить состав?</span>
                                    <button className="btn btn-danger" onClick={() => remove(squad)}>Удалить</button>
                                    <button className="btn btn-quiet" onClick={() => setConfirming(null)}>Нет</button>
                                </div>
                            ) : (
                                <div className="squad-actions">
                                    <button className="btn" disabled={here.length === 0} onClick={() => onSelect(here.map(m => m.id))}>Выделить</button>
                                    <button className="btn" disabled={!canManage} onClick={() => onGather(squad)}>Собрать…</button>
                                    <button className="btn btn-quiet" disabled={!canManage} onClick={() => onEdit(squad)}>Изменить</button>
                                    <button className="btn btn-quiet" disabled={!canManage} onClick={() => setConfirming(squad.id)} aria-label={`Удалить состав ${squad.name}`}>✕</button>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}
