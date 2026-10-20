import React, { useEffect, useState } from 'react';
import { apiGet } from './api.js';
import { formatDateTime, timeAgo } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import { ErrorState } from './States.jsx';
import DailyBars from './DailyBars.jsx';

const PERIODS = [{ id: 'day', label: 'Сутки' }, { id: 'week', label: 'Неделя' }, { id: 'month', label: 'Месяц' }];
const MODES = [{ id: 'both', label: 'Вместе' }, { id: 'text', label: 'Сообщения' }, { id: 'voice', label: 'Голос' }];

function formatMinutes(minutes) {
    if (!minutes) return '—';
    if (minutes < 60) return `${minutes} мин`;
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
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
                        <DailyBars title="Сообщения по дням" series={data.daily} parts={[{ key: 'messages', label: 'Сообщения', tone: 'text', valueOf: d => d.messages }]} markToday={data.period === 'day'} />
                        <DailyBars title="Часы в голосе по дням" series={data.daily} parts={[{ key: 'voice', label: 'В голосе', tone: 'voice', valueOf: d => d.voiceMinutes / 60 }]}
                            format={hours => formatMinutes(Math.round(hours * 60))} tickFormat={hours => `${hours} ч`} markToday={data.period === 'day'} />
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
