import React, { useEffect, useState } from 'react';
import { apiGet, describeError } from './api.js';
import { ACTION_LABELS, GENDER_LABELS, SOURCE_LABELS, accountAge, formatDateTime } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';

const CARD_STATUS = {
    pending: 'Ждёт пропуска',
    approved: 'Пропущен',
    kicked: 'Кикнут из очереди',
    left: 'Вышел, не дождавшись',
    closed: 'Роль снята вне бота'
};

export default function MemberDrawer({ guildId, userId, revision, onClose, onOpenMember, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/members/${userId}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => {
                if (cancelled) return;
                setData(null);
                setError(err.error === 'member_not_found' ? 'Этого человека нет на сервере.' : describeError(err));
            });
        return () => { cancelled = true; };
    }, [guildId, userId, revision]);

    useEffect(() => {
        const onKey = event => { if (event.key === 'Escape' && !event.target.closest('input, select')) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(userId);
            toast('ID скопирован');
        } catch {
            toast('Не удалось скопировать ID', { tone: 'error' });
        }
    };

    const member = data?.member;

    return (
        <aside className="drawer" aria-label="Карточка участника">
            <div className="drawer-head">
                <button className="btn btn-quiet drawer-close" onClick={onClose} aria-label="Закрыть">✕</button>
            </div>
            {error && <p className="error drawer-pad">{error}</p>}
            {!data && !error && <p className="muted drawer-pad">Загружаем…</p>}
            {member && (
                <div className="drawer-body">
                    <div className="drawer-id">
                        <Avatar src={member.avatarURL} name={member.displayName} size={72} />
                        <div>
                            <h2>{member.displayName}</h2>
                            <p className="muted">@{member.username}</p>
                            <button className="id-copy numeric" onClick={copyId} title="Скопировать ID">{member.id}</button>
                        </div>
                    </div>

                    <dl className="facts">
                        <div><dt>Аккаунту</dt><dd>{accountAge(member.accountCreatedAt)}</dd></div>
                        <div><dt>На сервере с</dt><dd>{formatDateTime(member.joinedAt)}</dd></div>
                        <div><dt>Голосовой канал</dt><dd>{data.voice ? data.voice.name : 'не в голосе'}</dd></div>
                        {data.card && (
                            <div>
                                <dt>Пропуск</dt>
                                <dd>
                                    {CARD_STATUS[data.card.status] || data.card.status}
                                    {data.card.gender && ` · ${GENDER_LABELS[data.card.gender]}`}
                                    {data.card.handledAt && ` · ${formatDateTime(data.card.handledAt)}`}
                                </dd>
                            </div>
                        )}
                    </dl>
                    {member.flags.length > 0 && (
                        <ul className="flags">{member.flags.map(flag => <li key={flag}>{flag.replace(/^⚠️\s*/, '')}</li>)}</ul>
                    )}

                    <h3>Роли</h3>
                    {data.roles.length === 0 && <p className="muted small">Ролей нет.</p>}
                    <ul className="roles">
                        {data.roles.map(role => (
                            <li key={role.id} className="role" style={{ '--role': role.color === '#000000' ? 'var(--muted)' : role.color }}>
                                {role.name}
                            </li>
                        ))}
                    </ul>

                    <h3>История</h3>
                    {data.history.length === 0 && <p className="muted small">За 30 дней действий с этим человеком не было.</p>}
                    <ol className="history">
                        {data.history.map(entry => (
                            <li key={entry.id}>
                                <span className="numeric muted small">{formatDateTime(entry.createdAt)}</span>
                                <span>
                                    {ACTION_LABELS[entry.action] || entry.action}
                                    {entry.details?.gender && ` · ${GENDER_LABELS[entry.details.gender]}`}
                                    {entry.reason && ` — ${entry.reason}`}
                                </span>
                                <span className="muted small">
                                    {entry.actorId
                                        ? <MemberLink id={entry.actorId} name={entry.actorTag} onOpen={onOpenMember} />
                                        : 'бот'}
                                    {' · '}{SOURCE_LABELS[entry.source] || entry.source}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </aside>
    );
}
