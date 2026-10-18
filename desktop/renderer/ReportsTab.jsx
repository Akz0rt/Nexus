import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { ErrorState } from './States.jsx';
import { formatDateTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';

const GROUPS = [
    { id: 'open', label: 'Открытые' },
    { id: 'closed', label: 'Закрытые' }
];
const STATUS_LABELS = { open: 'новая', taken: 'в работе', resolved: 'решена', rejected: 'отклонена' };

/** Close a report («Решено» / «Отклонить») with an optional note, or answer the reporter. */
function ReportDialog({ guildId, report, kind, onClose, onDone, toast }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const titles = { resolve: 'Жалоба решена', reject: 'Отклонить жалобу', reply: 'Ответить заявителю' };

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
        toast(kind === 'reply' ? 'Ответ отправлен в ЛС' : kind === 'resolve' ? 'Жалоба закрыта как решённая' : 'Жалоба отклонена');
        onDone();
        onClose();
    };

    return (
        <Dialog title={titles[kind]} onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={kind === 'reply' ? 'Отправить' : kind === 'resolve' ? 'Закрыть' : 'Отклонить'}
            submitTone={kind === 'reject' ? 'danger' : 'primary'}>
            {kind === 'reply'
                ? <p className="muted small">Бот напишет {report.reporter?.displayName || 'заявителю'} в личные сообщения от имени модераторов сервера.</p>
                : <p className="muted small">Заметка видна только модераторам. Можно оставить пустой.</p>}
            <textarea autoFocus rows={kind === 'reply' ? 5 : 3} maxLength={kind === 'reply' ? 1500 : 400} value={text}
                placeholder={kind === 'reply' ? 'Спасибо! Нарушителю выдан мут.' : kind === 'resolve' ? 'Например: выдан варн' : 'Например: не нарушение правил'}
                onChange={e => setText(e.target.value)} />
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

function ReportCard({ guildId, report, onOpenMember, onChanged, toast }) {
    const [dialog, setDialog] = useState(null);
    const [busy, setBusy] = useState(false);
    const closed = report.status === 'resolved' || report.status === 'rejected';

    const take = async () => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/reports/${report.id}/take`);
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        onChanged();
    };

    return (
        <li className={`report report-${report.status}`}>
            <div className="report-head">
                <Avatar src={report.target?.avatarURL} name={report.target?.displayName} size={32} />
                <div className="report-who">
                    <span>На <MemberLink id={report.target?.id} name={report.target?.displayName} onOpen={onOpenMember} /></span>
                    <span className="muted small">
                        в #{report.channel.name || 'удалённом канале'} · {timeAgo(report.createdAt)}
                    </span>
                </div>
                <span className={`report-status status-${report.status}`}>{STATUS_LABELS[report.status]}</span>
            </div>
            <blockquote className="report-message">
                {report.content || <span className="muted">без текста</span>}
                {report.attachments.length > 0 && <span className="muted small"> [файлы: {report.attachments.join(', ')}]</span>}
            </blockquote>
            <p className="report-reason">
                <span className="muted small">Жалоба от </span>
                <MemberLink id={report.reporter?.id} name={report.reporter?.displayName} onOpen={onOpenMember} />
                <span className="muted small">:</span> {report.reason}
            </p>
            {(report.takenBy || closed || report.repliedAt) && (
                <p className="muted small">
                    {report.takenBy && <>Взял <MemberLink id={report.takenBy.id} name={report.takenBy.displayName} onOpen={onOpenMember} /></>}
                    {closed && <> · {report.status === 'resolved' ? 'решил' : 'отклонил'} {report.resolvedBy?.displayName || '—'} {formatDateTime(report.resolvedAt)}</>}
                    {report.resolution && <> · «{report.resolution}»</>}
                    {report.repliedAt && <> · заявителю ответили</>}
                </p>
            )}
            <div className="report-actions">
                {report.messageUrl && <a className="btn btn-quiet" href={report.messageUrl} target="_blank" rel="noreferrer">Открыть в Discord</a>}
                {!closed && report.status === 'open' && <button className="btn" disabled={busy} onClick={take}>Взять себе</button>}
                {!closed && <button className="btn" onClick={() => onOpenMember(report.target.id)}>Наказать…</button>}
                {!closed && <button className="btn" onClick={() => setDialog('resolve')}>Решено</button>}
                {!closed && <button className="btn btn-danger" onClick={() => setDialog('reject')}>Отклонить</button>}
                <button className="btn btn-quiet" onClick={() => setDialog('reply')}>{report.repliedAt ? 'Ответить ещё' : 'Ответить заявителю'}</button>
            </div>
            {dialog && <ReportDialog guildId={guildId} report={report} kind={dialog} onClose={() => setDialog(null)} onDone={onChanged} toast={toast} />}
        </li>
    );
}

/** «Жалобы» on the Moderation screen: reports members sent with «Пожаловаться». */
export default function ReportsTab({ guildId, revision, onOpenMember, toast }) {
    const [group, setGroup] = useState('open');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/reports?status=${group}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, group, revision, reload]);

    const items = data?.status === group ? data.items : null;
    return (
        <>
            <div className="toolbar">
                <div className="segmented" role="group" aria-label="Какие жалобы">
                    {GROUPS.map(g => (
                        <button key={g.id} className={`tab ${group === g.id ? 'is-active' : ''}`} aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
                            {g.label}
                        </button>
                    ))}
                </div>
                <span className="muted small hint">Участники жалуются через ПКМ по сообщению → Приложения → «Пожаловаться». Автор о жалобе не узнаёт.</span>
            </div>
            {error && <ErrorState what="жалобы" error={error} onRetry={() => setReload(n => n + 1)} />}
            {!items && !error && <p className="muted">Загружаем…</p>}
            {items && items.length === 0 && (
                <div className="empty"><h2>{group === 'open' ? 'Открытых жалоб нет' : 'Закрытых жалоб пока нет'}</h2></div>
            )}
            <ul className="reports">
                {(items || []).map(report => (
                    <ReportCard key={report.id} guildId={guildId} report={report} onOpenMember={onOpenMember}
                        onChanged={() => setReload(n => n + 1)} toast={toast} />
                ))}
            </ul>
        </>
    );
}
