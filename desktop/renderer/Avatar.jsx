import React from 'react';

// Fallback colours: a person keeps the same one everywhere (picked from the ID, or the name)
const COLORS = [
    ['#5865f2', '#ffffff'], ['#e84393', '#ffffff'], ['#3ccf8e', '#0f1218'], ['#ffb020', '#0f1218'],
    ['#ff5d5d', '#0f1218'], ['#2ec4ff', '#0f1218'], ['#a78bfa', '#0f1218'], ['#f97316', '#0f1218']
];

function colorOf(key) {
    let hash = 0;
    for (const char of String(key || '?')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return COLORS[hash % COLORS.length];
}

// Discord's stock avatar (the same blob for everyone) is shown as initials instead
const isStock = src => /\/embed\/avatars\//.test(src);

export default function Avatar({ src, name, id, size = 32 }) {
    const style = { width: size, height: size };
    if (src && !isStock(src)) return <img className="avatar" style={style} src={src} alt="" />;
    const [background, color] = colorOf(id || name);
    return (
        <span className="avatar avatar-fallback" style={{ ...style, background, color, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
            {([...String(name || '').trim()][0] || '?').toUpperCase()}
        </span>
    );
}

/** Clickable name that opens the member drawer */
export function MemberLink({ id, name, onOpen }) {
    if (!id) return <span className="muted">бот</span>;
    return (
        <button type="button" className="member-link" onClick={() => onOpen(id)}>
            {name || id}
        </button>
    );
}
