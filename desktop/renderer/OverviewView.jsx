import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { ErrorState, Skeleton } from './States.jsx';
import { GENDER_LABELS, accountAge, describeAction, formatDateTime, plural, timeAgo, untilText, waitLabel } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Icon from './icons.jsx';
import { Chip } from './Chips.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import SanctionDialog from './SanctionDialog.jsx';
import { ExtraRolesDialog, useAssignable } from './RoleDialogs.jsx';
import { KickDialog, inviteLabel } from './QueueView.jsx';

// Below the tiles: two columns; «Настроить» hides blocks and orders them within their column
const BLOCKS = {
    queue: { title: 'Очередь на пропуск', column: 'main' },
    journal: { title: 'Журнал', column: 'main' },
    voice: { title: 'Голосовые', column: 'side' },
    report: { title: 'Новая жалоба', column: 'side' },
    birthdays: { title: 'Дни рождения', column: 'side' }
};
const DEFAULT_LAYOUT = Object.keys(BLOCKS).map(id => ({ id, hidden: false }));
const LAYOUT_KEY = 'panel.overview.layout.v2';
const UNDO_TOAST_MS = 10000;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Per computer: which blocks this moderator wants and in what order
function readLayout() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (!Array.isArray(saved)) return DEFAULT_LAYOUT;
        const known = saved.filter(block => BLOCKS[block.id]);
        const missing = DEFAULT_LAYOUT.filter(block => !known.some(k => k.id === block.id));
        return [...known, ...missing];
    } catch {
        return DEFAULT_LAYOUT;
    }
}

function saveLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* per-machine convenience only */ }
}

/** «очередь и 1 жалоба», «очередь, 2 жалобы и lockdown» */
function attentionLine(items) {
    if (items.length === 0) return '';
    return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`;
}

// Journal dot: green for the pass, amber for punishments, red for reports, blue for the rest
function journalTone(action) {
    if (action.startsWith('verification.')) return 'ok';
    if (action.startsWith('moderation.')) return 'warn';
    if (action.startsWith('report.')) return 'danger';
    return 'ink';
}

/** «пропуск, Девушка», «мут, 1 ч — флуд» */
function journalWhat(entry) {
    const text = describeAction(entry).replace(' · ', ', ');
    return `${text.charAt(0).toLowerCase()}${text.slice(1)}${entry.reason ? ` — ${entry.reason.toLowerCase()}` : ''}`;
}

function Tile({ label, value, note, onClick, hot }) {
    return (
        <button type="button" className={`tile-stat ${hot ? 'is-hot' : ''}`} onClick={onClick}>
            <span className="tile-stat-label">{label}<Icon name="chevron" size={14} className="tile-stat-arrow" /></span>
            <span className="tile-stat-value numeric">{value ?? '—'}</span>
            <span className="tile-stat-note">{note || ' '}</span>
        </button>
    );
}

function Block({ id, title, more, editing, canUp, canDown, hidden, onMove, onToggle, children }) {
    return (
        <section className={`block block-${id} ${hidden ? 'is-hidden' : ''}`} aria-label={title}>
            <div className="block-head">
                <h2>{title}</h2>
                {editing ? (
                    <div className="block-edit">
                        <button type="button" className="btn btn-quiet btn-small" disabled={!canUp} onClick={() => onMove(-1)} aria-label="Выше">↑</button>
                        <button type="button" className="btn btn-quiet btn-small" disabled={!canDown} onClick={() => onMove(1)} aria-label="Ниже">↓</button>
                        <button type="button" className="btn btn-quiet btn-small" onClick={onToggle}>{hidden ? 'Показать' : 'Скрыть'}</button>
                    </div>
                ) : more}
            </div>
            {!hidden && children}
        </section>
    );
}

export default function OverviewView({ guildId, revision, voiceRevision, waiting, seen, openReports, lockdown, onView, onOpenTab, onOpenMember, onChanged, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [retry, setRetry] = useState(0);
    const [layout, setLayout] = useState(readLayout);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState({});
    const [extras, setExtras] = useState({}); // userId -> extra role ids for the pass
    const [extrasFor, setExtrasFor] = useState(null);
    const [kicking, setKicking] = useState(null);
    const [punishing, setPunishing] = useState(null);
    const { roles: assignable } = useAssignable(guildId);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/overview`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, revision, retry]);

    // Voice changes come often and in bursts: refresh only the voice block once they settle
    useEffect(() => {
        if (!voiceRevision) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/overview?parts=voice`)
                .then(part => {
                    if (!cancelled) setData(d => (d ? { ...d, voice: part.voice, tiles: { ...d.tiles, inVoice: part.inVoice } } : d));
                })
                .catch(() => {});
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [guildId, voiceRevision]);

    const changeLayout = next => { setLayout(next); saveLayout(next); };
    // ↑ / ↓ swap with the neighbour in the same column
    const neighbour = (index, delta) => {
        const column = BLOCKS[layout[index].id].column;
        for (let i = index + delta; i >= 0 && i < layout.length; i += delta) if (BLOCKS[layout[i].id].column === column) return i;
        return -1;
    };
    const move = (index, delta) => {
        const other = neighbour(index, delta);
        if (other < 0) return;
        const next = [...layout];
        [next[index], next[other]] = [next[other], next[index]];
        changeLayout(next);
    };
    const toggle = index => changeLayout(layout.map((block, i) => (i === index ? { ...block, hidden: !block.hidden } : block)));

    const decide = async (item, action, body) => {
        const id = item.member.id;
        setBusy(b => ({ ...b, [id]: true }));
        const roleIds = action === 'approve' ? (extras[id] || []) : [];
        const result = await apiPost(`/guilds/${guildId}/queue/${id}/${action}`, roleIds.length ? { ...body, roleIds } : body);
        setBusy(b => ({ ...b, [id]: false }));
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); onChanged(); return; }
        seen.markSeen([id]);
        setExtras(x => { const next = { ...x }; delete next[id]; return next; });
        onChanged();
        const name = item.member.displayName;
        if (action === 'kick') { toast(`${name} кикнут из очереди`); return; }
        toast(`Пропущен ${name} · ${GENDER_LABELS[body.gender]}${roleIds.length ? ` · +${roleIds.length} доп.` : ''}`, {
            ttl: UNDO_TOAST_MS,
            action: {
                label: 'Отменить',
                onClick: async () => {
                    const undo = await apiPost(`/guilds/${guildId}/queue/${id}/undo`);
                    toast(undo.ok ? `${name} снова в очереди` : describeError(undo), { tone: undo.ok ? null : 'error' });
                    onChanged();
                }
            }
        });
    };

    const tiles = data?.tiles;
    const waitingItems = waiting?.items || null;
    const waitingCount = waitingItems?.length ?? tiles?.waiting;
    const longest = (waitingItems || data?.queue || [])
        .reduce((first, item) => (!first || String(item.member.joinedAt) < String(first.member.joinedAt) ? item : first), null);
    const peopleInVoice = (data?.voice || []).reduce((sum, channel) => sum + channel.members.length, 0);
    const nameOf = id => data?.users?.[id]?.displayName || null;

    const attention = [
        waitingCount > 0 && 'очередь',
        openReports > 0 && `${openReports} ${plural(openReports, 'жалоба', 'жалобы', 'жалоб')}`,
        lockdown?.active && 'lockdown'
    ].filter(Boolean);
    const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

    const render = {
        queue: () => {
            if (data.queue === null) return <p className="muted small">Пропуск не настроен на этом сервере.</p>;
            if (data.queue.length === 0) return <p className="muted small">Очередь пуста.</p>;
            return (
                <ul className="mini-queue">
                    {data.queue.map(item => {
                        const { member } = item;
                        const invite = inviteLabel(item.invite);
                        const extra = extras[member.id] || [];
                        return (
                            <li key={member.id}>
                                <Avatar id={member.id} src={member.avatarURL} name={member.displayName} size={32} />
                                <div className="mini-queue-info">
                                    <span className="mini-queue-name">
                                        <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
                                        {member.flags.map(flag => <Chip key={flag.code} tone={flag.tone}>{flag.label}</Chip>)}
                                        {seen.isNew(member.id) && member.flags.length === 0 && <span className="queue-new">новый</span>}
                                    </span>
                                    <span className="muted small" title={`Зашёл ${formatDateTime(member.joinedAt)}`}>
                                        ждёт {waitLabel(member.joinedAt)} · аккаунту {accountAge(member.accountCreatedAt)} · {invite.text === '—' ? 'инвайт неизвестен' : invite.text === 'vanity' ? 'vanity-ссылка' : `инвайт ${invite.text}`}
                                        {extra.length > 0 && ` · +${extra.length} доп. ${plural(extra.length, 'роль', 'роли', 'ролей')}`}
                                    </span>
                                </div>
                                <button type="button" className="btn" disabled={busy[member.id]} onClick={() => decide(item, 'approve', { gender: 'male' })}>Парень</button>
                                <button type="button" className="btn" disabled={busy[member.id]} onClick={() => decide(item, 'approve', { gender: 'female' })}>Девушка</button>
                                <OverflowMenu label={`Ещё для ${member.displayName}: доп. роли, карточка, кик`} items={[
                                    assignable?.length > 0 && { label: extra.length ? 'Изменить доп. роли…' : 'Доп. роли…', onSelect: () => setExtrasFor(member) },
                                    { label: 'Открыть карточку', onSelect: () => onOpenMember(member.id) },
                                    { label: 'Кикнуть…', onSelect: () => setKicking(item), end: true }
                                ]} />
                            </li>
                        );
                    })}
                </ul>
            );
        },
        journal: () => (data.journal.length === 0
            ? <p className="muted small">Записей пока нет.</p>
            : (
                <ol className="mini-journal">
                    {data.journal.slice(0, 6).map(entry => {
                        const target = entry.targetIds?.[0];
                        return (
                            <li key={entry.id}>
                                <span className={`journal-dot tone-${journalTone(entry.action)}`} aria-hidden="true" />
                                <span className="mini-journal-line">
                                    {entry.actorId ? <MemberLink id={entry.actorId} name={nameOf(entry.actorId) || entry.actorTag} onOpen={onOpenMember} /> : <strong>бот</strong>}
                                    <span className="journal-arrow" aria-label="→">→</span>
                                    {target ? <MemberLink id={target} name={nameOf(target)} onOpen={onOpenMember} /> : <strong>сервер</strong>}
                                    {entry.targetIds?.length > 1 && <span className="muted"> и ещё {entry.targetIds.length - 1}</span>}
                                    <span className="mini-journal-what"> · {journalWhat(entry)}</span>
                                </span>
                                <time className="muted small numeric" dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                                    {timeAgo(entry.createdAt).replace(' назад', '')}
                                </time>
                            </li>
                        );
                    })}
                </ol>
            )),
        voice: () => (data.voice.length === 0
            ? <p className="muted small">В голосовых никого.</p>
            : (
                <ul className="mini-voice">
                    {data.voice.map(channel => {
                        const names = channel.members.map(m => m.displayName);
                        return (
                            <li key={channel.id}>
                                <button type="button" className="mini-voice-channel" onClick={() => onView('voice')}>
                                    <span className="mini-voice-name">{channel.name}</span>
                                    <span className="muted small">{names.slice(0, 3).join(', ')}{names.length > 3 ? ` и ещё ${names.length - 3}` : ''}</span>
                                </button>
                                <span className="avatar-stack">
                                    {channel.members.slice(0, channel.members.length > 4 ? 3 : 4).map(member => (
                                        <button key={member.id} type="button" className="avatar-button" title={member.displayName} onClick={() => onOpenMember(member.id)}>
                                            <Avatar id={member.id} src={member.avatarURL} name={member.displayName} size={26} />
                                        </button>
                                    ))}
                                    {channel.members.length > 4 && <span className="avatar-more">+{channel.members.length - 3}</span>}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )),
        report: () => {
            const report = data.report;
            return (
                <div className="mini-report">
                    <p>
                        <MemberLink id={report.reporter?.id} name={report.reporter?.displayName} onOpen={onOpenMember} />
                        <span className="journal-arrow" aria-label="→">→</span>
                        <MemberLink id={report.target?.id} name={report.target?.displayName} onOpen={onOpenMember} />: «{report.reason}»
                    </p>
                    <div className="mini-report-actions">
                        <button type="button" className="btn btn-primary" onClick={() => setPunishing(report)}>Наказать…</button>
                        <button type="button" className="btn" onClick={() => onOpenTab('moderation', 'reports')}>Открыть</button>
                    </div>
                </div>
            );
        },
        birthdays: () => (data.birthdays.length === 0
            ? <p className="muted small">В ближайшую неделю дней рождения нет.</p>
            : (
                <ul className="mini-birthdays">
                    {data.birthdays.map(item => (
                        <li key={item.id} className={item.inDays === 0 ? 'is-today' : ''}>
                            <Avatar id={item.id} src={item.avatarURL} name={item.displayName} size={26} />
                            <span className="mini-birthday-text">
                                <MemberLink id={item.id} name={item.displayName} onOpen={onOpenMember} />
                                {item.inDays === 0
                                    ? <span className="birthday-today"> · сегодня</span>
                                    : <span className="muted"> · {item.day} {MONTHS[item.month - 1]}, {item.inDays === 1 ? 'завтра' : `через ${item.inDays} дн.`}</span>}
                            </span>
                            {item.inDays === 0 && (
                                <span className={`small ${item.done ? 'birthday-done' : 'muted'}`}>
                                    {item.done ? 'поздравил' : `поздравим в ${data.birthdayCheckTime || '00:00'}`}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            ))
    };

    const more = {
        queue: <button type="button" className="link-button" onClick={() => onView('queue')}>Все {waitingCount ?? ''} →</button>,
        voice: <button type="button" className="link-button" onClick={() => onView('voice')}>Доска →</button>,
        journal: <button type="button" className="link-button" onClick={() => onView('journal')}>Все →</button>,
        report: data?.report && <span className="muted small">{timeAgo(data.report.createdAt)}</span>
    };
    const titles = {
        voice: `Голосовые${peopleInVoice ? ` · ${peopleInVoice} ${plural(peopleInVoice, 'человек', 'человека', 'человек')}` : ''}`
    };

    const column = name => layout.map((block, index) => ({ block, index }))
        .filter(({ block }) => BLOCKS[block.id].column === name)
        // The report block exists only while there is a fresh report (in «Настроить» it can still be hidden)
        .filter(({ block }) => (editing || !block.hidden) && (block.id !== 'report' || data.report || editing))
        .map(({ block, index }) => (
            <Block key={block.id} id={block.id} title={titles[block.id] || BLOCKS[block.id].title} more={more[block.id]} editing={editing}
                canUp={neighbour(index, -1) >= 0} canDown={neighbour(index, 1) >= 0} hidden={block.hidden}
                onMove={delta => move(index, delta)} onToggle={() => toggle(index)}>
                {block.id === 'report' && !data.report ? <p className="muted small">Появится, когда придёт жалоба, которую никто не взял.</p> : render[block.id]()}
            </Block>
        ));

    return (
        <section className="view view-wide">
            <div className="view-head">
                <div className="view-title">
                    <h1>Обзор</h1>
                    <p className="muted view-subtitle">
                        {today.charAt(0).toUpperCase() + today.slice(1)}
                        {attention.length > 0 && <> · требует внимания: {attentionLine(attention)}</>}
                    </p>
                </div>
                <span className="toolbar-spacer" />
                {editing && <button type="button" className="btn btn-quiet" onClick={() => changeLayout(DEFAULT_LAYOUT)}>Как было</button>}
                <button type="button" className={`btn ${editing ? 'btn-primary' : ''}`} onClick={() => setEditing(e => !e)}>{editing ? 'Готово' : 'Настроить'}</button>
            </div>
            {editing && <p className="muted small">Стрелками поменяйте порядок блоков в колонке, «Скрыть» уберёт ненужные. Сохраняется на этом компьютере.</p>}
            {error && <ErrorState what="обзор" error={error} onRetry={() => setRetry(n => n + 1)} />}
            {!data && !error && <Skeleton rows={4} height={96} />}
            {data && (
                <>
                    <div className="tile-stats overview-tiles">
                        <Tile label="Ждут пропуска" value={waitingCount} hot={waitingCount > 0} onClick={() => onOpenTab('queue', 'waiting')}
                            note={longest ? `дольше всех ждёт ${longest.member.displayName} — ${waitLabel(longest.member.joinedAt)}` : 'очередь пуста'} />
                        <Tile label="Пропущено сегодня" value={tiles.approvedToday} onClick={() => onOpenTab('queue', 'handled')}
                            note={tiles.approvedLastHour ? `+${tiles.approvedLastHour} за последний час` : tiles.approvedToday !== null ? 'за последний час — никого' : null} />
                        <Tile label="В голосовых" value={tiles.inVoice} onClick={() => onView('voice')}
                            note={data.voice.length ? `в ${data.voice.length} ${plural(data.voice.length, 'канале', 'каналах', 'каналах')}` : 'никого нет'} />
                        <Tile label="Активные муты" value={tiles.activeMutes} onClick={() => onOpenTab('moderation', 'active')}
                            note={tiles.nextMuteEndsAt ? `ближайший снимется ${untilText(tiles.nextMuteEndsAt) || 'сейчас'}` : 'мутов нет'} />
                    </div>
                    <div className="overview">
                        <div className="overview-column">{column('main')}</div>
                        <div className="overview-column">{column('side')}</div>
                    </div>
                </>
            )}
            {extrasFor && (
                <ExtraRolesDialog guildId={guildId} name={extrasFor.displayName} value={extras[extrasFor.id] || []}
                    excludeIds={waiting?.reservedRoleIds || []}
                    onClose={() => setExtrasFor(null)}
                    onPick={roleIds => { setExtras(x => ({ ...x, [extrasFor.id]: roleIds })); setExtrasFor(null); }} />
            )}
            {kicking && (
                <KickDialog names={[kicking.member.displayName]} busy={Boolean(busy[kicking.member.id])} onClose={() => setKicking(null)}
                    onKick={reason => { const item = kicking; setKicking(null); decide(item, 'kick', { reason }); }} />
            )}
            {punishing && (
                <SanctionDialog guildId={guildId} target={{ id: punishing.target.id, displayName: punishing.target.displayName }} reportId={punishing.id}
                    onClose={() => setPunishing(null)} onDone={() => { setPunishing(null); setRetry(n => n + 1); }} toast={toast} />
            )}
        </section>
    );
}
