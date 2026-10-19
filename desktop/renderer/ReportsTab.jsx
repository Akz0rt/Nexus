import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';
import { formatDateTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';
import { FilterChip, StatusPill } from './Chips.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import SanctionDialog from './SanctionDialog.jsx';
import TemplatesPanel from './PunishTemplates.jsx';

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/** «у него 1 варн и мут сегодня» / «нарушений раньше не было» (last 30 days) */
export function recordText(record) {
    if (!record) return null;
    const parts = [];
    if (record.activeWarns) parts.push(`${record.activeWarns} ${plural(record.activeWarns, 'варн', 'варна', 'варнов')}`);
    if (record.mutes) {
        const today = record.lastMuteAt && new Date(record.lastMuteAt).toDateString() === new Date().toDateString();
        parts.push(record.mutes === 1 ? (today ? 'мут сегодня' : 'мут') : `${record.mutes} ${plural(record.mutes, 'мут', 'мута', 'мутов')}${today ? ', последний сегодня' : ''}`);
    }
    if (record.kicks) parts.push(`${record.kicks} ${plural(record.kicks, 'кик', 'кика', 'киков')}`);
    if (record.bans) parts.push(`${record.bans} ${plural(record.bans, 'бан', 'бана', 'банов')}`);
    if (parts.length === 0) return 'нарушений раньше не было';
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} и ${parts.at(-1)}`;
    return `у него ${list}`;
}

/** Close a report («Решено без наказания» / «Отклонить») with an optional note, or answer the reporter. */
function ReportDialog({ guildId, report, kind, onClose, onDone, toast }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const titles = { resolve: 'Решено без наказания', reject: 'Отклонить жалобу', reply: 'Ответить заявителю' };

    const submit = async () => {
        if (kind === 'reply' && !text.trim()) { setError('Напишите ответ.'); return; }
        setBusy(true);
        const body = kind === 'reply' ? { text } : { note: text };
        const result = await apiPost(`/guilds/${guildId}/reports/${report.id}/${kind}`, body);
        setBusy(false);
        if (!result.ok) {
            setError(result.error === 'dm_closed' ? 'У заявителя закрыты личные сообщения.' : describeError(result));
            return;
        }
        toast(kind === 'reply' ? 'Ответ отправлен в ЛС' : kind === 'resolve' ? 'Жалоба закрыта без наказания' : 'Жалоба отклонена');
        onDone();
        onClose();
    };

    return (
        <Dialog title={titles[kind]} onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={kind === 'reply' ? 'Отправить' : kind === 'resolve' ? 'Закрыть' : 'Отклонить'}>
            {kind === 'reply'
                ? <p className="muted small">Бот напишет {report.reporter?.displayName || 'заявителю'} в личные сообщения от имени модераторов сервера.</p>
                : <p className="muted small">Заметка видна только модераторам. Можно оставить пустой.</p>}
            <textarea autoFocus rows={kind === 'reply' ? 5 : 3} maxLength={kind === 'reply' ? 1500 : 400} value={text}
                placeholder={kind === 'reply' ? 'Спасибо! Нарушителю выдан мут.' : kind === 'resolve' ? 'Например: поговорили, больше не повторится' : 'Например: не нарушение правил'}
                onChange={e => setText(e.target.value)} />
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

function ReportCard({ guildId, report, onOpenMember, onChanged, toast }) {
    const [dialog, setDialog] = useState(null);
    const [punishing, setPunishing] = useState(false);
    const [busy, setBusy] = useState(false);
    const closed = report.status === 'resolved' || report.status === 'rejected';
    const target = report.target || {};
    const targetName = target.displayName || 'нарушителя';

    const take = async () => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/reports/${report.id}/take`);
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        onChanged();
    };

    const status = report.status === 'open'
        ? <StatusPill tone="accent">новая · никто не взял</StatusPill>
        : report.status === 'taken'
            ? <StatusPill tone="ink">в работе · {report.takenBy?.displayName || '—'}</StatusPill>
            : <StatusPill tone="neutral">{report.status === 'resolved' ? 'решена' : 'отклонена'}</StatusPill>;
    const record = recordText(report.record);

    return (
        <li className={`report report-${report.status}`}>
            <div className="report-head">
                <Avatar id={target.id} src={target.avatarURL} name={target.displayName} size={32} />
                <div className="report-who">
                    <span>На <MemberLink id={target.id} name={target.displayName} onOpen={onOpenMember} /></span>
                    <span className="muted small">
                        #{report.channel.name || 'удалённый канал'} · <span title={formatDateTime(report.createdAt)}>{timeAgo(report.createdAt)}</span>
                        {record && ` · ${record}`}
                    </span>
                </div>
                {status}
            </div>
            <blockquote className="report-message">
                {report.content || <span className="muted">без текста</span>}
                {report.attachments.length > 0 && <span className="muted"> · {report.attachments.join(', ')}</span>}
            </blockquote>
            <p className="report-reason">
                Жалоба от <MemberLink id={report.reporter?.id} name={report.reporter?.displayName} onOpen={onOpenMember} />: «{report.reason}»
            </p>
            {closed && (
                <p className="muted small">
                    {report.status === 'resolved' ? 'Решил' : 'Отклонил'} {report.resolvedBy?.displayName || 'неизвестно'} · {formatDateTime(report.resolvedAt)}
                    {report.resolution && <> · «{report.resolution}»</>}
                    {report.repliedAt && <> · заявителю ответили</>}
                </p>
            )}
            <div className="report-actions">
                {!closed && <button className="btn btn-primary" disabled={!target.id} onClick={() => setPunishing(true)}>Наказать…</button>}
                {report.status === 'open' && <button className="btn" disabled={busy} onClick={take}>Взять себе</button>}
                {!closed && <button className="btn" onClick={() => setDialog('resolve')}>Решено без наказания</button>}
                <OverflowMenu label={`Ещё по жалобе на ${targetName}`} align="left" items={[
                    report.messageUrl && { label: 'Открыть в Discord', onSelect: () => window.open(report.messageUrl, '_blank', 'noopener') },
                    { label: report.repliedAt ? 'Ответить заявителю ещё' : 'Ответить заявителю', onSelect: () => setDialog('reply') },
                    target.id && { label: 'Открыть карточку участника', onSelect: () => onOpenMember(target.id) },
                    !closed && { label: 'Отклонить жалобу', onSelect: () => setDialog('reject'), end: true }
                ]} />
            </div>
            {dialog && <ReportDialog guildId={guildId} report={report} kind={dialog} onClose={() => setDialog(null)} onDone={onChanged} toast={toast} />}
            {punishing && (
                <SanctionDialog guildId={guildId} target={target} reportId={report.id}
                    onClose={() => setPunishing(false)} onDone={onChanged} toast={toast} />
            )}
        </li>
    );
}

/** «Жалобы» on the Moderation screen: reports members sent with «Пожаловаться», and the punishment templates. */
export default function ReportsTab({ guildId, revision, myId, onOpenMember, toast }) {
    const [group, setGroup] = useState('open'); // open | mine | closed
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const status = group === 'closed' ? 'closed' : 'open';

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/reports?status=${status}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, status, revision, reload]);

    const loaded = data?.status === status ? data.items : null;
    const mine = item => item.takenBy?.id === myId;
    const items = loaded && group === 'mine' ? loaded.filter(mine) : loaded;
    const openList = data?.status === 'open' ? data.items : null;
    return (
        <div className="reports-layout">
            <div className="reports-main">
                <div className="toolbar">
                    <FilterChip active={group === 'open'} count={openList ? openList.length : undefined} onClick={() => setGroup('open')}>Открытые</FilterChip>
                    <FilterChip active={group === 'mine'} count={openList ? openList.filter(mine).length : undefined} onClick={() => setGroup('mine')}>Мои</FilterChip>
                    <FilterChip active={group === 'closed'} onClick={() => setGroup('closed')}>Закрытые</FilterChip>
                </div>
                {error && <ErrorState what="жалобы" error={error} onRetry={() => setReload(n => n + 1)} />}
                {!items && !error && <Skeleton rows={2} height={150} />}
                {items && items.length === 0 && (
                    <EmptyState icon="moderation"
                        title={group === 'closed' ? 'Закрытых жалоб пока нет' : group === 'mine' ? 'Вы не взяли ни одной жалобы' : 'Открытых жалоб нет'}
                        text={group === 'open' ? 'Участники жалуются через ПКМ по сообщению → Приложения → «Пожаловаться». Автор о жалобе не узнаёт.' : null} />
                )}
                <ul className="reports">
                    {(items || []).map(report => (
                        <ReportCard key={report.id} guildId={guildId} report={report} onOpenMember={onOpenMember}
                            onChanged={() => setReload(n => n + 1)} toast={toast} />
                    ))}
                </ul>
            </div>
            <TemplatesPanel guildId={guildId} toast={toast} />
        </div>
    );
}
