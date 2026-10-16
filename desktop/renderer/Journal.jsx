import React, { useEffect, useState } from 'react';
import { apiGet, describeError } from './api.js';

const ACTION_LABELS = {
    'verification.queued': 'Новичок в очереди',
    'verification.approved': 'Пропуск',
    'verification.kicked': 'Кик из очереди',
    'verification.role_removed': '@АНверефи снята вручную',
    'verification.left': 'Вышел из очереди',
    'verification.role_assigned': 'Выдана @АНверефи при входе'
};

const SOURCE_LABELS = { discord: 'Discord', bot: 'бот', panel: 'панель', auto: 'авто' };

function name(users, id) {
    if (!id) return 'бот';
    return users[id]?.displayName || id;
}

export default function Journal({ guildId, liveEvents }) {
    const [items, setItems] = useState([]);
    const [users, setUsers] = useState({});
    const [cursor, setCursor] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = async (nextCursor) => {
        setLoading(true);
        try {
            const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : '';
            const page = await apiGet(`/guilds/${guildId}/audit${query}`);
            setItems(list => (nextCursor ? [...list, ...page.items] : page.items));
            setUsers(map => ({ ...map, ...page.users }));
            setCursor(page.cursor);
            setError(null);
        } catch (err) {
            setError(describeError(err));
        }
        setLoading(false);
    };

    useEffect(() => { load(null); }, [guildId]);

    // Live entries arrive via SSE; show the ones not loaded yet on top
    const known = new Set(items.map(item => item.id));
    const fresh = liveEvents.filter(entry => !known.has(entry.id));
    const rows = [...fresh, ...items];

    return (
        <section>
            {error && <p className="error">{error}</p>}
            <table className="journal">
                <thead>
                    <tr><th>Время</th><th>Кто</th><th>Действие</th><th>Над кем</th><th>Причина</th><th>Источник</th></tr>
                </thead>
                <tbody>
                    {rows.map(entry => (
                        <tr key={entry.id}>
                            <td>{new Date(entry.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })}</td>
                            <td>{entry.actorId ? name(users, entry.actorId) : (entry.actorTag || 'бот')}</td>
                            <td>
                                {ACTION_LABELS[entry.action] || entry.action}
                                {entry.details?.gender && ` · ${entry.details.gender === 'male' ? 'Парень' : 'Девушка'}`}
                            </td>
                            <td>{(entry.targetIds || []).map(id => name(users, id)).join(', ') || '—'}</td>
                            <td>{entry.reason || ''}</td>
                            <td>{SOURCE_LABELS[entry.source] || entry.source}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {!loading && rows.length === 0 && <p className="muted">Записей пока нет.</p>}
            {loading && <p className="muted">Загрузка…</p>}
            {cursor && !loading && <button onClick={() => load(cursor)}>Показать ещё</button>}
        </section>
    );
}
