import { useEffect, useRef, useState } from 'react';

/**
 * The one way to pick people in a list: click, Ctrl-click, Shift-click, a rubber band
 * dragged with the mouse, Ctrl+A, Esc. Rows carry `data-select="<id>"`; the list's
 * container gets `listRef` and `onMouseDown={startMarquee}`.
 * @param {string[]} ids rows in the order shown
 * @param {{ paused?: boolean }} options paused — a dialog is open, keys belong to it
 */
export default function useSelection(ids, { paused = false } = {}) {
    const [selected, setSelected] = useState(() => new Set());
    const [anchor, setAnchor] = useState(null);
    const [marquee, setMarquee] = useState(null);
    const listRef = useRef(null);
    // Rows that left the list (decided, role taken away) drop out of the choice
    const chosen = ids.filter(id => selected.has(id));

    const clear = () => setSelected(new Set());

    const toggle = id => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
        setAnchor(id);
    };

    const click = (event, id) => {
        if (event.detail > 1) return;
        if (event.shiftKey && anchor && ids.includes(anchor)) {
            const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b);
            setSelected(prev => new Set([...(event.ctrlKey ? prev : []), ...ids.slice(from, to + 1)]));
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            toggle(id);
            return;
        }
        setSelected(prev => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
        setAnchor(id);
    };

    useEffect(() => {
        if (paused) return undefined;
        const onKey = event => {
            if (event.target.closest?.('input, select, textarea, [role="dialog"], [role="menu"]')) return;
            if (event.key === 'Escape' && selected.size) setSelected(new Set());
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                setSelected(new Set(ids));
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [paused, ids.join(','), selected.size]); // eslint-disable-line react-hooks/exhaustive-deps

    const startMarquee = event => {
        if (event.button !== 0 || event.target.closest('[data-select], button, input, a, select')) return;
        event.preventDefault();
        const base = event.shiftKey ? new Set(selected) : new Set();
        const start = { x: event.clientX, y: event.clientY };
        let moved = false;
        const onMove = e => {
            const rect = {
                left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY),
                right: Math.max(start.x, e.clientX), bottom: Math.max(start.y, e.clientY)
            };
            if (!moved && rect.right - rect.left < 4 && rect.bottom - rect.top < 4) return;
            moved = true;
            setMarquee(rect);
            const hits = [...listRef.current.querySelectorAll('[data-select]')].filter(el => {
                const r = el.getBoundingClientRect();
                return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
            }).map(el => el.dataset.select);
            setSelected(new Set([...base, ...hits]));
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setMarquee(null);
            if (!moved && !event.shiftKey) setSelected(new Set());
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    return { selected, chosen, setSelected, click, toggle, clear, startMarquee, marquee, listRef };
}

/** The rubber band itself; render it once while `marquee` is set. */
export function marqueeStyle(marquee) {
    return { left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top };
}
