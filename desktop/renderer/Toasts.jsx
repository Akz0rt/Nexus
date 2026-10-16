import React from 'react';

export default function Toasts({ toasts, onDismiss }) {
    return (
        <div className="toasts" role="status" aria-live="polite">
            {toasts.map(t => (
                <div key={t.id} className={`toast ${t.tone ? `toast-${t.tone}` : ''}`}>
                    <span>{t.text}</span>
                    {t.action && (
                        <button className="btn btn-quiet" onClick={() => { t.action.onClick(); onDismiss(t.id); }}>
                            {t.action.label}
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}
