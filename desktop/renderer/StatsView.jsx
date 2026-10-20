import React, { useEffect, useState } from 'react';
import { apiGet } from './api.js';
import { ErrorState } from './States.jsx';
import Avatar, { MemberLink } from './Avatar.jsx';
import DailyBars from './DailyBars.jsx';

const PERIODS = [
    { id: 'today', label: 'Сегодня' },
    { id: '7d', label: '7 дней' },
    { id: '30d', label: '30 дней' }
];

const COLUMNS = [
    { id: 'approved', label: 'Пропустил' },
    { id: 'rejected', label: 'Кикнул из очереди' },
    { id: 'warns', label: 'Варны' },
    { id: 'mutes', label: 'Муты' },
    { id: 'kicks', label: 'Кики' },
    { id: 'bans', label: 'Баны' },
    { id: 'voice', label: 'Голосовые' },
    { id: 'roles', label: 'Роли' }
];

/** "12 мин", "3 ч 05 мин", "2 дн. 4 ч" */
function formatWait(ms) {
    if (ms === null || ms === undefined) return '—';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч ${String(minutes % 60).padStart(2, '0')} мин`;
    return `${Math.floor(hours / 24)} дн. ${hours % 24} ч`;
}

export default function StatsView({ guildId, revision, onOpenMember, onOpenJournal }) {
    const [period, setPeriod] = useState('7d');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/stats?period=${period}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, period, revision, retry]);

    const queue = data?.queue;
    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Статистика модераторов</h1>
                <div className="tabs" role="tablist">
                    {PERIODS.map(p => (
                        <button key={p.id} role="tab" aria-selected={period === p.id} className={`tab ${period === p.id ? 'is-active' : ''}`} onClick={() => setPeriod(p.id)}>
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>
            {error && <ErrorState what="статистику" error={error} onRetry={() => setRetry(n => n + 1)} />}
            {queue && (
                <div className="tile-stats">
                    <div className="tile-stat is-static">
                        <span className="tile-stat-value numeric">{queue.decided}</span>
                        <span className="tile-stat-label">решений по новичкам</span>
                    </div>
                    <div className="tile-stat is-static">
                        <span className="tile-stat-value numeric">{formatWait(queue.averageWaitMs)}</span>
                        <span className="tile-stat-label">среднее ожидание в очереди</span>
                    </div>
                    <div className="tile-stat is-static">
                        <span className="tile-stat-value numeric">{formatWait(queue.medianWaitMs)}</span>
                        <span className="tile-stat-label">обычно ждут (медиана)</span>
                    </div>
                </div>
            )}
            {data?.daily && data.daily.length > 1 && (
                <DailyBars title="Решения по новичкам" series={data.daily} parts={[
                    { key: 'approved', label: 'Пропущено', tone: 'text', valueOf: d => d.approved },
                    { key: 'kicked', label: 'Кикнуто из очереди', tone: 'voice', valueOf: d => d.kicked }
                ]} />
            )}
            {data && data.moderators.length === 0 && (
                <div className="empty"><h2>За этот период действий модераторов не было</h2></div>
            )}
            {data && data.moderators.length > 0 && (
                <div className="table-wrap">
                    <table className="journal stats">
                        <thead>
                            <tr>
                                <th>Модератор</th>
                                {COLUMNS.map(c => <th key={c.id} className="num">{c.label}</th>)}
                                <th className="num">Всего</th>
                                <th className="num">Ожидание у его новичков</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.moderators.map(m => (
                                <tr key={m.actorId}>
                                    <td>
                                        <span className="who">
                                            <Avatar src={m.user?.avatarURL} name={m.user?.displayName} size={22} />
                                            <MemberLink id={m.actorId} name={m.user?.displayName} onOpen={onOpenMember} />
                                            <button className="filter-by" title="Его действия в журнале" onClick={() => onOpenJournal({ actorId: m.actorId })}>⏷</button>
                                        </span>
                                    </td>
                                    {COLUMNS.map(c => <td key={c.id} className={`num numeric ${m[c.id] ? '' : 'is-zero'}`}>{m[c.id] || 0}</td>)}
                                    <td className="num numeric"><strong>{m.total}</strong></td>
                                    <td className="num numeric">{m.decided ? formatWait(m.averageWaitMs) : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="muted small">Считается по журналу, а он хранит 30 дней. «Голосовые» — переносы, муты и отключения в голосе; «Роли» — выдачи, снятия и пресеты. Ожидание — от появления в очереди до решения.</p>
        </section>
    );
}
