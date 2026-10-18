import React, { useEffect, useState } from 'react';
import { apiGet } from './api.js';
import { formatDateTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import { ErrorState } from './States.jsx';

const PERIODS = [{ id: 'day', label: 'Сутки' }, { id: 'week', label: 'Неделя' }, { id: 'month', label: 'Месяц' }];
const MODES = [{ id: 'both', label: 'Вместе' }, { id: 'text', label: 'Сообщения' }, { id: 'voice', label: 'Голос' }];

function formatMinutes(minutes) {
    if (!minutes) return '—';
    if (minutes < 60) return `${minutes} мин`;
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

function shortDate(date) {
    const [, month, day] = date.split('-');
    return `${Number(day)}.${month}`;
}

/**
 * One measure per chart (messages and voice hours have different scales, so they
 * never share an axis): thin bars, rounded tops, hover shows the day's value.
 */
function DailyBars({ title, series, valueOf, format, tone, markToday }) {
    const [hover, setHover] = useState(null);
    const max = Math.max(1, ...series.map(valueOf));
    const total = series.reduce((sum, d) => sum + valueOf(d), 0);
    const today = series[series.length - 1];
    // «Сутки»: the week for context, today's bar marked and its value in the caption
    const caption = markToday
        ? `сегодня: ${format(valueOf(today))} · за 7 дней: ${format(total)}`
        : `за ${series.length} дн.: ${format(total)}`;
    return (
        <figure className="daily-chart">
            <figcaption>
                <strong>{title}</strong>
                <span className="muted small">{caption}</span>
            </figcaption>
            <div className="daily-plot" role="img" aria-label={`${title}: ${caption}`} onMouseLeave={() => setHover(null)}>
                <span className="daily-max muted small numeric">{format(max)}</span>
                <div className="daily-bars">
                    {series.map((d, i) => {
                        const value = valueOf(d);
                        return (
                            <div key={d.date} className={`daily-col ${hover === i ? 'is-hover' : ''} ${markToday && d === today ? 'is-today' : ''}`} onMouseEnter={() => setHover(i)}>
                                <div className={`daily-bar daily-${tone}`} style={{ height: `${value ? Math.max(2, (value / max) * 100) : 0}%` }} />
                            </div>
                        );
                    })}
                </div>
                {hover !== null && (
                    <div className="daily-tip" style={{ left: `${((hover + 0.5) / series.length) * 100}%` }} role="status">
                        <span className="muted small">{shortDate(series[hover].date)}</span>
                        <strong className="numeric">{format(valueOf(series[hover]))}</strong>
                    </div>
                )}
            </div>
            <div className="daily-axis muted small numeric">
                <span>{shortDate(series[0].date)}</span>
                <span>{shortDate(series[series.length - 1].date)}</span>
            </div>
        </figure>
    );
}

export default function ActivityView({ guildId, onOpenMember }) {
    const [period, setPeriod] = useState('week');
    const [mode, setMode] = useState('both');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setData(d => (d ? { ...d, loading: true } : d));
        apiGet(`/guilds/${guildId}/activity?period=${period}&mode=${mode}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, period, mode, reload]);

    if (data && !data.supported) {
        return (
            <section className="view">
                <div className="view-head"><h1>Активность</h1></div>
                <div className="empty"><h2>Для этого сервера активность не собирается</h2><p>Бот считает сообщения и время в голосе только на основном сервере.</p></div>
            </section>
        );
    }

    const sync = data?.sync;
    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Активность</h1>
                <div className="segmented" role="group" aria-label="Период">
                    {PERIODS.map(p => <button key={p.id} className={`tab ${period === p.id ? 'is-active' : ''}`} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
                </div>
                <div className="segmented" role="group" aria-label="Что считать">
                    {MODES.map(m => <button key={m.id} className={`tab ${mode === m.id ? 'is-active' : ''}`} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
                </div>
            </div>
            {error && <ErrorState what="активность" error={error} onRetry={() => setReload(n => n + 1)} />}
            {!data && !error && <p className="muted">Загружаем…</p>}
            {data && (
                <>
                    <div className="daily-charts">
                        <DailyBars title="Сообщения по дням" series={data.daily} valueOf={d => d.messages} format={n => n.toLocaleString('ru-RU')} tone="text" markToday={data.period === 'day'} />
                        <DailyBars title="Часы в голосе по дням" series={data.daily} valueOf={d => d.voiceMinutes} format={formatMinutes} tone="voice" markToday={data.period === 'day'} />
                    </div>
                    <h2 className="section-title">Топ участников</h2>
                    {data.top.length === 0 && <div className="empty"><h2>За этот период активности нет</h2></div>}
                    {data.top.length > 0 && (
                        <div className="table-wrap">
                            <table className="journal stats">
                                <thead>
                                    <tr>
                                        <th className="num">#</th>
                                        <th>Участник</th>
                                        {mode !== 'voice' && <th className="num">Сообщений</th>}
                                        {mode !== 'text' && <th className="num">В голосе</th>}
                                        {mode === 'both' && <th className="num" title="Сообщения + минуты в голосе; по ним отсортирован топ">Очки</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.top.map((row, index) => (
                                        <tr key={row.userId}>
                                            <td className="num numeric muted">{index + 1}</td>
                                            <td>
                                                <span className="who">
                                                    <Avatar src={row.avatarURL} name={row.displayName} size={22} />
                                                    {row.member
                                                        ? <MemberLink id={row.userId} name={row.displayName} onOpen={onOpenMember} />
                                                        : <span className="muted">{row.displayName || row.userId} · вышел</span>}
                                                </span>
                                            </td>
                                            {mode !== 'voice' && <td className="num numeric">{row.messages ? row.messages.toLocaleString('ru-RU') : '—'}</td>}
                                            {mode !== 'text' && <td className="num numeric">{formatMinutes(row.minutes)}</td>}
                                            {mode === 'both' && <td className="num numeric"><strong>{row.score.toLocaleString('ru-RU')}</strong></td>}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="muted small">
                        {mode === 'both' && 'Очки = сообщения + минуты в голосе: одно сообщение стоит столько же, сколько минута в голосе. '}
                        {sync && (
                            <>Сбор сообщений: {sync.isRunning ? 'идёт сейчас' : `последний ${sync.lastSuccessAt ? timeAgo(sync.lastSuccessAt) : 'ещё не был'}`}
                                {sync.errorsCount > 0 && <span className="error"> · ошибок: {sync.errorsCount}{sync.error ? ` (${sync.error})` : ''}</span>}
                                {sync.lastRunAt && <span title={formatDateTime(sync.lastRunAt)}> · бот проверяет каналы каждые несколько минут</span>}.
                            </>
                        )}
                        {' '}Данные хранятся 35 дней.
                    </p>
                </>
            )}
        </section>
    );
}
