import React from 'react';

/**
 * Group actions over the chosen people: «Выбрано N · Тимур, Новичок», the actions,
 * «Снять выделение». A strip above a table, or floating at the bottom (`floating`).
 * Shown only while something is chosen.
 */
export default function SelectionBar({ names, onClear, floating = false, escHint = false, children }) {
    if (names.length === 0) return null;
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` и ещё ${names.length - 3}` : '');
    return (
        <div className={`selection-bar ${floating ? 'is-floating' : ''}`} role="region" aria-label={`Выбрано ${names.length}`}>
            <strong className="numeric">Выбрано {names.length}</strong>
            <span className="selection-names">{shown}</span>
            <div className="selection-actions">
                {children}
                <button type="button" className="btn btn-quiet" onClick={onClear}>Снять выделение</button>
                {escHint && <kbd>Esc</kbd>}
            </div>
        </div>
    );
}
