import React, { useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut, describeError } from './api.js';
import { GENDER_LABELS, SOURCE_LABELS, accountAge, describeAction, describeBulk, describeMessage, formatDateTime, formatSince, timeAgo, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Icon from './icons.jsx';
import { Chip } from './Chips.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import { ErrorState, Skeleton } from './States.jsx';
import Dialog from './Dialog.jsx';
import PunishDialog from './PunishDialog.jsx';
import SanctionDialog from './SanctionDialog.jsx';
import ChannelPicker from './ChannelPicker.jsx';
import { PresetApplyDialog, RoleDialog } from './RoleDialogs.jsx';
import { EconomyBlock, EconomySummary } from './EconomyView.jsx';

const CARD_STATUS = {
    pending: 'Ждёт пропуска',
    approved: 'Пропущен',
    kicked: 'Кикнут из очереди',
    left: 'Вышел, не дождавшись',
    closed: 'Роль снята вне бота'
};

const ROLE_LOCKS = {
    bot: 'Выше роли бота — снять можно только в Discord',
    managed: 'Роль интеграции — её выдаёт и снимает она сама',
    higher: 'Выше вашей роли — снять может старший'
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const shortDate = iso => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });

function HistoryList({ entries, empty, onOpenMember }) {
    if (entries.length === 0) return <p className="muted small">{empty}</p>;
    return (
        <ol className="history">
            {entries.map(entry => (
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
    );
}

/** Moderator notes: newest first; the author or an administrator deletes one (second click confirms). */
function Notes({ guildId, userId, notes, toast, onChanged }) {
    const [adding, setAdding] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(null);

    useEffect(() => {
        if (!confirming) return undefined;
        const timer = setTimeout(() => setConfirming(null), 3000);
        return () => clearTimeout(timer);
    }, [confirming]);

    const save = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/members/${userId}/notes`, { text });
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        setText('');
        setAdding(false);
        onChanged();
    };
    const remove = async note => {
        if (confirming !== note.id) { setConfirming(note.id); return; }
        setConfirming(null);
        const result = await apiDelete(`/guilds/${guildId}/members/${userId}/notes/${note.id}`);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast('Заметка удалена');
        onChanged();
    };

    return (
        <section className="drawer-section">
            <div className="drawer-section-head">
                <h3>Заметки модераторов{notes?.length ? ` · ${notes.length}` : ''}</h3>
                {notes && !adding && <button type="button" className="link-button" onClick={() => setAdding(true)}>+ Добавить</button>}
            </div>
            {!notes && <p className="muted small">Заметки не загрузились — попробуйте открыть карточку ещё раз.</p>}
            {adding && (
                <form className="note-form" onSubmit={event => { event.preventDefault(); save(); }}>
                    <textarea autoFocus value={text} maxLength={500} rows={3} aria-label="Текст заметки"
                        placeholder="Её увидят только модераторы. Например: «просил не выключать микро на ивентах»"
                        onChange={e => setText(e.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
                            if (event.key === 'Escape') { event.stopPropagation(); setAdding(false); }
                        }} />
                    <div className="note-form-actions">
                        <span className="muted small">Ctrl+Enter — сохранить</span>
                        <span className="toolbar-spacer" />
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => { setAdding(false); setText(''); }}>Отмена</button>
                        <button type="submit" className="btn btn-primary btn-small" disabled={!text.trim() || busy}>Сохранить</button>
                    </div>
                </form>
            )}
            {notes?.length === 0 && !adding && <p className="muted small">Заметок нет. Их видят только модераторы.</p>}
            {notes?.map(note => (
                <div key={note.id} className="note">
                    <span className="note-text">{note.text}</span>
                    <span className="muted small">
                        {note.author?.displayName || 'модератор'} · <time dateTime={note.createdAt} title={formatDateTime(note.createdAt)}>{timeAgo(note.createdAt)}</time>
                    </span>
                    {note.canDelete && (
                        <button type="button" className={`note-delete ${confirming === note.id ? 'is-confirming' : ''}`} onClick={() => remove(note)}
                            aria-label={confirming === note.id ? 'Точно удалить заметку' : 'Удалить заметку'}>
                            {confirming === note.id ? 'Удалить?' : <Icon name="close" size={14} />}
                        </button>
                    )}
                </div>
            ))}
        </section>
    );
}

function NicknameDialog({ guildId, member, onClose, toast }) {
    const [value, setValue] = useState(member.nickname || '');
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        setBusy(true);
        const result = await apiPut(`/guilds/${guildId}/members/${member.id}/nickname`, { nickname: value });
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(result.data.nickname ? `Ник изменён: ${result.data.nickname}` : 'Ник сброшен');
        onClose();
    };
    return (
        <Dialog title={`Ник для ${member.displayName}`} onClose={onClose} onSubmit={submit} submitLabel="Сохранить" busy={busy}>
            <label className="field">
                Ник на сервере
                <input autoFocus value={value} maxLength={32} onChange={e => setValue(e.target.value)} placeholder={member.username} />
            </label>
            <p className="muted small">Пустое поле вернёт имя аккаунта. Человек увидит смену в Discord, в журнал она тоже попадёт.</p>
        </Dialog>
    );
}

const TABS = [
    { id: 'overview', label: 'Обзор' },
    { id: 'moderation', label: 'Модерация' },
    { id: 'economy', label: 'Экономика' },
    { id: 'history', label: 'История' }
];

export default function MemberDrawer({ guildId, userId, revision, onClose, onOpenMember, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const [tab, setTab] = useState('overview');
    const [dialog, setDialog] = useState(null); // 'warn' | 'mute' | 'kick' | 'ban' | 'move' | 'role' | 'preset' | 'sanction' | 'nick'
    const asideRef = useRef(null);

    // Another member: start on «Обзор» with placeholders, not the previous person's card
    useEffect(() => { setTab('overview'); setData(null); setError(null); }, [userId]);
    // Focus moves into the card (list shortcuts stay quiet) and goes back where it was on close
    useEffect(() => {
        const before = document.activeElement;
        asideRef.current?.focus();
        return () => { if (before?.isConnected) before.focus(); };
    }, []);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/members/${userId}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => {
                if (cancelled) return;
                setData(null);
                setError(err.error === 'member_not_found' ? 'Этого человека нет на сервере.' : err);
            });
        return () => { cancelled = true; };
    }, [guildId, userId, revision, reload]);

    useEffect(() => {
        const onKey = event => {
            // Dialogs and menus handle their own Escape
            if (event.key === 'Escape' && !dialog && !event.target.closest('input, select, textarea')) onClose();
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

    const member = data?.member.id === userId ? data.member : null;
    const moderation = data?.moderation;
    const can = moderation?.can || {};
    const voice = data?.voice;

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
    const micOn = () => voiceAction('unmute', { userIds: [userId] }, 'Микро включён');
    const micOff = () => voiceAction('mute', { userIds: [userId] }, 'Микро выключен');
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

    const noRight = 'Нет прав на это действие';
    const canPunish = can.warn || can.ban;
    // The main action depends on the state: a running mute, a mic switched off by the server, otherwise «Наказать…»
    const primary = moderation?.mutedUntil
        ? { label: 'Снять мут', onClick: unmute, disabled: !can.mute }
        : voice?.serverMute
            ? { label: 'Вкл. микро', onClick: micOn, disabled: !can.voiceMute }
            : { label: 'Наказать…', onClick: () => setDialog('sanction'), disabled: !canPunish, sanction: true };
    const muteItems = [
        moderation?.mutedUntil
            ? { label: 'Снять мут в чатах', onSelect: unmute, disabled: !can.mute }
            : { label: 'Мут в чатах…', onSelect: () => setDialog('mute'), disabled: !can.mute },
        voice && (voice.serverMute
            ? { label: 'Включить микро в голосе', onSelect: micOn, disabled: !can.voiceMute }
            : { label: 'Выключить микро в голосе', onSelect: micOff, disabled: !can.voiceMute })
    ];
    const moreItems = [
        !primary.sanction && { label: 'Наказать…', onSelect: () => setDialog('sanction'), disabled: !canPunish },
        voice && { label: 'Отключить от голоса', onSelect: () => voiceAction('disconnect', { userIds: [userId] }, 'Отключён от голоса'), disabled: !can.move },
        { label: 'Сменить ник…', onSelect: () => setDialog('nick'), disabled: !can.nick, title: can.nick ? undefined : 'Нужно право «Управлять никнеймами»' },
        { label: 'Кик…', onSelect: () => setDialog('kick'), disabled: !can.kick, end: true, danger: true },
        { label: 'Бан…', onSelect: () => setDialog('ban'), disabled: !can.ban, end: true, danger: true }
    ];

    const onTabKey = event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const index = TABS.findIndex(t => t.id === tab);
        const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        setTab(next.id);
        event.currentTarget.querySelector(`[data-tab="${next.id}"]`)?.focus();
    };

    const moderationHistory = (data?.history || []).filter(entry => entry.action.startsWith('moderation.'));

    return (
        <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <aside ref={asideRef} className="drawer" role="dialog" aria-modal="true" tabIndex={-1}
                aria-label={member ? `Карточка участника: ${member.displayName}` : 'Карточка участника'}>
                <header className="drawer-top">
                    <div className="drawer-id">
                        {member ? <Avatar src={member.avatarURL} name={member.displayName} id={member.id} size={56} /> : <span className="drawer-avatar-ghost" />}
                        <div className="drawer-name">
                            {member ? (
                                <>
                                    <h2>{member.displayName}</h2>
                                    <span className="muted">@{member.username}</span>
                                    <button type="button" className="id-copy numeric" onClick={copyId} aria-label="Скопировать ID" title="Скопировать ID">
                                        {member.id}<Icon name="copy" size={13} />
                                    </button>
                                </>
                            ) : !error && <Skeleton rows={2} height={18} />}
                        </div>
                        <button type="button" className="icon-button icon-button-lg drawer-close" onClick={onClose} aria-label="Закрыть">
                            <Icon name="close" size={16} />
                        </button>
                    </div>
                    {member && (
                        <>
                            <p className={`voice-status ${voice ? 'is-in' : ''}`}>
                                <span className="voice-status-dot" aria-hidden="true" />
                                <span>{voice ? `В «${voice.name}»${voice.since ? ` ${formatSince(voice.since)}` : ''}` : 'Не в голосе'}</span>
                                {voice?.serverMute && <span className="voice-note">· микро выключен сервером</span>}
                                {voice?.serverDeaf && <span className="voice-note">· звук выключен сервером</span>}
                                {moderation?.mutedUntil && (
                                    <span className="voice-note" title={`До ${formatDateTime(moderation.mutedUntil)}`}>· мут в чатах, {timeLeft(moderation.mutedUntil)}</span>
                                )}
                            </p>
                            {moderation && (
                                <div className="drawer-actions">
                                    <button type="button" className="btn btn-primary" onClick={primary.onClick} disabled={primary.disabled}
                                        title={primary.disabled ? noRight : undefined}>{primary.label}</button>
                                    {voice && (
                                        <button type="button" className="btn" onClick={() => setDialog('move')} disabled={!can.move}
                                            title={can.move ? undefined : noRight}>Переместить</button>
                                    )}
                                    <OverflowMenu text="Мут" label="Мут: в чатах или микро в голосе" items={muteItems} align="left" />
                                    <button type="button" className="btn" onClick={() => setDialog('warn')} disabled={!can.warn}
                                        title={can.warn ? undefined : noRight}>Варн</button>
                                    <OverflowMenu items={moreItems} />
                                </div>
                            )}
                            <div role="tablist" aria-label="Разделы карточки" className="drawer-tabs" onKeyDown={onTabKey}>
                                {TABS.map(t => (
                                    <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={tab === t.id}
                                        tabIndex={tab === t.id ? 0 : -1} className={`drawer-tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
                                        {t.label}{t.id === 'moderation' && moderation ? ` · ${moderation.warnings.length}` : ''}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </header>

                <div className="drawer-body" role={member ? 'tabpanel' : undefined}>
                    {error && (
                        <ErrorState what="карточку" error={error} onRetry={typeof error === 'string' ? undefined : () => setReload(n => n + 1)} />
                    )}
                    {!member && !error && <Skeleton rows={4} height={58} />}

                    {member && tab === 'overview' && (
                        <>
                            <div className="fact-grid">
                                <div className="fact"><span>Аккаунту</span><strong>{accountAge(member.accountCreatedAt)}</strong></div>
                                <div className="fact">
                                    <span>На сервере</span>
                                    <strong title={formatDateTime(member.joinedAt)}>{member.joinedAt ? `с ${shortDate(member.joinedAt)} · ${accountAge(member.joinedAt)}` : '—'}</strong>
                                </div>
                                <div className="fact">
                                    <span>Последняя активность</span>
                                    <strong title={data.lastMessageAt ? `Последнее сообщение: ${formatDateTime(data.lastMessageAt)}` : 'Бот помнит сообщения за 35 дней'}>
                                        {data.lastMessageAt ? timeAgo(data.lastMessageAt) : voice ? 'сейчас в голосе' : 'нет данных'}
                                    </strong>
                                </div>
                                <div className="fact">
                                    <span>День рождения</span>
                                    <strong>{data.birthday ? `${data.birthday.day} ${MONTHS[data.birthday.month - 1]}` : 'не указан'}</strong>
                                </div>
                            </div>
                            {(member.flags.length > 0 || data.card) && (
                                <div className="drawer-flags">
                                    {member.flags.map(flag => <Chip key={flag.code} tone={flag.tone}>{flag.label}</Chip>)}
                                    {data.card && (
                                        <span className="muted small">
                                            Пропуск: {(CARD_STATUS[data.card.status] || data.card.status).toLowerCase()}
                                            {data.card.gender && ` · ${GENDER_LABELS[data.card.gender]}`}
                                            {data.card.handledAt && ` · ${formatDateTime(data.card.handledAt)}`}
                                        </span>
                                    )}
                                </div>
                            )}

                            <section className="drawer-section">
                                <h3>Роли</h3>
                                {data.roles.length === 0 && <p className="muted small">Ролей нет.</p>}
                                <ul className="roles">
                                    {data.roles.map(role => (
                                        <li key={role.id} className={`role ${role.lock && role.lock !== 'no_permission' ? 'is-locked' : ''}`}
                                            style={{ '--role': role.color === '#000000' ? 'var(--muted)' : role.color }}
                                            title={ROLE_LOCKS[role.lock] || (role.expiresAt ? `Временная: до ${formatDateTime(role.expiresAt)}` : undefined)}>
                                            {role.name}
                                            {role.expiresAt && <span className="role-timer">{timeLeft(role.expiresAt).replace('осталось ', '')}</span>}
                                            {role.editable && (
                                                <button type="button" className="role-x" onClick={() => removeRole(role)} aria-label={`Снять роль ${role.name}`}>×</button>
                                            )}
                                            {ROLE_LOCKS[role.lock] && <Icon name="lock" size={12} className="role-lock" />}
                                        </li>
                                    ))}
                                    {can.roles && (
                                        <li>
                                            <OverflowMenu text="+ роль или пресет" buttonClass="role-add" label="Выдать роль или применить пресет" align="left"
                                                items={[
                                                    { label: 'Роль…', onSelect: () => setDialog('role') },
                                                    { label: 'Пресет…', onSelect: () => setDialog('preset') }
                                                ]} />
                                        </li>
                                    )}
                                </ul>
                            </section>

                            <EconomySummary guildId={guildId} userId={member.id} revision={revision} onMore={() => setTab('economy')} />

                            <Notes guildId={guildId} userId={member.id} notes={data.notes} toast={toast} onChanged={() => setReload(n => n + 1)} />
                        </>
                    )}

                    {member && tab === 'moderation' && moderation && (
                        <>
                            {moderation.mutedUntil && (
                                <p className="mute-state">Мут в чатах до {formatDateTime(moderation.mutedUntil)} · {timeLeft(moderation.mutedUntil)}</p>
                            )}
                            <section className="drawer-section">
                                <div className="drawer-section-head">
                                    <h3>Активные варны · {moderation.warnings.length}</h3>
                                    <button type="button" className="link-button" onClick={() => setDialog('sanction')} disabled={!canPunish}>Наказать…</button>
                                </div>
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
                                                    {can.warn && <button type="button" className="btn btn-quiet btn-small" onClick={() => unwarn(warn)}>Снять</button>}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                            </section>
                            <section className="drawer-section">
                                <h3>Наказания</h3>
                                <HistoryList entries={moderationHistory} empty="Мутов, киков и банов в журнале нет." onOpenMember={onOpenMember} />
                            </section>
                        </>
                    )}

                    {member && tab === 'economy' && (
                        <EconomyBlock guildId={guildId} userId={member.id} name={member.displayName} revision={revision} toast={toast} heading={false} />
                    )}

                    {member && tab === 'history' && (
                        <HistoryList entries={data.history} empty="За 30 дней действий с этим человеком не было." onOpenMember={onOpenMember} />
                    )}
                </div>

                {dialog === 'move' && member && (
                    <ChannelPicker guildId={guildId} excludeIds={voice ? [voice.id] : []}
                        onClose={() => setDialog(null)}
                        onPick={channel => { setDialog(null); voiceAction('move', { userIds: [userId], channelId: channel.id }, 'Перемещён'); }} />
                )}
                {dialog === 'role' && member && (
                    <RoleDialog guildId={guildId} userIds={[member.id]} title={`Роль для ${member.displayName}`} onClose={() => setDialog(null)} toast={toast} />
                )}
                {dialog === 'preset' && member && (
                    <PresetApplyDialog guildId={guildId} member={member} onClose={() => setDialog(null)} toast={toast} />
                )}
                {dialog === 'sanction' && member && (
                    <SanctionDialog guildId={guildId} target={{ id: member.id, displayName: member.displayName }}
                        onClose={() => setDialog(null)} toast={toast} />
                )}
                {dialog === 'nick' && member && (
                    <NicknameDialog guildId={guildId} member={member} onClose={() => setDialog(null)} toast={toast} />
                )}
                {['warn', 'mute', 'kick', 'ban'].includes(dialog) && member && (
                    <PunishDialog guildId={guildId} kind={dialog} target={{ id: member.id, displayName: member.displayName }}
                        onClose={() => setDialog(null)} toast={toast} />
                )}
            </aside>
        </div>
    );
}
