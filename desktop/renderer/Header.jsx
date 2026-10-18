import React, { useEffect, useRef, useState } from 'react';
import { apiGet } from './api.js';
import Avatar from './Avatar.jsx';
import Icon from './icons.jsx';
import LockdownButton from './LockdownButton.jsx';
import Notifications from './Notifications.jsx';

const STREAM = {
    open: { label: 'Бот на связи', tone: 'ok' },
    connecting: { label: 'Подключение…', tone: 'warn' },
    error: { label: 'Переподключение…', tone: 'warn' },
    closed: { label: 'Нет связи', tone: 'bad' }
};

const DIAGNOSTICS_EVERY_MS = 5 * 60 * 1000;

/** Server picker: the server's icon (or its first letter), the name, a list of the others. */
function GuildSwitch({ guilds, guild, onGuild }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const buttonRef = useRef(null);
    const listRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        (listRef.current?.querySelector('[aria-selected="true"]') || listRef.current?.querySelector('button'))?.focus();
        const onDown = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const choose = id => { setOpen(false); buttonRef.current?.focus(); if (id !== guild?.id) onGuild(id); };
    const onKeyDown = event => {
        const entries = [...(listRef.current?.querySelectorAll('button') || [])];
        const index = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
        if (event.key === 'Tab') setOpen(false);
    };
    const mark = g => (g.iconURL
        ? <img className="guild-icon" src={g.iconURL} alt="" width="20" height="20" />
        : <span className="guild-icon guild-letter" aria-hidden="true">{([...String(g.name || '?')][0] || '?').toUpperCase()}</span>);

    if (!guild) return null;
    const many = guilds.length > 1;
    return (
        <div className="guild-switch" ref={rootRef}>
            <button ref={buttonRef} type="button" className="guild-button" aria-haspopup={many ? 'listbox' : undefined}
                aria-expanded={many ? open : undefined} aria-label={`Сервер: ${guild.name}`} onClick={() => many && setOpen(o => !o)}>
                {mark(guild)}
                <span className="guild-name">{guild.name}</span>
                {many && <Icon name="chevron" size={14} strokeWidth={2} className="muted" />}
            </button>
            {open && (
                <div ref={listRef} role="listbox" aria-label="Серверы" className="menu-pop align-left guild-list" onKeyDown={onKeyDown}>
                    {guilds.map(g => (
                        <button key={g.id} type="button" role="option" aria-selected={g.id === guild.id}
                            className="menu-entry guild-entry" onClick={() => choose(g.id)}>
                            {mark(g)}<span>{g.name}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Green — all fine; yellow — reconnecting, or Diagnostics found problems
 * (administrators only; a click opens it); red — no connection.
 */
function BotStatus({ streamState, guildId, canDiagnose, onOpenSettings }) {
    const [problems, setProblems] = useState(0);
    useEffect(() => {
        setProblems(0);
        if (!guildId || !canDiagnose) return undefined;
        let cancelled = false;
        const check = () => apiGet(`/guilds/${guildId}/settings/diagnostics`)
            .then(data => { if (!cancelled) setProblems(data.checks.filter(c => c.level === 'bad').length); })
            .catch(() => {});
        check();
        const timer = setInterval(check, DIAGNOSTICS_EVERY_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [guildId, canDiagnose]);

    const stream = STREAM[streamState] || STREAM.closed;
    if (stream.tone === 'ok' && problems > 0) {
        return (
            <button type="button" className="link-state tone-warn" title={`Проблем в диагностике: ${problems}. Открыть Настройки → Диагностика`} onClick={() => onOpenSettings('diagnostics')}>
                <span className="link-state-text">Бот на связи · проблем: {problems}</span>
            </button>
        );
    }
    return <span className={`link-state tone-${stream.tone}`} title={stream.label}><span className="link-state-text">{stream.label}</span></span>;
}

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
            <Icon name="search" size={16} strokeWidth={2} className="search-icon" />
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
            <button className="account-button" aria-expanded={open} aria-label={`Аккаунт: ${me?.globalName || me?.username || ''}`}
                title={me?.globalName || me?.username} onClick={() => setOpen(o => !o)}>
                <Avatar id={me?.id} src={me?.avatarURL} name={me?.globalName || me?.username} size={32} />
            </button>
            {open && (
                <div className="account-menu" onMouseLeave={() => setOpen(false)}>
                    <label className="check">
                        <input type="checkbox" checked={Boolean(settings?.notifications)} disabled={!settings}
                            onChange={() => toggle('notifications')} />
                        Уведомлять о новичках и жалобах
                    </label>
                    <label className="check">
                        <input type="checkbox" checked={Boolean(settings?.sound)} disabled={!settings}
                            onChange={() => toggle('sound')} />
                        Звук: новичок или жалоба
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

export default function Header({ guilds, guild, onGuild, me, streamState, onOpenMember, theme, onTheme, lockdown, canLockdown, onLockdown,
    lockdownConfirm, onLockdownConfirm, events, onOpenSettings, onOpenJournal, toast }) {
    return (
        <header className="topbar">
            <GuildSwitch guilds={guilds} guild={guild} onGuild={onGuild} />
            <Search guildId={guild?.id} onOpenMember={onOpenMember} />
            <div className="topbar-spacer" />
            {canLockdown && guild && (
                <LockdownButton guildId={guild.id} lockdown={lockdown} onChange={onLockdown} toast={toast}
                    confirm={lockdownConfirm} onConfirm={onLockdownConfirm} />
            )}
            <BotStatus streamState={streamState} guildId={guild?.id} canDiagnose={canLockdown} onOpenSettings={onOpenSettings} />
            <Notifications guildId={guild?.id} events={events} onOpenMember={onOpenMember} onOpenJournal={onOpenJournal} />
            <AccountMenu me={me} theme={theme} onTheme={onTheme} />
        </header>
    );
}
