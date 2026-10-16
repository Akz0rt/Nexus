import React from 'react';
import Avatar from './Avatar.jsx';

const ITEMS = [
    { id: 'queue', label: 'Пропуск' },
    { id: 'journal', label: 'Журнал' }
];

export default function Sidebar({ view, onView, waitingCount, presence, version }) {
    return (
        <aside className="sidebar">
            <div className="brand">
                <img src="./icon.png" alt="" width="28" height="28" />
                <span>Nexus</span>
            </div>
            <nav className="menu">
                {ITEMS.map(item => (
                    <button
                        key={item.id}
                        className={`menu-item ${view === item.id ? 'is-active' : ''}`}
                        aria-current={view === item.id ? 'page' : undefined}
                        onClick={() => onView(item.id)}
                    >
                        <span>{item.label}</span>
                        {item.id === 'queue' && waitingCount > 0 && <span className="counter">{waitingCount}</span>}
                    </button>
                ))}
            </nav>
            <section className="on-shift" aria-label="На смене">
                <h3>На смене</h3>
                {presence.length === 0 && <p className="muted small">Никого, кроме вас.</p>}
                <ul>
                    {presence.map(user => (
                        <li key={user.id}>
                            <Avatar src={user.avatarURL} name={user.displayName} size={22} />
                            <span>{user.displayName || user.id}</span>
                        </li>
                    ))}
                </ul>
            </section>
            {version && <div className="version muted small">Версия {version}</div>}
        </aside>
    );
}
