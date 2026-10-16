import React, { useCallback, useEffect, useState } from 'react';
import { apiGet } from './api.js';
import Queue from './Queue.jsx';
import Journal from './Journal.jsx';

const STREAM_LABEL = { open: 'в сети', connecting: 'подключение…', error: 'переподключение…', closed: 'отключено' };

export default function App() {
    const [auth, setAuth] = useState(null); // null = loading
    const [authError, setAuthError] = useState(null);
    const [me, setMe] = useState(null);
    const [guilds, setGuilds] = useState([]);
    const [guildId, setGuildId] = useState(null);
    const [tab, setTab] = useState('queue');
    const [streamState, setStreamState] = useState('closed');
    const [revision, setRevision] = useState(0); // bumps on every live event
    const [liveEvents, setLiveEvents] = useState([]);

    useEffect(() => {
        window.panel.status().then(setAuth);
        const offAuth = window.panel.onAuthChanged(state => { setAuthError(null); setAuth(prev => ({ ...prev, ...state })); });
        const offError = window.panel.onAuthError(({ message }) => setAuthError(message));
        return () => { offAuth(); offError(); };
    }, []);

    // After login: who am I + which servers
    useEffect(() => {
        if (!auth?.loggedIn) { setMe(null); setGuilds([]); setGuildId(null); return; }
        Promise.all([apiGet('/me'), apiGet('/guilds')])
            .then(([meData, guildData]) => {
                setMe(meData.user);
                setGuilds(guildData.guilds);
                setGuildId(current => current || guildData.guilds[0]?.id || null);
            })
            .catch(error => setAuthError(`Не удалось загрузить данные: ${error.message}`));
    }, [auth?.loggedIn]);

    // Live events of the selected server
    useEffect(() => {
        setLiveEvents([]);
        window.panel.subscribe(guildId);
        const offEvent = window.panel.onEvent(({ guildId: id, event, data }) => {
            if (id !== guildId || event !== 'audit') return;
            setLiveEvents(list => [data, ...list].slice(0, 200));
            setRevision(r => r + 1);
        });
        const offState = window.panel.onStreamState(({ guildId: id, state }) => { if (id === guildId) setStreamState(state); });
        return () => { offEvent(); offState(); };
    }, [guildId]);

    const logout = useCallback(() => window.panel.logout(), []);

    if (!auth) return <div className="center">Загрузка…</div>;

    if (!auth.loggedIn) {
        return (
            <div className="center login">
                <h1>BirthdayBot Panel</h1>
                <p>Вход через Discord откроется в браузере.</p>
                <button className="primary" onClick={() => window.panel.login()}>Войти через Discord</button>
                {authError && <p className="error">{authError}</p>}
                <p className="muted small">Сервер: {auth.apiUrl}</p>
            </div>
        );
    }

    return (
        <div className="layout">
            <header>
                <select value={guildId || ''} onChange={e => setGuildId(e.target.value)}>
                    {guilds.length === 0 && <option value="">Нет серверов с доступом</option>}
                    {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <nav>
                    <button className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>Пропуск</button>
                    <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>Журнал</button>
                </nav>
                <span className={`status ${streamState}`}>● {STREAM_LABEL[streamState]}</span>
                {me && <span className="me">{me.globalName || me.username}</span>}
                <button onClick={logout}>Выйти</button>
            </header>
            {authError && <p className="error">{authError}</p>}
            <main>
                {!guildId && <p className="muted">Бот не найден ни на одном сервере, где у вас есть права модератора.</p>}
                {guildId && tab === 'queue' && <Queue guildId={guildId} revision={revision} />}
                {guildId && tab === 'journal' && <Journal guildId={guildId} liveEvents={liveEvents} />}
            </main>
        </div>
    );
}
