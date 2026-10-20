import React, { useState } from 'react';

function shortDate(date) {
    const [, month, day] = date.split('-');
    return `${Number(day)}.${month}`;
}

/** 0, the middle and the top of the axis, rounded to readable steps */
function ticksFor(max) {
    const raw = max / 2;
    const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= raw) || raw;
    const whole = Math.max(1, step); // counts and minutes: no «0,5»
    return [0, whole, whole * 2];
}

/**
 * Bars per day with a three-tick Y axis and a hover tooltip.
 * One measure per chart; `parts` of the same unit stack (e.g. passed + kicked),
 * each a { key, label, tone, valueOf } — with two or more a legend names them.
 * series: [{ date: 'YYYY-MM-DD', ... }]
 */
export default function DailyBars({ title, series, parts, format = n => n.toLocaleString('ru-RU'), tickFormat = format, markToday = false }) {
    const [hover, setHover] = useState(null);
    if (!series?.length) return null;
    const totalOf = d => parts.reduce((sum, part) => sum + part.valueOf(d), 0);
    const ticks = ticksFor(Math.max(1, ...series.map(totalOf)));
    const top = ticks[2];
    const total = series.reduce((sum, d) => sum + totalOf(d), 0);
    const today = series[series.length - 1];
    // «Сутки»: the week for context, today's bar marked and its value in the caption
    const caption = markToday
        ? `сегодня: ${format(totalOf(today))} · за 7 дней: ${format(total)}`
        : `за ${series.length} дн.: ${format(total)}`;
    return (
        <figure className="daily-chart">
            <figcaption>
                <strong>{title}</strong>
                <span className="muted small">{caption}</span>
            </figcaption>
            {parts.length > 1 && (
                <div className="daily-legend small">
                    {parts.map(part => <span key={part.key}><i className={`daily-swatch daily-${part.tone}`} aria-hidden="true" />{part.label}</span>)}
                </div>
            )}
            <div className="daily-frame">
                <div className="daily-ticks muted small numeric" aria-hidden="true">
                    {[...ticks].reverse().map(tick => <span key={tick}>{tickFormat(tick)}</span>)}
                </div>
                <div className="daily-plot" role="img" aria-label={`${title}: ${caption}`} onMouseLeave={() => setHover(null)}>
                    <div className="daily-grid" aria-hidden="true"><span /><span /><span /></div>
                    <div className="daily-bars">
                        {series.map((d, i) => (
                            <div key={d.date} className={`daily-col ${hover === i ? 'is-hover' : ''} ${markToday && d === today ? 'is-today' : ''}`} onMouseEnter={() => setHover(i)}>
                                <div className="daily-stack" style={{ height: `${(totalOf(d) / top) * 100}%` }}>
                                    {[...parts].reverse().map(part => {
                                        const value = part.valueOf(d);
                                        return value ? <div key={part.key} className={`daily-bar daily-${part.tone}`} style={{ flexGrow: value }} /> : null;
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                    {hover !== null && (
                        <div className="daily-tip" style={{ left: `${((hover + 0.5) / series.length) * 100}%` }} role="status">
                            <span className="muted small">{shortDate(series[hover].date)}</span>
                            {parts.length === 1
                                ? <strong className="numeric">{format(parts[0].valueOf(series[hover]))}</strong>
                                : parts.map(part => (
                                    <span key={part.key} className="daily-tip-row">
                                        <i className={`daily-swatch daily-${part.tone}`} aria-hidden="true" />{part.label}
                                        <strong className="numeric">{format(part.valueOf(series[hover]))}</strong>
                                    </span>
                                ))}
                        </div>
                    )}
                </div>
                <span aria-hidden="true" />
                <div className="daily-axis muted small numeric">
                    <span>{shortDate(series[0].date)}</span>
                    <span>{shortDate(series[series.length - 1].date)}</span>
                </div>
            </div>
        </figure>
    );
}
