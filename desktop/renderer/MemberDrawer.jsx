import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS, SOURCE_LABELS, accountAge, describeAction, formatDateTime, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import PunishDialog from './PunishDialog.jsx';

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
    const [dialog, setDialog] = useState(null); // 'warn' | 'mute' | 'kick' | 'ban'

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
        const onKey = event => {
            // The punishment dialog handles its own Escape
            if (event.key === 'Escape' && !dialog && !event.target.closest('input, select')) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, dialog]);

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(userId);
            toast('ID скопирован');
        } catch {
            toast('Не удалось скопировать ID', { tone: 'error' });
        }
    };

    const member = data?.member;
    const moderation = data?.moderation;

    const unmute = async () => {
        const result = await apiPost(`/guilds/${guildId}/moderation/${userId}/unmute`);
        toast(result.ok ? 'Мут снят' : describeError(result), result.ok ? {} : { tone: 'error' });
    };
    const unwarn = async warn => {
        const result = await apiDelete(`/guilds/${guildId}/moderation/warnings/${warn.id}`);
        toast(result.ok ? 'Варн снят' : describeError(result), result.ok ? {} : { tone: 'error' });
    };

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

                    {moderation && (
                        <>
                            <h3>Модерация</h3>
                            {moderation.mutedUntil && (
                                <p className="mute-state">
                                    Мут до {formatDateTime(moderation.mutedUntil)} · {timeLeft(moderation.mutedUntil)}
                                </p>
                            )}
                            {moderation.warnings.length === 0
                                ? <p className="muted small">Активных варнов нет.</p>
                                : (
                                    <ul className="drawer-warns">
                                        {moderation.warnings.map(warn => (
                                            <li key={warn.id}>
                                                <span>{warn.reason}</span>
                                                <span className="muted small">
                                                    {warn.actor?.displayName || 'бот'} · {formatDateTime(warn.createdAt)} · сгорит {formatDateTime(warn.expiresAt)}
                                                </span>
                                                {moderation.can.warn && (
                                                    <button className="btn btn-quiet" onClick={() => unwarn(warn)}>Снять</button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            <div className="punish-row">
                                <button className="btn" disabled={!moderation.can.warn} onClick={() => setDialog('warn')}>Варн</button>
                                {moderation.mutedUntil
                                    ? <button className="btn" disabled={!moderation.can.mute} onClick={unmute}>Снять мут</button>
                                    : <button className="btn" disabled={!moderation.can.mute} onClick={() => setDialog('mute')}>Мут</button>}
                                <button className="btn btn-danger" disabled={!moderation.can.kick} onClick={() => setDialog('kick')}>Кик</button>
                                <button className="btn btn-danger" disabled={!moderation.can.ban} onClick={() => setDialog('ban')}>Бан</button>
                            </div>
                        </>
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
                                    {describeAction(entry)}
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
            {dialog && member && (
                <PunishDialog guildId={guildId} kind={dialog} target={{ id: member.id, displayName: member.displayName }}
                    onClose={() => setDialog(null)} toast={toast} />
            )}
        </aside>
    );
}
