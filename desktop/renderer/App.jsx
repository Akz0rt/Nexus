import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';
import QueueView from './QueueView.jsx';
import JournalView from './JournalView.jsx';
import ModerationView from './ModerationView.jsx';
import VoiceView from './VoiceView.jsx';
import RolesView from './RolesView.jsx';
import OverviewView from './OverviewView.jsx';
import StatsView from './StatsView.jsx';
import SettingsView from './SettingsView.jsx';
import { LockdownBanner } from './LockdownButton.jsx';
import { playChime } from './sound.js';
import { useSeen } from './seen.js';
import MemberDrawer from './MemberDrawer.jsx';
import Toasts from './Toasts.jsx';

const THEME_KEY = 'panel.theme';

function readTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export default function App() {
    const [auth, setAuth] = useState(null); // null while loading
    const [authError, setAuthError] = useState(null);
    const [me, setMe] = useState(null);
    const [guilds, setGuilds] = useState([]);
    const [guildId, setGuildId] = useState(null);
    const [view, setView] = useState('overview');
    const [drawerUserId, setDrawerUserId] = useState(null);
    const [streamState, setStreamState] = useState('closed');
    const [presence, setPresence] = useState([]);
    const [revision, setRevision] = useState(0); // bumps on every live event
    const [voiceRevision, setVoiceRevision] = useState(0); // bumps on every voice-board change
    const [liveEvents, setLiveEvents] = useState([]);
    const [waiting, setWaiting] = useState(null); // waiting queue, shared by sidebar counter and queue view
    const [toasts, setToasts] = useState([]);
    const [update, setUpdate] = useState(null);
    const [theme, setTheme] = useState(readTheme);
    const [roleJob, setRoleJob] = useState(null); // running or last mass role change
    const [lockdown, setLockdown] = useState(null);
    const [journalPreset, setJournalPreset] = useState(null); // filters to open the journal with
    const toastSeq = useRef(0);
    const dismissedJob = useRef(null);

    const toast = useCallback((text, options = {}) => {
        const id = ++toastSeq.current;
        setToasts(list => [...list, { id, text, ...options }]);
        setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), options.ttl || 5000);
        return id;
    }, []);
    const dismissToast = useCallback(id => setToasts(list => list.filter(t => t.id !== id)), []);

    // A closed "done" bar stays closed; a late snapshot never rolls a finished job back
    const updateJob = useCallback(next => {
        if (!next) {
            setRoleJob(current => { dismissedJob.current = current?.id || null; return null; });
            return;
        }
        if (next.id === dismissedJob.current && next.status === 'done') return;
        setRoleJob(current => (current?.id === next.id && current.status === 'done' && next.status !== 'done' ? current : next));
    }, []);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* per-viewer convenience only */ }
    }, [theme]);

    useEffect(() => {
        window.panel.status().then(setAuth);
        const offs = [
            window.panel.onAuthChanged(state => { setAuthError(null); setAuth(prev => ({ ...prev, ...state })); }),
            window.panel.onAuthError(({ message }) => setAuthError(message)),
            window.panel.onNavigate(({ view: next }) => setView(next)),
            window.panel.onUpdateReady(info => setUpdate(info))
        ];
        return () => offs.forEach(off => off());
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
            .catch(error => setAuthError(error.error === 'bot_offline'
                ? 'Бот сейчас не в сети. Попробуйте через минуту.'
                : `Не удалось загрузить данные: ${error.message}`));
    }, [auth?.loggedIn]);

    // Live events of the selected server
    useEffect(() => {
        setLiveEvents([]);
        setPresence([]);
        setDrawerUserId(null);
        setRoleJob(null);
        window.panel.subscribe(guildId);
        const offEvent = window.panel.onEvent(({ guildId: id, event, data }) => {
            if (id !== guildId) return;
            if (event === 'presence') setPresence(data.users);
            if (event === 'audit') {
                setLiveEvents(list => [data, ...list].slice(0, 300));
                if (data.action === 'verification.queued') {
                    window.panel.getSettings().then(prefs => { if (prefs.sound) playChime(); }).catch(() => {});
                }
                // Message edits and deletes are frequent and change nothing on the other screens
                if (!data.action?.startsWith('message.')) setRevision(r => r + 1);
            }
            if (event === 'voice') setVoiceRevision(r => r + 1);
            if (event === 'job') updateJob(data);
        });
        const offState = window.panel.onStreamState(({ guildId: id, state }) => { if (id === guildId) setStreamState(state); });
        return () => { offEvent(); offState(); };
    }, [guildId, updateJob]);

    // My own mass role change finished: say how it went, even on another screen
    const announcedJob = useRef(null);
    useEffect(() => {
        if (!roleJob || roleJob.status !== 'done' || roleJob.actorId !== me?.id || announcedJob.current === roleJob.id) return;
        announcedJob.current = roleJob.id;
        const done = roleJob.doneCount ?? roleJob.processed - roleJob.failedCount;
        const text = `${roleJob.add ? 'Выдано' : 'Снято'} «${roleJob.roleName}»: ${done} из ${roleJob.total}`
            + (roleJob.failedCount ? ` · не удалось ${roleJob.failedCount}` : '');
        const retryIds = roleJob.failedIds || [];
        toast(text, roleJob.failedCount ? {
            tone: 'error',
            ttl: 10000,
            action: retryIds.length ? {
                label: 'Повторить для неудачных',
                onClick: async () => {
                    const result = await apiPost(`/guilds/${roleJob.guildId}/roles/jobs`, {
                        roleId: roleJob.roleId, add: roleJob.add, filter: { type: 'users', userIds: retryIds }
                    });
                    if (result.ok) updateJob(result.data.job);
                    else toast(describeError(result), { tone: 'error' });
                }
            } : undefined
        } : {});
    }, [roleJob, me?.id, toast, updateJob]);

    // Waiting queue: drives the sidebar counter and the "Ждут" tab
    const [reloadWaiting, setReloadWaiting] = useState(0);
    useEffect(() => {
        if (!guildId) { setWaiting(null); return; }
        let cancelled = false;
        apiGet(`/guilds/${guildId}/queue?tab=waiting`)
            .then(data => { if (!cancelled) setWaiting({ items: data.items, reservedRoleIds: data.reservedRoleIds || [] }); })
            .catch(error => { if (!cancelled) setWaiting({ items: [], error }); });
        return () => { cancelled = true; };
    }, [guildId, revision, reloadWaiting]);

    const seen = useSeen(guildId, waiting);

    // Lockdown: everyone sees the banner, administrators get the button
    useEffect(() => {
        if (!guildId) { setLockdown(null); return; }
        let cancelled = false;
        apiGet(`/guilds/${guildId}/lockdown`)
            .then(data => { if (!cancelled) setLockdown(data); })
            .catch(() => { if (!cancelled) setLockdown(null); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

    const openJournal = useCallback(filters => {
        setJournalPreset({ ...filters, nonce: Date.now() });
        setView('journal');
    }, []);

    if (!auth) return <div className="splash" />;

    if (!auth.loggedIn) {
        return (
            <div className="login">
                <div className="login-pass">
                    <img src="./icon.png" alt="" width="72" height="72" />
                    <h1>Nexus</h1>
                    <p>Панель модераторов сервера: очередь новичков, голосовые каналы, наказания, журнал действий и карточки участников.</p>
                    <button className="btn btn-primary btn-large" onClick={() => window.panel.login()}>Войти через Discord</button>
                    <p className="muted small">Вход откроется в браузере, затем вернёт вас сюда.</p>
                    {authError && <p className="error">{authError}</p>}
                </div>
            </div>
        );
    }

    const guild = guilds.find(g => g.id === guildId) || null;
    const senior = guild?.panelRole === 'senior';

    return (
        <div className="shell">
            <Sidebar
                view={view}
                onView={setView}
                waitingCount={waiting?.items?.length ?? null}
                newCount={seen.newCount}
                canRoles={Boolean(guild?.can?.roles)}
                canSettings={senior}
                presence={presence}
                version={auth.version}
            />
            <div className="workspace">
                <Header
                    guilds={guilds}
                    guild={guild}
                    onGuild={setGuildId}
                    me={me}
                    streamState={streamState}
                    onOpenMember={setDrawerUserId}
                    theme={theme}
                    onTheme={setTheme}
                    lockdown={lockdown}
                    canLockdown={senior}
                    onLockdown={setLockdown}
                    toast={toast}
                />
                {lockdown?.active && <LockdownBanner lockdown={lockdown} />}
                {update && (
                    <div className="banner">
                        Версия {update.version} загружена.
                        <button className="btn btn-primary" onClick={() => window.panel.installUpdate()}>Перезапустить и обновить</button>
                    </div>
                )}
                {authError && <div className="banner banner-error">{authError}</div>}
                <main className="content">
                    {!guildId && (
                        <div className="empty">
                            <h2>Нет серверов с доступом</h2>
                            <p>Панель открывается на серверах, где есть бот и у вас есть одно из прав: «Управлять ролями», «Выгонять», «Отправлять подумать о поведении», «Банить», «Перемещать участников», «Отключать участникам микрофон или звук» или «Администратор».</p>
                        </div>
                    )}
                    {guildId && view === 'overview' && (
                        <OverviewView guildId={guildId} revision={revision} voiceRevision={voiceRevision} waiting={waiting} seen={seen}
                            onView={setView} onOpenMember={setDrawerUserId} onChanged={() => setReloadWaiting(n => n + 1)} toast={toast} />
                    )}
                    {guildId && view === 'queue' && (
                        <QueueView
                            guildId={guildId}
                            waiting={waiting}
                            seen={seen}
                            revision={revision}
                            onChanged={() => setReloadWaiting(n => n + 1)}
                            onOpenMember={setDrawerUserId}
                            toast={toast}
                        />
                    )}
                    {guildId && view === 'voice' && (
                        <VoiceView guildId={guildId} myId={me?.id} revision={revision} voiceRevision={voiceRevision}
                            onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'roles' && guild?.can?.roles && (
                        <RolesView guildId={guildId} revision={revision} job={roleJob} onJob={updateJob} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'moderation' && (
                        <ModerationView guildId={guildId} revision={revision} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'journal' && (
                        <JournalView guildId={guildId} liveEvents={liveEvents} preset={journalPreset} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'stats' && (
                        <StatsView guildId={guildId} revision={revision} onOpenMember={setDrawerUserId} onOpenJournal={openJournal} />
                    )}
                    {guildId && view === 'settings' && senior && (
                        <SettingsView guildId={guildId} toast={toast} />
                    )}
                </main>
            </div>
            {drawerUserId && guildId && (
                <MemberDrawer
                    guildId={guildId}
                    userId={drawerUserId}
                    revision={revision}
                    onClose={() => setDrawerUserId(null)}
                    onOpenMember={setDrawerUserId}
                    toast={toast}
                />
            )}
            <Toasts toasts={toasts} onDismiss={dismissToast} />
        </div>
    );
}
