import React from 'react';
import Icon from './icons.jsx';
import { describeError, errorCode } from './api.js';

/** Nothing here yet: an icon, one line, maybe an action. */
export function EmptyState({ icon = 'inbox', title, text, action }) {
    return (
        <div className="state">
            <Icon name={icon} size={22} />
            <div className="state-text">
                <strong>{title}</strong>
                {text && <p className="muted">{text}</p>}
            </div>
            {action}
        </div>
    );
}

/**
 * A list failed to load: what didn't load, the reason in plain words, «Повторить».
 * The raw code goes into the tooltip for whoever is debugging.
 * `error` — what apiGet threw (or a ready-made text).
 */
export function ErrorState({ what = 'данные', error, onRetry }) {
    const reason = typeof error === 'string' ? error : describeError(error || {});
    const code = typeof error === 'string' ? null : errorCode(error);
    return (
        <div className="state state-error" role="alert" title={code ? `Код: ${code}` : undefined}>
            <Icon name="alert" size={22} />
            <div className="state-text">
                <strong>Не удалось загрузить {what}</strong>
                <p className="muted">{reason}</p>
            </div>
            {onRetry && (
                <button type="button" className="btn" onClick={onRetry}>
                    <Icon name="retry" size={16} />Повторить
                </button>
            )}
        </div>
    );
}

/** Grey placeholder rows while loading, same height as the real ones. */
export function Skeleton({ rows = 3, height = 52 }) {
    return (
        <div className="skeleton" aria-busy="true" aria-label="Загружаем">
            {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" style={{ height }} />)}
        </div>
    );
}
