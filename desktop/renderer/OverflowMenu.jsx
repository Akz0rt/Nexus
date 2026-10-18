import React, { useEffect, useRef, useState } from 'react';
import { DotsIcon } from './icons.jsx';

/**
 * «⋯» with the actions that don't fit on the row. Ordinary items first, then a line,
 * then the ones that reject or destroy (`end: true`; `danger: true` paints them red).
 * items: [{ label, onSelect, end?, danger?, disabled? }]
 */
export default function OverflowMenu({ items, label, align = 'right' }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const buttonRef = useRef(null);
    const listRef = useRef(null);
    const shown = items.filter(Boolean);
    const main = shown.filter(item => !item.end);
    const end = shown.filter(item => item.end);

    useEffect(() => {
        if (!open) return undefined;
        listRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
        const onDown = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const close = () => { setOpen(false); buttonRef.current?.focus(); };

    const onKeyDown = event => {
        const entries = [...(listRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];
        const index = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
        if (event.key === 'Tab') setOpen(false);
    };

    const choose = item => { setOpen(false); buttonRef.current?.focus(); item.onSelect(); };
    const entry = item => (
        <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
            className={`menu-entry ${item.danger ? 'is-danger' : ''}`} onClick={() => choose(item)}>
            {item.label}
        </button>
    );

    if (shown.length === 0) return null;
    return (
        <div className="overflow" ref={rootRef}>
            <button ref={buttonRef} type="button" className="icon-button" aria-haspopup="menu" aria-expanded={open}
                aria-label={label || `Ещё: ${shown.map(item => item.label).join(', ')}`} onClick={() => setOpen(o => !o)}>
                <DotsIcon />
            </button>
            {open && (
                <div ref={listRef} role="menu" className={`menu-pop align-${align}`} onKeyDown={onKeyDown}>
                    {main.map(entry)}
                    {main.length > 0 && end.length > 0 && <div className="menu-sep" role="separator" />}
                    {end.map(entry)}
                </div>
            )}
        </div>
    );
}
