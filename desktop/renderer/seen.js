import { useCallback, useEffect, useMemo, useState } from 'react';

// Which newcomers this moderator has already looked at, per server, on this computer.
// The menu counter shows only the ones not seen yet, so a long queue put off for
// later doesn't keep shouting — a new arrival does.

const key = guildId => `panel.seen.${guildId}`;

function read(guildId) {
    try {
        const list = JSON.parse(localStorage.getItem(key(guildId)) || '[]');
        return new Set(Array.isArray(list) ? list : []);
    } catch {
        return new Set();
    }
}

function write(guildId, set) {
    try { localStorage.setItem(key(guildId), JSON.stringify([...set])); } catch { /* per-machine convenience only */ }
}

/** @param {{ items?: Array<{ member: { id: string } }>, error?: any } | null} waiting the waiting queue */
export function useSeen(guildId, waiting) {
    const [seen, setSeen] = useState(() => (guildId ? read(guildId) : new Set()));
    useEffect(() => { setSeen(guildId ? read(guildId) : new Set()); }, [guildId]);

    const ids = useMemo(() => (waiting?.items || []).map(item => item.member.id), [waiting]);

    // Forget people who left the queue, so the list doesn't grow forever (only on a good load)
    useEffect(() => {
        if (!guildId || !waiting?.items || waiting.error) return;
        const current = new Set(ids);
        setSeen(prev => {
            const next = new Set([...prev].filter(id => current.has(id)));
            if (next.size === prev.size) return prev;
            write(guildId, next);
            return next;
        });
    }, [guildId, waiting, ids]);

    const markSeen = useCallback(userIds => {
        if (!guildId) return;
        setSeen(prev => {
            if (userIds.every(id => prev.has(id))) return prev;
            const next = new Set([...prev, ...userIds]);
            write(guildId, next);
            return next;
        });
    }, [guildId]);

    const markAllSeen = useCallback(() => markSeen(ids), [markSeen, ids]);
    const isNew = useCallback(id => !seen.has(id), [seen]);
    const newCount = ids.filter(id => !seen.has(id)).length;

    return { isNew, newCount, markSeen, markAllSeen };
}
