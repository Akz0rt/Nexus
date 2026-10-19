import React from 'react';

/** «вс, 19 октября в 21:00» as Discord's <t:…:F> shows it, in the moderator's own time */
function fullTime(date) {
    return date.toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * What the card will look like in Discord: the role ping above it, the embed,
 * «Иду» / «Не иду». Mentions show as Discord draws them.
 */
export default function EventPreview({ title, description, startsAt, durationMinutes, voiceChannel, role, repeatWeekly }) {
    const start = new Date(startsAt);
    const valid = !Number.isNaN(start.getTime());
    const end = valid && durationMinutes ? new Date(start.getTime() + durationMinutes * 60000) : null;
    return (
        <div className="event-preview" aria-label="Так карточка будет выглядеть в Discord">
            <span className="event-preview-caption">Так будет в Discord</span>
            {role && <span className="discord-mention">@{role.name}</span>}
            <div className="discord-embed">
                <strong className="discord-embed-title">{title.trim() || 'Название ивента'}</strong>
                {description.trim() && <p className="discord-embed-text">{description}</p>}
                <div className="discord-field">
                    <span>Когда</span>
                    <p>
                        {valid ? fullTime(start) : '—'}
                        {end && `–${end.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                    </p>
                </div>
                <div className="discord-fields-inline">
                    {voiceChannel && <div className="discord-field"><span>Где</span><p><span className="discord-mention">🔊 {voiceChannel.name}</span></p></div>}
                    {repeatWeekly && <div className="discord-field"><span>Повтор</span><p>каждую неделю</p></div>}
                </div>
                <div className="discord-field"><span>Идут · 0</span><p>пока никого</p></div>
            </div>
            <div className="discord-buttons">
                <span className="discord-button is-success">Иду</span>
                <span className="discord-button">Не иду</span>
            </div>
        </div>
    );
}
