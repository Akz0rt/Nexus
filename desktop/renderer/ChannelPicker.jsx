import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, describeError } from './api.js';
import Dialog from './Dialog.jsx';

/**
 * "Переместить в…": voice channels grouped by category with a search box.
 * Click or Enter picks a channel. categories: board data when the caller has it.
 */
export default function ChannelPicker({ guildId, title, categories: given, excludeIds = [], onPick, onClose }) {
    const [categories, setCategories] = useState(given || null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const searchRef = useRef(null);

    useEffect(() => { searchRef.current?.focus(); }, []);
    useEffect(() => {
        if (given) return;
        apiGet(`/guilds/${guildId}/voice`)
            .then(data => setCategories(data.categories))
            .catch(err => setError(describeError(err)));
    }, [guildId, given]);

    const groups = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return (categories || [])
            .map(category => ({
                ...category,
                channels: category.channels.filter(channel => !excludeIds.includes(channel.id)
                    && (!needle || channel.name.toLowerCase().includes(needle) || category.name.toLowerCase().includes(needle)))
            }))
            .filter(category => category.channels.length > 0);
    }, [categories, query, excludeIds]);

    const first = groups[0]?.channels[0];

    return (
        <Dialog title={title || 'Переместить в…'} onClose={onClose} onSubmit={() => first && onPick(first)}>
            <input ref={searchRef} type="search" value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Название канала или категории" aria-label="Поиск канала" />
            {error && <p className="error">{error}</p>}
            {!categories && !error && <p className="muted">Загружаем каналы…</p>}
            {categories && groups.length === 0 && <p className="muted">Каналов не нашли.</p>}
            <div className="picker-list">
                {groups.map(category => (
                    <section key={category.id || 'none'}>
                        <h3>{category.name}</h3>
                        <ul>
                            {category.channels.map(channel => (
                                <li key={channel.id}>
                                    <button type="button" className={`picker-item ${channel === first ? 'is-first' : ''}`} onClick={() => onPick(channel)}>
                                        <span>{channel.name}</span>
                                        <span className="muted small numeric">
                                            {channel.locked && 'закрыт · '}
                                            {channel.members.length}{channel.userLimit ? `/${channel.userLimit}` : ''}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </Dialog>
    );
}
