import React from 'react';
import Avatar from './Avatar.jsx';
import Icon from './icons.jsx';
import { ActionBadge } from './Chips.jsx';

const GROUPS = [
    { label: 'Каждый день', items: [
        { id: 'overview', label: 'Обзор' },
        { id: 'queue', label: 'Пропуск' },
        { id: 'voice', label: 'Голосовые' },
        { id: 'moderation', label: 'Модерация' }
    ] },
    { label: 'Сообщество', items: [
        { id: 'roles', label: 'Роли', needs: 'roles' },
        { id: 'events', label: 'Ивенты' },
        { id: 'birthdays', label: 'Дни рождения' },
        { id: 'economy', label: 'Экономика' },
        { id: 'banner', label: 'Баннер', needs: 'settings' }
    ] },
    { label: 'Данные', items: [
        { id: 'activity', label: 'Активность' },
        { id: 'stats', label: 'Статистика' },
        { id: 'journal', label: 'Журнал' }
    ] },
    { label: 'Сервер', items: [
        { id: 'settings', label: 'Настройки', needs: 'settings' }
    ] }
];

// The version line: what the updater is doing; a click checks again (or restarts into a ready one)
const UPDATE_LINE = {
    idle: () => 'проверить обновления',
    checking: () => 'проверяем…',
    downloading: s => `скачиваем ${s.version} — ${s.percent || 0}%`,
    ready: s => <span className="version-update">{s.version} готова — перезапустить</span>,
    latest: () => 'последняя версия',
    error: () => 'не удалось проверить',
    dev: () => 'обновления — только в установленной версии'
};

export default function Sidebar({ view, onView, waitingCount, newCount, openReports, canRoles, canSettings, presence, version, updateState, onCheckUpdates }) {
    const allowed = item => (item.needs !== 'roles' || canRoles) && (item.needs !== 'settings' || canSettings);
    // The hexagon only where someone waits for an action
    const badge = id => {
        if (id === 'queue') return <ActionBadge count={waitingCount} title={`Ждут пропуска: ${waitingCount}${newCount ? ` · новых: ${newCount}` : ''}`} />;
        if (id === 'moderation') return <ActionBadge count={openReports} title={`Новых жалоб: ${openReports}`} />;
        return null;
    };
    return (
        <aside className="sidebar">
            <div className="brand">
                <img src="./icon.png" alt="" width="28" height="28" />
                <span>Nexus</span>
            </div>
            <nav className="menu" aria-label="Разделы">
                {GROUPS.map(group => {
                    const items = group.items.filter(allowed);
                    if (items.length === 0) return null;
                    return (
                        <div key={group.label} className="menu-group">
                            <span className="menu-label">{group.label}</span>
                            {items.map(item => (
                                <button
                                    key={item.id}
                                    className={`menu-item ${view === item.id ? 'is-active' : ''}`}
                                    aria-current={view === item.id ? 'page' : undefined}
                                    onClick={() => onView(item.id)}
                                >
                                    <Icon name={item.id} />
                                    <span className="menu-text">{item.label}</span>
                                    {badge(item.id)}
                                </button>
                            ))}
                        </div>
                    );
                })}
            </nav>
            <section className="on-shift" aria-label="На смене">
                <span className="menu-label">На смене</span>
                {presence.length === 0 ? (
                    <p className="on-shift-names">Никого, кроме вас</p>
                ) : (
                    <div className="on-shift-row" title={presence.map(user => user.displayName || user.id).join(', ')}>
                        <span className="avatar-stack">
                            {presence.slice(0, 4).map(user => <Avatar key={user.id} id={user.id} src={user.avatarURL} name={user.displayName} size={22} />)}
                        </span>
                        <span className="on-shift-names">{presence.map(user => user.displayName || user.id).join(', ')}</span>
                    </div>
                )}
                {version && (
                    <button type="button" className={`version version-${updateState?.status || 'idle'}`} onClick={() => (updateState?.status === 'ready' ? window.panel.installUpdate() : onCheckUpdates())}
                        title={updateState?.status === 'error' ? `Не удалось проверить: ${updateState.error || ''}` : updateState?.status === 'ready' ? 'Перезапустить и обновить' : 'Проверить обновления'}>
                        v{version} · {UPDATE_LINE[updateState?.status || 'idle'](updateState || {})}
                    </button>
                )}
            </section>
        </aside>
    );
}
