import React from 'react';

export default function Avatar({ src, name, size = 32 }) {
    const style = { width: size, height: size };
    if (src) return <img className="avatar" style={style} src={src} alt="" />;
    return (
        <span className="avatar avatar-fallback" style={{ ...style, fontSize: size * 0.42 }} aria-hidden="true">
            {(name || '?').slice(0, 1).toUpperCase()}
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
