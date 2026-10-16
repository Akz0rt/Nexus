import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';

const TABS = [
    { id: 'waiting', label: 'Ждут' },
    { id: 'handled', label: 'Обработаны сегодня' },
    { id: 'rejected', label: 'Отклонены сегодня' }
];

function formatTime(iso) {
    return iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function accountAge(iso) {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    return days < 60 ? `${days} дн.` : `${Math.floor(days / 30)} мес.`;
}

function QueueItem({ guildId, item, onDone }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [kicking, setKicking] = useState(false);
    const [reason, setReason] = useState('');
    const { member } = item;

    const act = async (action, body) => {
        setBusy(true);
        setError(null);
        const result = await apiPost(`/guilds/${guildId}/queue/${member.id}/${action}`, body);
        setBusy(false);
        if (!result.ok) setError(describeError(result));
        else onDone();
    };

    return (
        <li className="card">
            <img className="avatar" src={member.avatarURL} alt="" />
            <div className="info">
                <div><b>{member.displayName}</b> <span className="muted">@{member.username} · {member.id}</span></div>
                <div className="muted small">
                    аккаунту {accountAge(member.accountCreatedAt)} · зашёл {formatTime(member.joinedAt)}
                    {!item.card && ' · без карточки в Discord'}
                </div>
                {member.flags.length > 0 && <div className="flags">{member.flags.join(' · ')}</div>}
                {error && <div className="error">{error}</div>}
                {kicking && (
                    <form className="kick" onSubmit={e => { e.preventDefault(); act('kick', { reason }); }}>
                        <input autoFocus placeholder="Причина кика" value={reason} onChange={e => setReason(e.target.value)} />
                        <button type="submit" className="danger" disabled={busy || !reason.trim()}>Кикнуть</button>
                        <button type="button" onClick={() => setKicking(false)}>Отмена</button>
                    </form>
                )}
            </div>
            {!kicking && (
                <div className="actions">
                    <button disabled={busy} onClick={() => act('approve', { gender: 'male' })}>Парень</button>
                    <button disabled={busy} onClick={() => act('approve', { gender: 'female' })}>Девушка</button>
                    <button disabled={busy} className="danger" onClick={() => setKicking(true)}>Кик</button>
                </div>
            )}
        </li>
    );
}

function HandledItem({ item }) {
    const { member, card, handledBy } = item;
    const result = card.status === 'approved'
        ? `Пропущен · ${card.gender === 'male' ? 'Парень' : 'Девушка'}`
        : `Кикнут${card.reason ? ` · ${card.reason}` : ''}`;
    return (
        <li className="card">
            {member.avatarURL && <img className="avatar" src={member.avatarURL} alt="" />}
            <div className="info">
                <div><b>{member.displayName || member.id}</b></div>
                <div className="muted small">{result} · {handledBy?.displayName || handledBy?.id || '—'} · {formatTime(card.handledAt)}</div>
            </div>
        </li>
    );
}

export default function Queue({ guildId, revision }) {
    const [tab, setTab] = useState('waiting');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/queue?tab=${tab}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, tab, revision, reload]);

    return (
        <section>
            <div className="tabs">
                {TABS.map(t => (
                    <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setData(null); }}>
                        {t.label}{t.id === 'waiting' && data?.tab === 'waiting' ? ` (${data.items.length})` : ''}
                    </button>
                ))}
            </div>
            {error && <p className="error">{error}</p>}
            {!data && !error && <p className="muted">Загрузка…</p>}
            {data && data.items.length === 0 && <p className="muted">Пусто.</p>}
            <ul className="list">
                {data?.tab === 'waiting' && data.items.map(item => (
                    <QueueItem key={item.member.id} guildId={guildId} item={item} onDone={() => setReload(r => r + 1)} />
                ))}
                {data && data.tab !== 'waiting' && data.items.map(item => <HandledItem key={item.member.id} item={item} />)}
            </ul>
        </section>
    );
}
