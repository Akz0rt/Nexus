import React from 'react';
import { FAILURE_LABELS } from './format.js';

/** «Bob — не в голосе» for the first member a task couldn't handle */
export function firstFailure(item) {
    const failure = item.failed?.[0];
    if (!failure) return null;
    return `${failure.name || failure.userId} — ${FAILURE_LABELS[failure.code] || failure.code}`;
}

/**
 * Background group actions, bottom right above the selection bar: name, «5 / 6»,
 * a progress bar, the first failure, «Отменить всё» and «Повторить для неудачных».
 * items: [{ key, title, total, processed, failedCount, failed, status, note, canRevert, canRetry }]
 */
export default function TaskTray({ items, onRevert, onRetry, onClose }) {
    if (items.length === 0) return null;
    return (
        <div className="task-tray" aria-label="Фоновые задачи">
            {items.map(item => {
                const percent = item.total ? Math.min(100, Math.round((item.processed / item.total) * 100)) : 100;
                const running = item.status === 'running';
                const failure = firstFailure(item);
                return (
                    <section key={item.key} className={`task ${running ? 'is-running' : 'is-done'}`} role="status" aria-live="polite">
                        <div className="task-head">
                            <strong>{item.title}</strong>
                            <span className="muted small numeric">{item.processed} / {item.total}</span>
                            {!running && <button type="button" className="task-close" aria-label="Скрыть" onClick={() => onClose(item)}>×</button>}
                        </div>
                        <div className="task-progress" aria-hidden="true">
                            <div className={item.failedCount ? 'has-failures' : ''} style={{ width: `${percent}%` }} />
                        </div>
                        {(failure || item.note || item.status === 'cancelled' || item.canRevert || item.canRetry) && (
                            <div className="task-foot">
                                <span className="task-note">
                                    {failure && <span className="task-error">{failure}{item.failedCount > 1 ? ` · ещё ${item.failedCount - 1}` : ''}</span>}
                                    {!failure && item.status === 'cancelled' && <span className="muted">Остановлено</span>}
                                    {!failure && item.note && <span className="muted">{item.note}</span>}
                                </span>
                                {item.canRevert && <button type="button" className="link-button" onClick={() => onRevert(item)}>Отменить всё</button>}
                                {item.canRetry && !running && <button type="button" className="link-button" onClick={() => onRetry(item)}>Повторить для неудачных</button>}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
