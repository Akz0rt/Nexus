import React from 'react';

/**
 * The orange hexagon means one thing only: something is waiting for an action.
 * Plain counts are written as text; at 0 the badge is not shown at all.
 */
export function ActionBadge({ count, title }) {
    if (!count) return null;
    return <span className="action-badge" title={title}>{count}</span>;
}

/** A small flag: tone «danger» (risk), «warn», or neutral by default. */
export function Chip({ tone, title, children }) {
    return <span className={`chip-flag ${tone ? `chip-${tone}` : ''}`} title={title}>{children}</span>;
}

/** Rounded filter toggle with an optional count inside. */
export function FilterChip({ active, count, onClick, children }) {
    return (
        <button type="button" className="filter-chip" aria-pressed={Boolean(active)} onClick={onClick}>
            {children}{count !== undefined && count !== null && <span className="numeric"> · {count}</span>}
        </button>
    );
}

/** Outline in the status colour: «accent» (new, nobody took it), «ink» (in progress), «presence» (someone is looking). */
export function StatusPill({ tone = 'ink', title, children }) {
    return (
        <span className={`status-pill status-${tone}`} title={title}>
            {tone === 'presence' && <span className="status-dot" aria-hidden="true" />}
            {children}
        </span>
    );
}
