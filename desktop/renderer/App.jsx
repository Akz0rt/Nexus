import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from './api.js';
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
import EventsView from './EventsView.jsx';
import BirthdaysView from './BirthdaysView.jsx';
import ActivityView from './ActivityView.jsx';
import EconomyView from './EconomyView.jsx';
import { LockdownBanner } from './LockdownButton.jsx';
import { playChime } from './sound.js';
import { useSeen } from './seen.js';
import MemberDrawer from './MemberDrawer.jsx';
import Toasts from './Toasts.jsx';
import TaskTray from './TaskTray.jsx';
import useTasks from './useTasks.js';

const THEME_KEY = 'panel.theme';
const VIEWING_REPEAT_MS = 4 * 60 * 1000;

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
    const [updateState, setUpdateState] = useState({ status: 'idle' });
    const manualCheck = useRef(false); // «Проверить обновления» was pressed: say how it ended
    const update = updateState.status === 'ready' ? updateState : null;
    const [theme, setTheme] = useState(readTheme);
    const [roleJob, setRoleJob] = useState(null); // running or last mass role change
    const [lockdown, setLockdown] = useState(null);
    const [journalPreset, setJournalPreset] = useState(null); // filters to open the journal with
    const [eventRevision, setEventRevision] = useState(0); // bumps when an event or its sign-ups change
    const [moderationRevision, setModerationRevision] = useState(0); // bumps on moderation / report / settings entries
    const [openReports, setOpenReports] = useState(0);
    const [moderationTab, setModerationTab] = useState(null); // { tab } to open the Moderation screen on
    const [queueTab, setQueueTab] = useState(null); // the same for «Пропуск»
    const [settingsSection, setSettingsSection] = useState(null); // { section } to open the Settings screen on
    const [lockdownConfirm, setLockdownConfirm] = useState(false); // the «close/open the server?» dialog
    const toastSeq = useRef(0);
    const dismissedJob = useRef(null);

    const toast = useCallback((text, options = {}) => {
        const id = ++toastSeq.current;
        setToasts(list => [...list, { id, text, ...options }]);
        setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), options.ttl || 5000);
        return id;
    }, []);
    const dismissToast = useCallback(id => setToasts(list => list.filter(t => t.id !== id)), []);

    const checkUpdates = useCallback(async () => {
        manualCheck.current = true;
        const state = await window.panel.checkForUpdates();
        // Only a check that is running reports back later
        if (state.status !== 'checking') manualCheck.current = false;
        if (state.status === 'dev') toast('Обновления приходят только в установленную версию приложения');
        if (state.status === 'ready') toast(`Версия ${state.version} уже загружена — перезапустите приложение`);
        if (state.status === 'downloading') toast(`Версия ${state.version} уже загружается`);
        if (state.status === 'idle') toast('Проверка обновлений ещё не запустилась — попробуйте через минуту');
    }, [toast]);
    // How a check started by hand ended
    useEffect(() => {
        if (!manualCheck.current) return;
        const { status, version, error } = updateState;
        if (status === 'latest') toast('Установлена последняя версия');
        else if (status === 'downloading') toast(`Нашлась версия ${version} — загружаем`);
        else if (status === 'ready') toast(`Версия ${version} загружена`);
        else if (status === 'error') toast(`Не удалось проверить обновления${error ? `: ${error.split('\n')[0].slice(0, 120)}` : ''}`, { tone: 'error' });
        else return;
        manualCheck.current = false;
    }, [updateState, toast]);

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
            window.panel.onNavigate(({ view: next }) => {
                // A report notification opens Moderation → «Жалобы»
                if (next === 'reports') {
                    setView('moderation');
                    setModerationTab({ tab: 'reports', at: Date.now() });
                } else {
                    setView(next);
                }
            }),
            window.panel.onUpdateState(state => setUpdateState(state))
        ];
        window.panel.getUpdateState().then(setUpdateState).catch(() => {});
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

    const tasks = useTasks({ guildId, roleJob, onRoleJob: updateJob, myId: me?.id, toast });
    const onTask = tasks.onTask;

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
                if (data.action === 'verification.queued' || data.action === 'report.created') {
                    window.panel.getSettings().then(prefs => { if (prefs.sound) playChime(); }).catch(() => {});
                }
                // Message edits and deletes are frequent and change nothing on the other screens
                if (!data.action?.startsWith('message.')) setRevision(r => r + 1);
                if (/^(moderation|report|settings)\./.test(data.action || '')) setModerationRevision(r => r + 1);
            }
            if (event === 'voice') setVoiceRevision(r => r + 1);
            if (event === 'job') updateJob(data);
            if (event === 'task') onTask(data);
            if (event === 'event') setEventRevision(r => r + 1);
        });
        const offState = window.panel.onStreamState(({ guildId: id, state }) => { if (id === guildId) setStreamState(state); });
        return () => { offEvent(); offState(); };
    }, [guildId, updateJob, onTask]);

    // Waiting queue: drives the sidebar counter and the "Ждут" tab
    const [reloadWaiting, setReloadWaiting] = useState(0);
    useEffect(() => {
        if (!guildId) { setWaiting(null); return; }
        let cancelled = false;
        apiGet(`/guilds/${guildId}/queue?tab=waiting`)
            .then(data => { if (!cancelled) setWaiting({ guildId, ...data, reservedRoleIds: data.reservedRoleIds || [] }); })
            .catch(error => { if (!cancelled) setWaiting({ guildId, items: [], error }); });
        return () => { cancelled = true; };
    }, [guildId, revision, reloadWaiting]);

    const seen = useSeen(guildId, waiting);

    // Open reports: the Moderation counter
    useEffect(() => {
        if (!guildId) { setOpenReports(0); return; }
        let cancelled = false;
        apiGet(`/guilds/${guildId}/reports?status=open`)
            .then(data => { if (!cancelled) setOpenReports(data.items.filter(r => r.status === 'open').length); })
            .catch(() => { if (!cancelled) setOpenReports(0); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

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

    // «Смотрит Kira»: tell the others whose card is open here (repeated so a crashed app's mark expires)
    useEffect(() => {
        if (!guildId || !auth?.loggedIn) return undefined;
        const send = userId => apiPost(`/guilds/${guildId}/presence/viewing`, { userId }).catch(() => {});
        send(drawerUserId || null);
        if (!drawerUserId) return undefined;
        const timer = setInterval(() => send(drawerUserId), VIEWING_REPEAT_MS);
        return () => clearInterval(timer); // the next run sends the new card or null
    }, [guildId, drawerUserId, auth?.loggedIn]);

    const openSettings = useCallback(section => {
        setSettingsSection({ section, at: Date.now() });
        setView('settings');
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
                openReports={openReports}
                canRoles={Boolean(guild?.can?.roles)}
                canSettings={senior}
                presence={presence}
                version={auth.version}
                updateState={updateState}
                onCheckUpdates={checkUpdates}
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
                    lockdownConfirm={lockdownConfirm}
                    onLockdownConfirm={setLockdownConfirm}
                    events={liveEvents}
                    onOpenSettings={openSettings}
                    onOpenJournal={() => openJournal({})}
                    onCheckUpdates={checkUpdates}
                    toast={toast}
                />
                {lockdown?.active && (
                    <LockdownBanner lockdown={lockdown} canManage={senior}
                        onEdit={() => openSettings('lockdown')} onOpen={() => setLockdownConfirm(true)} />
                )}
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
                        <OverviewView key={guildId} guildId={guildId} revision={revision} voiceRevision={voiceRevision} waiting={waiting} seen={seen}
                            onView={setView} onOpenMember={setDrawerUserId} onChanged={() => setReloadWaiting(n => n + 1)} toast={toast}
                            openReports={openReports} lockdown={lockdown}
                            onOpenTab={(next, tab) => {
                                if (next === 'moderation') setModerationTab({ tab, at: Date.now() });
                                if (next === 'queue') setQueueTab({ tab, at: Date.now() });
                                setView(next);
                            }} />
                    )}
                    {guildId && view === 'queue' && (
                        <QueueView
                            key={guildId}
                            guildId={guildId}
                            waiting={waiting}
                            seen={seen}
                            revision={revision}
                            requestedTab={queueTab}
                            presence={presence}
                            myId={me?.id}
                            onChanged={() => setReloadWaiting(n => n + 1)}
                            onOpenMember={setDrawerUserId}
                            toast={toast}
                        />
                    )}
                    {guildId && view === 'voice' && (
                        <VoiceView key={guildId} guildId={guildId} myId={me?.id} revision={revision} voiceRevision={voiceRevision}
                            onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'roles' && guild?.can?.roles && (
                        <RolesView key={guildId} guildId={guildId} revision={revision} job={roleJob} onJob={updateJob} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'moderation' && (
                        <ModerationView key={guildId} guildId={guildId} revision={moderationRevision} openReports={openReports} requestedTab={moderationTab} myId={me?.id}
                            onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'journal' && (
                        <JournalView key={guildId} guildId={guildId} liveEvents={liveEvents} preset={journalPreset} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'events' && (
                        <EventsView key={guildId} guildId={guildId} revision={revision} eventRevision={eventRevision} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'birthdays' && (
                        <BirthdaysView key={guildId} guildId={guildId} revision={revision} onOpenMember={setDrawerUserId} onOpenSettings={openSettings} toast={toast} />
                    )}
                    {guildId && view === 'activity' && (
                        <ActivityView key={guildId} guildId={guildId} onOpenMember={setDrawerUserId} />
                    )}
                    {guildId && view === 'economy' && (
                        <EconomyView key={guildId} guildId={guildId} revision={revision} onOpenMember={setDrawerUserId} toast={toast} />
                    )}
                    {guildId && view === 'stats' && (
                        <StatsView key={guildId} guildId={guildId} revision={revision} onOpenMember={setDrawerUserId} onOpenJournal={openJournal} />
                    )}
                    {guildId && view === 'settings' && senior && (
                        <SettingsView key={guildId} guildId={guildId} requestedSection={settingsSection} toast={toast} />
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
            <TaskTray items={tasks.items} onRevert={tasks.revert} onRetry={tasks.retry} onStop={tasks.stop} onClose={item => tasks.hide(item.key)} />
            <Toasts toasts={toasts} onDismiss={dismissToast} />
        </div>
    );
}
