import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS, SOURCE_LABELS, accountAge, describeAction, describeBulk, describeMessage, formatDateTime, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import PunishDialog from './PunishDialog.jsx';
import ChannelPicker from './ChannelPicker.jsx';
import { PresetApplyDialog, RoleDialog } from './RoleDialogs.jsx';
import { EconomyBlock } from './EconomyView.jsx';

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
    const [dialog, setDialog] = useState(null); // 'warn' | 'mute' | 'kick' | 'ban' | 'move' | 'role' | 'preset'

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
    const voiceAction = async (path, body, verb) => {
        const result = await apiPost(`/guilds/${guildId}/voice/${path}`, body);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        const failure = result.data.failed[0];
        toast(failure ? describeBulk(verb, result.data) : `${verb}: ${member.displayName}`, failure ? { tone: 'error' } : {});
    };
    const removeRole = async role => {
        const result = await apiPost(`/guilds/${guildId}/roles/bulk`, { userIds: [userId], roleId: role.id, add: false });
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        const failure = result.data.failed[0];
        toast(failure ? describeBulk('Роль снята', result.data) : `Роль снята: ${role.name}`, failure ? { tone: 'error' } : {});
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
                        <div>
                            <dt>Голосовой канал</dt>
                            <dd>
                                {data.voice ? data.voice.name : 'не в голосе'}
                                {data.voice?.serverMute && <span className="voice-note"> · микро выключен сервером</span>}
                                {data.voice?.serverDeaf && <span className="voice-note"> · звук выключен сервером</span>}
                            </dd>
                        </div>
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
                    {data.voice && moderation && (
                        <div className="punish-row">
                            <button className="btn" disabled={!moderation.can.move} onClick={() => setDialog('move')}>Переместить</button>
                            {data.voice.serverMute
                                ? <button className="btn" disabled={!moderation.can.voiceMute} onClick={() => voiceAction('unmute', { userIds: [userId] }, 'Микро включён')}>Включить микро</button>
                                : <button className="btn" disabled={!moderation.can.voiceMute} onClick={() => voiceAction('mute', { userIds: [userId] }, 'Микро выключен')}>Выключить микро</button>}
                            <button className="btn" disabled={!moderation.can.move} onClick={() => voiceAction('disconnect', { userIds: [userId] }, 'Отключён от голоса')}>Отключить от голоса</button>
                        </div>
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
                            <li key={role.id} className={`role ${role.editable ? '' : 'is-locked'}`}
                                style={{ '--role': role.color === '#000000' ? 'var(--muted)' : role.color }}
                                title={role.expiresAt ? `Временная: до ${formatDateTime(role.expiresAt)}` : (!role.editable && moderation?.can.roles ? 'Эту роль вы не можете снять' : undefined)}>
                                {role.name}
                                {role.expiresAt && <span className="role-timer">{timeLeft(role.expiresAt)}</span>}
                                {role.editable && (
                                    <button type="button" className="role-x" onClick={() => removeRole(role)} aria-label={`Снять роль ${role.name}`}>×</button>
                                )}
                            </li>
                        ))}
                    </ul>
                    {moderation?.can.roles && (
                        <div className="punish-row">
                            <button className="btn" onClick={() => setDialog('role')}>+ роль</button>
                            <button className="btn" onClick={() => setDialog('preset')}>Применить пресет</button>
                        </div>
                    )}

                    <EconomyBlock guildId={guildId} userId={member.id} name={member.displayName} revision={revision} toast={toast} />

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
                                {entry.action.startsWith('message.') && describeMessage(entry) && (
                                    <span className="message-text small">{describeMessage(entry)}</span>
                                )}
                                <span className="muted small">
                                    {entry.actorId
                                        ? <MemberLink id={entry.actorId} name={entry.actorTag} onOpen={onOpenMember} />
                                        : (entry.action.startsWith('message.') ? '—' : 'бот')}
                                    {' · '}{SOURCE_LABELS[entry.source] || entry.source}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            {dialog === 'move' && member && (
                <ChannelPicker guildId={guildId} excludeIds={data.voice ? [data.voice.id] : []}
                    onClose={() => setDialog(null)}
                    onPick={channel => { setDialog(null); voiceAction('move', { userIds: [userId], channelId: channel.id }, 'Перемещён'); }} />
            )}
            {dialog === 'role' && member && (
                <RoleDialog guildId={guildId} userIds={[member.id]} title={`Роль для ${member.displayName}`} onClose={() => setDialog(null)} toast={toast} />
            )}
            {dialog === 'preset' && member && (
                <PresetApplyDialog guildId={guildId} member={member} onClose={() => setDialog(null)} toast={toast} />
            )}
            {dialog && !['move', 'role', 'preset'].includes(dialog) && member && (
                <PunishDialog guildId={guildId} kind={dialog} target={{ id: member.id, displayName: member.displayName }}
                    onClose={() => setDialog(null)} toast={toast} />
            )}
        </aside>
    );
}
