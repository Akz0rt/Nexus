import React from 'react';

export default function Toasts({ toasts, onDismiss }) {
    return (
        <div className="toasts" role="status" aria-live="polite">
            {toasts.map(t => (
                <div key={t.id} className={`toast ${t.tone ? `toast-${t.tone}` : ''}`}>
                    <span>{t.text}</span>
                    {(t.actions || (t.action ? [t.action] : [])).map((action, index) => (
                        <button key={action.label} className={`btn btn-quiet ${index > 0 ? 'toast-more' : ''}`}
                            onClick={() => { action.onClick(); onDismiss(t.id); }}>
                            {action.label}
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}
