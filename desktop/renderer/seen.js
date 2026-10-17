import { useCallback, useEffect, useMemo, useState } from 'react';

// Which newcomers this moderator has already looked at, per server, on this computer.
// The menu counter shows only the ones not seen yet, so a long queue put off for
// later doesn't keep shouting — a new arrival does.

const key = guildId => `panel.seen.${guildId}`;

/** null = never saved on this computer for this server */
function read(guildId) {
    try {
        const raw = localStorage.getItem(key(guildId));
        if (raw === null) return null;
        const list = JSON.parse(raw);
        return new Set(Array.isArray(list) ? list : []);
    } catch {
        return new Set();
    }
}

function write(guildId, set) {
    try { localStorage.setItem(key(guildId), JSON.stringify([...set])); } catch { /* per-machine convenience only */ }
}

/**
 * @param {{ guildId: string, items?: Array<{ member: { id: string } }>, error?: any } | null} waiting
 *   the waiting queue, tagged with the server it was loaded for
 */
export function useSeen(guildId, waiting) {
    // null until the first queue load on a computer that never saved this list
    const [seen, setSeen] = useState(() => (guildId ? read(guildId) : new Set()));
    useEffect(() => { setSeen(guildId ? read(guildId) : new Set()); }, [guildId]);

    const ids = useMemo(() => (waiting?.items || []).map(item => item.member.id), [waiting]);

    // Forget people who left the queue, so the list doesn't grow forever (only on a good load
    // of this server's queue). The very first time, everyone already waiting counts as seen:
    // only people who join from now on light the counter.
    useEffect(() => {
        if (!guildId || !waiting?.items || waiting.error || waiting.guildId !== guildId) return;
        const current = new Set(ids);
        setSeen(prev => {
            if (prev === null) {
                write(guildId, current);
                return current;
            }
            const next = new Set([...prev].filter(id => current.has(id)));
            if (next.size === prev.size) return prev;
            write(guildId, next);
            return next;
        });
    }, [guildId, waiting, ids]);

    const markSeen = useCallback(userIds => {
        if (!guildId) return;
        setSeen(prev => {
            if (prev && userIds.every(id => prev.has(id))) return prev;
            const next = new Set([...(prev || []), ...userIds]);
            write(guildId, next);
            return next;
        });
    }, [guildId]);

    const markAllSeen = useCallback(() => markSeen(ids), [markSeen, ids]);
    const isNew = useCallback(id => Boolean(seen) && !seen.has(id), [seen]);
    const newCount = seen ? ids.filter(id => !seen.has(id)).length : 0;

    return { isNew, newCount, markSeen, markAllSeen };
}
