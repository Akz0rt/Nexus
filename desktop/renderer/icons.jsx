import React from 'react';

// Line icons, 24×24, drawn with currentColor (paths from docs/redesign-v2/mockups/dc-source/Sidebar.dc.html)
const PATHS = {
    overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    queue: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM16 11l2 2 4-4',
    voice: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
    moderation: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    roles: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
    events: 'M3 4h18v17H3zM16 2v4M8 2v4M3 10h18',
    birthdays: 'M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7S10 3 7.5 3a2.5 2.5 0 0 0 0 4H12zM12 7s2-4 4.5-4a2.5 2.5 0 0 1 0 4H12z',
    economy: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2',
    activity: 'M3 3v18h18M7 14l4-4 4 4 5-6',
    stats: 'M18 20V10M12 20V4M6 20v-6',
    journal: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
    banner: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6M15.5 8.5h.01',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
    lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
    chevron: 'M6 9l6 6 6-6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    retry: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
    close: 'M18 6L6 18M6 6l12 12'
};

export default function Icon({ name, size = 18, strokeWidth = 1.8, className }) {
    return (
        <svg className={className} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
            <path d={PATHS[name]} />
        </svg>
    );
}

/** «⋯» — three filled dots */
export function DotsIcon({ size = 16 }) {
    return (
        <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
    );
}
