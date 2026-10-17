import React, { useEffect } from 'react';

/**
 * Modal shell shared by the voice dialogs: backdrop click and Escape close it,
 * Enter submits the form.
 */
export default function Dialog({ title, onClose, onSubmit, children, submitLabel, submitTone = 'primary', busy = false, wide = false }) {
    useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    const submit = event => {
        event.preventDefault();
        if (!busy) onSubmit?.();
    };

    return (
        <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <form className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
                <h2>{title}</h2>
                {children}
                <div className="dialog-actions">
                    <button type="button" className="btn btn-quiet" onClick={onClose}>Отмена</button>
                    {submitLabel && (
                        <button type="submit" className={`btn ${submitTone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}`} disabled={busy}>
                            {busy ? 'Выполняем…' : submitLabel}
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}
