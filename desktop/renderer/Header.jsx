import React, { useEffect, useRef, useState } from 'react';
import { apiGet } from './api.js';
import Avatar from './Avatar.jsx';

const STREAM = {
    open: { label: 'Бот на связи', tone: 'ok' },
    connecting: { label: 'Подключение…', tone: 'warn' },
    error: { label: 'Переподключение…', tone: 'warn' },
    closed: { label: 'Нет связи', tone: 'bad' }
};

function Search({ guildId, onOpenMember }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [active, setActive] = useState(0);
    const [open, setOpen] = useState(false);
    const inputRef = useRef(null);

    // Ctrl+K focuses search from anywhere
    useEffect(() => {
        const onKey = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        const q = query.trim();
        if (!guildId || q.length < 2) { setResults([]); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/members/search?q=${encodeURIComponent(q)}`)
                .then(data => { if (!cancelled) { setResults(data.items); setActive(0); } })
                .catch(() => { if (!cancelled) setResults([]); });
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query, guildId]);

    const choose = member => {
        onOpenMember(member.id);
        setOpen(false);
        setQuery('');
        inputRef.current?.blur();
    };

    const onKeyDown = event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        if (event.key === 'Enter' && results[active]) choose(results[active]);
        if (event.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
    };

    return (
        <div className="search">
            <input
                ref={inputRef}
                type="search"
                placeholder="Ник, ID или @упоминание"
                aria-label="Поиск участника"
                value={query}
                onChange={e => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={onKeyDown}
            />
            <kbd className="search-hint">Ctrl K</kbd>
            {open && query.trim().length >= 2 && (
                <ul className="search-results" role="listbox">
                    {results.length === 0 && <li className="muted small search-empty">Никого не нашлось.</li>}
                    {results.map((member, index) => (
                        <li
                            key={member.id}
                            role="option"
                            aria-selected={index === active}
                            className={index === active ? 'is-active' : ''}
                            onMouseDown={() => choose(member)}
                            onMouseEnter={() => setActive(index)}
                        >
                            <Avatar src={member.avatarURL} name={member.displayName} size={24} />
                            <span>{member.displayName}</span>
                            <span className="muted small">@{member.username}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function AccountMenu({ me, theme, onTheme }) {
    const [open, setOpen] = useState(false);
    const [settings, setSettings] = useState(null);

    useEffect(() => { if (open) window.panel.getSettings().then(setSettings); }, [open]);

    const toggle = async key => setSettings(await window.panel.updateSettings({ [key]: !settings[key] }));

    return (
        <div className="account">
            <button className="account-button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                <Avatar src={me?.avatarURL} name={me?.globalName || me?.username} size={28} />
                <span>{me?.globalName || me?.username}</span>
            </button>
            {open && (
                <div className="account-menu" onMouseLeave={() => setOpen(false)}>
                    <label className="check">
                        <input type="checkbox" checked={Boolean(settings?.notifications)} disabled={!settings}
                            onChange={() => toggle('notifications')} />
                        Уведомлять о новичках
                    </label>
                    <label className="check">
                        <input type="checkbox" checked={Boolean(settings?.closeToTray)} disabled={!settings}
                            onChange={() => toggle('closeToTray')} />
                        Сворачивать в трей при закрытии
                    </label>
                    <label className="field">
                        Тема
                        <select value={theme} onChange={e => onTheme(e.target.value)}>
                            <option value="system">Как в системе</option>
                            <option value="dark">Тёмная</option>
                            <option value="light">Светлая</option>
                        </select>
                    </label>
                    <button className="btn btn-quiet" onClick={() => window.panel.logout()}>Выйти из аккаунта</button>
                </div>
            )}
        </div>
    );
}

export default function Header({ guilds, guild, onGuild, me, streamState, onOpenMember, theme, onTheme }) {
    const stream = STREAM[streamState] || STREAM.closed;
    return (
        <header className="topbar">
            <label className="guild-switch">
                {guild?.iconURL && <img src={guild.iconURL} alt="" width="28" height="28" />}
                <select aria-label="Сервер" value={guild?.id || ''} onChange={e => onGuild(e.target.value)}>
                    {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
            </label>
            <Search guildId={guild?.id} onOpenMember={onOpenMember} />
            <span className={`link-state tone-${stream.tone}`} title="Связь с ботом">{stream.label}</span>
            <AccountMenu me={me} theme={theme} onTheme={onTheme} />
        </header>
    );
}
