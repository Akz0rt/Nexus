import React from 'react';
import { formatDateTime, timeAgo } from './format.js';

/** «12 мин назад» on screen, «18.10.26, 21:33» in the tooltip. */
export default function Time({ iso, children, className }) {
    if (!iso) return <span className={className}>—</span>;
    return (
        <time className={className} dateTime={iso} title={formatDateTime(iso)}>
            {children ?? timeAgo(iso)}
        </time>
    );
}
