import React from 'react';

const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const timeOf = iso => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Seven days from today; today is outlined, events are coloured chips «00:34 Мафия».
 * events: [{ id, title, startsAt, tone }]; onPick(id) scrolls to the event's card.
 */
export default function WeekStrip({ events, onPick }) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS));
    const byDay = new Map();
    for (const event of events) {
        const key = dayKey(new Date(event.startsAt));
        byDay.set(key, [...(byDay.get(key) || []), event]);
    }
    return (
        <ol className="week-strip" aria-label="Ивенты на неделю">
            {days.map((day, index) => {
                const label = day.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' });
                const list = byDay.get(dayKey(day)) || [];
                return (
                    <li key={day.toISOString()} className={`week-day ${index === 0 ? 'is-today' : ''}`}>
                        <span className="week-day-label">{label.charAt(0).toUpperCase() + label.slice(1)}{index === 0 && ' · сегодня'}</span>
                        {list.map(event => (
                            <button key={event.id} type="button" className={`week-chip tone-${event.tone}`} onClick={() => onPick(event.id)}
                                title={`${timeOf(event.startsAt)} ${event.title}`}>
                                <span className="numeric">{timeOf(event.startsAt)}</span> {event.title}
                            </button>
                        ))}
                    </li>
                );
            })}
        </ol>
    );
}
