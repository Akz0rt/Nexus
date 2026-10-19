import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';
import { formatDateTime, plural } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import OverflowMenu from './OverflowMenu.jsx';
import Dialog from './Dialog.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMS = [7, 14, 30, 60, 90];

const shortDate = iso => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });

/** "2026-11-18" for <input type="date"> */
function dateInput(ms) {
    const date = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** «осталось 12 дней», «осталось 5 ч», «срок вышел» */
function leftText(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return 'срок вышел — кикнем в ближайшие минуты';
    if (ms < DAY_MS) return `осталось ${Math.max(1, Math.round(ms / 3600000))} ч`;
    const days = Math.round(ms / DAY_MS);
    return `осталось ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

/**
 * The term of a booster account: a preset number of days or a date (the end of that day,
 * the moderator's time). Used for a new pass and for «Продлить…».
 * onSubmit({ until, note })
 */
export function BoosterDialog({ title, names = [], from, withNote = true, submitLabel, busy, onClose, onSubmit }) {
    const base = from ? Math.max(Date.parse(from), Date.now()) : Date.now();
    const [days, setDays] = useState(30);
    const [date, setDate] = useState(dateInput(base + 30 * DAY_MS));
    const [note, setNote] = useState('');
    const pickDays = n => { setDays(n); setDate(dateInput(base + n * DAY_MS)); };
    // The chosen date until 23:59 of that day
    const until = new Date(`${date}T23:59:00`);
    const valid = !Number.isNaN(until.getTime()) && until.getTime() > Date.now() + 3600000;
    return (
        <Dialog title={title} onClose={onClose} submitLabel={submitLabel} busy={busy}
            onSubmit={() => valid && onSubmit({ until: until.toISOString(), note: note.trim() || null })}>
            {names.length > 0 && (
                <p className="muted small">{names.slice(0, 10).join(', ')}{names.length > 10 ? ` и ещё ${names.length - 10}` : ''}</p>
            )}
            <div className="field">
                {from ? 'Продлить на' : 'Срок'}
                <div className="segmented" role="group" aria-label="Срок в днях">
                    {TERMS.map(n => (
                        <button key={n} type="button" className={`tab ${days === n ? 'is-active' : ''}`} aria-pressed={days === n} onClick={() => pickDays(n)}>
                            {n} дн.
                        </button>
                    ))}
                </div>
            </div>
            <label className="field">
                {from ? 'Новая дата окончания' : 'Или до даты (включительно)'}
                <input type="date" value={date} min={dateInput(Date.now() + DAY_MS)} onChange={e => { setDate(e.target.value); setDays(null); }} />
            </label>
            {withNote && (
                <label className="field">
                    Заметка (необязательно)
                    <input value={note} maxLength={200} placeholder="Куплено у … до …" onChange={e => setNote(e.target.value)} />
                </label>
            )}
            <p className="muted small">
                {valid ? `До ${formatDateTime(until.toISOString())}. ` : 'Выберите дату не раньше завтрашней. '}
                {from ? 'За сутки до нового срока модераторам снова придёт напоминание.'
                    : 'Аккаунт получит роль «Бустер-аккаунт» без прав и сохранит @АНверефи — сервер он не увидит. Из очереди он уйдёт, а по сроку бот его кикнет.'}
            </p>
        </Dialog>
    );
}

/** Пропуск → «Бустеры»: accounts on a term, soonest end first. */
export default function BoostersTab({ guildId, revision, onOpenMember, onChanged, toast }) {
    const [data, setData] = useState(null);
    const [retry, setRetry] = useState(0);
    const [extending, setExtending] = useState(null);
    const [kicking, setKicking] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/queue?tab=boosters`)
            .then(result => { if (!cancelled) setData(result); })
            .catch(error => { if (!cancelled) setData({ items: [], error }); });
        return () => { cancelled = true; };
    }, [guildId, revision, retry]);

    const run = async (path, body, done) => {
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/queue/boosters/${path}`, body);
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return false; }
        toast(done);
        setRetry(n => n + 1);
        onChanged();
        return true;
    };

    if (!data) return <Skeleton rows={4} height={58} />;
    if (data.error) return <ErrorState what="бустеров" error={data.error} onRetry={() => setRetry(n => n + 1)} />;
    if (data.items.length === 0) {
        return <EmptyState icon="queue" title="Буст-аккаунтов нет"
            text="Отметьте их в очереди: «⋯» → «Бустер…» или выделите несколько и нажмите «Бустеры…». Бот кикнет их, когда выйдет срок." />;
    }
    return (
        <>
            <table className="boosters-table">
                <thead>
                    <tr><th>Участник</th><th>Буст</th><th>Срок</th><th>Пропустил</th><th>Заметка</th><th aria-label="Действия" /></tr>
                </thead>
                <tbody>
                    {data.items.map(item => {
                        const { member } = item;
                        const soon = item.until && Date.parse(item.until) - Date.now() < DAY_MS;
                        return (
                            <tr key={member.id}>
                                <td>
                                    <span className="queue-who">
                                        <Avatar id={member.id} src={member.avatarURL} name={member.displayName || member.id} size={32} />
                                        <span className="queue-names">
                                            <MemberLink id={member.id} name={member.displayName} onOpen={onOpenMember} />
                                            {member.username && <span className="muted small">@{member.username}</span>}
                                        </span>
                                    </span>
                                </td>
                                <td className="nowrap">
                                    {item.boostingSince
                                        ? <span className="booster-on" title={formatDateTime(item.boostingSince)}>бустит с {shortDate(item.boostingSince)}</span>
                                        : <span className="muted">не бустит</span>}
                                </td>
                                <td className="nowrap">
                                    {item.until ? (
                                        <span className="booster-term">
                                            <span title={formatDateTime(item.until)}>до {shortDate(item.until)}</span>
                                            <span className={`small ${soon ? 'is-soon' : 'muted'}`}>{leftText(item.until)}</span>
                                        </span>
                                    ) : <span className="muted" title="Роль выдана вручную — бот не кикнет без срока">без срока</span>}
                                </td>
                                <td className="nowrap muted">{item.createdBy?.displayName || '—'}</td>
                                <td className="booster-note">{item.note || <span className="muted">—</span>}</td>
                                <td className="booster-actions">
                                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => setExtending(item)}>
                                        {item.until ? 'Продлить…' : 'Задать срок…'}
                                    </button>
                                    <OverflowMenu label={`Ещё для ${member.displayName || member.id}: вернуть в очередь, кикнуть`} items={[
                                        { label: 'Вернуть в очередь', onSelect: () => run(`${member.id}/release`, {}, `${member.displayName || 'Аккаунт'} снова в очереди`) },
                                        item.until && { label: 'Кикнуть сейчас…', onSelect: () => setKicking(item), end: true, danger: true }
                                    ]} />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {extending && (
                <BoosterDialog title={`${extending.until ? 'Продлить' : 'Срок для'} ${extending.member.displayName || 'аккаунта'}`} from={extending.until}
                    withNote={false} submitLabel="Сохранить" busy={busy} onClose={() => setExtending(null)}
                    onSubmit={async ({ until }) => {
                        const ok = extending.until
                            ? await run(`${extending.member.id}/extend`, { until }, 'Срок продлён')
                            : await apiPost(`/guilds/${guildId}/queue/boosters`, { userIds: [extending.member.id], until })
                                .then(result => {
                                    const ok = result.ok && result.data.done.length > 0;
                                    toast(ok ? 'Срок задан' : describeError(result.ok ? { error: result.data.failed[0]?.code } : result), ok ? {} : { tone: 'error' });
                                    setRetry(n => n + 1);
                                    return ok;
                                });
                        if (ok) setExtending(null);
                    }} />
            )}
            {kicking && (
                <Dialog title={`Кикнуть ${kicking.member.displayName || 'аккаунт'} сейчас?`} onClose={() => setKicking(null)} submitLabel="Кикнуть" submitTone="danger" busy={busy}
                    onSubmit={async () => { if (await run(`${kicking.member.id}/kick`, {}, 'Буст-аккаунт кикнут')) setKicking(null); }}>
                    <p className="muted">Срок до {shortDate(kicking.until)}. {kicking.boostingSince ? 'Он сейчас бустит — буст пропадёт вместе с ним.' : 'Сейчас он не бустит.'}</p>
                </Dialog>
            )}
        </>
    );
}
