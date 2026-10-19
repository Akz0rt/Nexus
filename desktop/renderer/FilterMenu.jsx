import React, { useEffect, useRef } from 'react';

/** A filter chip that opens a short list (Инвайт ▾, Когда зашли ▾); Esc and a click outside close it. */
export default function FilterMenu({ label, active, open, onToggle, onClose, children }) {
    const rootRef = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        rootRef.current?.querySelector('[role^="menuitem"]')?.focus();
        const onDown = event => { if (!rootRef.current?.contains(event.target)) onClose(); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const onKeyDown = event => {
        const entries = [...rootRef.current.querySelectorAll('[role^="menuitem"]')];
        const index = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); rootRef.current.querySelector('.filter-chip')?.focus(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
    };
    return (
        <div className="overflow" ref={rootRef}>
            <button type="button" className="filter-chip" aria-pressed={active} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>{label} ▾</button>
            {open && <div role="menu" className="menu-pop align-left" onKeyDown={onKeyDown}>{children}</div>}
        </div>
    );
}
