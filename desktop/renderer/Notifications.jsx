import React, { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import Time from './Time.jsx';
import { describeAction } from './format.js';

const LIMIT = 20;
const key = guildId => `panel.notifications.read.${guildId}`;

function readMark(guildId) {
    try { return localStorage.getItem(key(guildId)) || ''; } catch { return ''; }
}

/**
 * The bell: the last 20 things that happened on the server since the app opened
 * (message edits and deletes left out), with an orange dot while some are unread.
 */
export default function Notifications({ guildId, events, onOpenMember, onOpenJournal }) {
    const [open, setOpen] = useState(false);
    const [readUntil, setReadUntil] = useState(() => readMark(guildId));
    const rootRef = useRef(null);
    const buttonRef = useRef(null);

    useEffect(() => { setReadUntil(readMark(guildId)); }, [guildId]);

    const items = events.filter(entry => !entry.action?.startsWith('message.')).slice(0, LIMIT);
    const unread = items.filter(entry => entry.createdAt > readUntil).length;

    useEffect(() => {
        if (!open) return undefined;
        // Opening the list marks everything in it as read
        const newest = items[0]?.createdAt;
        if (newest && newest > readUntil) {
            setReadUntil(newest);
            try { localStorage.setItem(key(guildId), newest); } catch { /* per-viewer convenience only */ }
        }
        const onDown = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
        const onKey = event => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open, items[0]?.createdAt]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!guildId) return null;
    return (
        <div className="notifications" ref={rootRef}>
            <button ref={buttonRef} type="button" className="icon-button icon-button-lg" aria-expanded={open}
                aria-label={unread ? `Уведомления, новых: ${unread}` : 'Уведомления'} onClick={() => setOpen(o => !o)}>
                <Icon name="bell" size={17} strokeWidth={2} />
                {unread > 0 && <span className="unread-dot" aria-hidden="true" />}
            </button>
            {open && (
                <div className="menu-pop align-right notifications-pop" role="dialog" aria-label="Уведомления">
                    {items.length === 0 && <p className="muted small notifications-empty">Пока ничего не произошло — здесь появятся последние 20 событий.</p>}
                    {items.map(entry => {
                        const target = entry.targetIds?.[0];
                        return (
                            <button key={entry.id} type="button" className="menu-entry notification"
                                onClick={() => { setOpen(false); if (target) onOpenMember(target); else onOpenJournal(); }}>
                                <span>{describeAction(entry)}</span>
                                <Time iso={entry.createdAt} className="muted small" />
                            </button>
                        );
                    })}
                    <div className="menu-sep" role="separator" />
                    <button type="button" className="menu-entry" onClick={() => { setOpen(false); onOpenJournal(); }}>Весь журнал →</button>
                </div>
            )}
        </div>
    );
}
