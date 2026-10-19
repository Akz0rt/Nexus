import React, { useState } from 'react';
import { apiDelete, describeError } from './api.js';
import Avatar from './Avatar.jsx';
import Dialog from './Dialog.jsx';
import OverflowMenu from './OverflowMenu.jsx';

/**
 * Saved squads beside the board. «Выделить» marks the members now in voice,
 * «Собрать» brings them to a channel (the rest get a DM invite).
 */
export default function SquadsPanel({ guildId, squads, inVoice, canManage, onNew, onSelect, onGather, onEdit, onChanged, toast }) {
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
            <div className="squads-head">
                <h2>Составы</h2>
                {canManage && <button type="button" className="btn btn-small" onClick={onNew}>+ Новый</button>}
            </div>
            {squads === null && <p className="muted small">Загружаем…</p>}
            {squads?.length === 0 && (
                <p className="muted small">Выделите людей на доске и нажмите «В состав», чтобы потом собирать их в одно касание.</p>
            )}
            <ul>
                {(squads || []).map(squad => {
                    const here = squad.members.filter(member => inVoice.has(member.id));
                    return (
                        <li key={squad.id} className="squad">
                            <div className="squad-head">
                                <strong>{squad.name}</strong>
                                <span className="muted small numeric">{here.length} из {squad.members.length} в голосе</span>
                            </div>
                            <span className="avatar-stack squad-faces">
                                {squad.members.slice(0, 6).map(member => (
                                    <span key={member.id} className={inVoice.has(member.id) ? '' : 'is-away'} title={member.displayName || member.id}>
                                        <Avatar id={member.id} src={member.avatarURL} name={member.displayName} size={24} />
                                    </span>
                                ))}
                                {squad.members.length > 6 && <span className="stack-more">+{squad.members.length - 6}</span>}
                            </span>
                            <div className="squad-actions">
                                <button className="btn btn-primary" disabled={!canManage} onClick={() => onGather(squad)}>Собрать</button>
                                <button className="btn" disabled={here.length === 0} onClick={() => onSelect(here.map(m => m.id))}>Выделить</button>
                                {canManage && (
                                    <OverflowMenu label={`Ещё для состава ${squad.name}: изменить, удалить`} items={[
                                        { label: 'Изменить…', onSelect: () => onEdit(squad) },
                                        { label: 'Удалить', onSelect: () => setConfirming(squad), end: true, danger: true }
                                    ]} />
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
            {confirming && (
                <Dialog title={`Удалить состав «${confirming.name}»?`} submitLabel="Удалить" submitTone="danger"
                    onClose={() => setConfirming(null)} onSubmit={() => remove(confirming)}>
                    <p className="muted small">Люди останутся на сервере — удалится только сохранённый список.</p>
                </Dialog>
            )}
        </aside>
    );
}
