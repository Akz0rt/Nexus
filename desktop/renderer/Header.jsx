import React, { useEffect, useRef, useState } from 'react';
import { apiGet } from './api.js';
import Avatar from './Avatar.jsx';
import Icon from './icons.jsx';
import LockdownButton from './LockdownButton.jsx';
import CommandBar from './CommandBar.jsx';
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


function AccountMenu({ me, theme, onTheme, onCheckUpdates }) {
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
                    <button className="btn btn-quiet" onClick={() => { setOpen(false); onCheckUpdates(); }}>Проверить обновления</button>
                    <button className="btn btn-quiet" onClick={() => window.panel.logout()}>Выйти из аккаунта</button>
                </div>
            )}
        </div>
    );
}

export default function Header({ guilds, guild, onGuild, me, streamState, onOpenMember, theme, onTheme, lockdown, canLockdown, onLockdown,
    lockdownConfirm, onLockdownConfirm, events, onOpenSettings, onOpenJournal, onCheckUpdates, commands, toast }) {
    return (
        <header className="topbar">
            <GuildSwitch guilds={guilds} guild={guild} onGuild={onGuild} />
            <CommandBar guildId={guild?.id} canLockdown={canLockdown} senior={canLockdown} actions={commands} toast={toast} />
            <div className="topbar-spacer" />
            {canLockdown && guild && (
                <LockdownButton guildId={guild.id} lockdown={lockdown} onChange={onLockdown} toast={toast}
                    confirm={lockdownConfirm} onConfirm={onLockdownConfirm} />
            )}
            <BotStatus streamState={streamState} guildId={guild?.id} canDiagnose={canLockdown} onOpenSettings={onOpenSettings} />
            <Notifications guildId={guild?.id} events={events} onOpenMember={onOpenMember} onOpenJournal={onOpenJournal} />
            <AccountMenu me={me} theme={theme} onTheme={onTheme} onCheckUpdates={onCheckUpdates} />
        </header>
    );
}
