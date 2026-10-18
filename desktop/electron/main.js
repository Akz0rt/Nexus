const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const config = require('./config');
const tokenStore = require('./tokenStore');
const settings = require('./settings');
const { ApiClient } = require('./api');

// Data folder from before the rename to Nexus: keeps the saved login and settings
app.setPath('userData', path.join(app.getPath('appData'), 'BirthdayBot Panel'));

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png'); // logo mark without the square background
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let token = null;
let pendingVerifier = null; // PKCE verifier of the login in progress
let stream = null;
let updater = null;

const api = new ApiClient(config.apiUrl, () => token, () => setToken(null));

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showWindow() {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function setToken(value) {
    token = value;
    if (value) tokenStore.save(value);
    else tokenStore.clear();
    if (!value) {
        stream?.close();
        stream = null;
    }
    send('auth:changed', { loggedIn: Boolean(value) });
}

// --- Deep link: birthdaybot-panel://auth?code=... --------------------------------
// The scheme and appId keep the pre-Nexus names so installed 0.2.x builds update in place.

if (process.defaultApp) {
    // Dev: register electron.exe + this app's path
    app.setAsDefaultProtocolClient(config.appScheme, process.execPath, [path.resolve(process.argv[1] || '.')]);
} else {
    app.setAsDefaultProtocolClient(config.appScheme);
}

async function handleDeepLink(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return;
    }
    if (url.protocol !== `${config.appScheme}:` || url.hostname !== 'auth') return;

    const code = url.searchParams.get('code');
    const verifier = pendingVerifier;
    pendingVerifier = null;
    showWindow();
    if (!code || !verifier) {
        send('auth:error', { message: 'Вход начат не из этого окна. Нажмите «Войти через Discord» ещё раз.' });
        return;
    }

    try {
        const result = await api.request('POST', '/auth/token', { code, verifier });
        setToken(result.token);
    } catch (error) {
        send('auth:error', { message: `Не удалось войти: ${error.message}` });
    }
}

const findDeepLink = argv => argv.find(arg => arg.startsWith(`${config.appScheme}://`));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // Windows/Linux: a deep link or a second launch starts another instance — hand over here
    app.on('second-instance', (event, argv) => {
        const link = findDeepLink(argv);
        if (link) handleDeepLink(link);
        else showWindow();
    });
    // macOS
    app.on('open-url', (event, link) => {
        event.preventDefault();
        handleDeepLink(link);
    });
}

// --- Live events: forwarded to the UI, newcomers also raise a notification --------

function notify(title, body, view) {
    if (!settings.get().notifications || !Notification.isSupported()) return;
    if (mainWindow?.isVisible() && mainWindow.isFocused()) return;
    // With our own chime on, the Windows sound would play twice
    const notification = new Notification({ title, body, icon: ICON_PATH, silent: settings.get().sound });
    notification.on('click', () => {
        showWindow();
        send('app:navigate', { view });
    });
    notification.show();
}

const NOTIFICATIONS = {
    'verification.queued': () => notify('Новичок ждёт пропуска', 'Нажмите, чтобы открыть очередь.', 'queue'),
    'report.created': () => notify('Новая жалоба', 'Участник пожаловался на сообщение. Нажмите, чтобы открыть жалобы.', 'reports'),
    'moderation.ban_proposed': entry => notify(
        'Предложен бан',
        `У участника ${entry.reason || 'много варнов'}. Решение — кнопкой в канале модераторов.`,
        'moderation')
};

function subscribe(guildId) {
    stream?.close();
    stream = guildId
        ? api.stream(guildId,
            (name, data) => {
                send('events:message', { guildId, event: name, data });
                if (name === 'audit') NOTIFICATIONS[data.action]?.(data);
            },
            stateName => send('events:state', { guildId, state: stateName }))
        : null;
}

// --- IPC: the renderer's only door to the outside -----------------------------------

ipcMain.handle('auth:status', () => ({
    loggedIn: Boolean(token),
    apiUrl: config.apiUrl,
    version: app.getVersion()
}));

ipcMain.handle('auth:login', async () => {
    pendingVerifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(pendingVerifier).digest('base64url');
    await shell.openExternal(`${config.apiUrl}/api/v2/auth/login?challenge=${challenge}`);
});

ipcMain.handle('auth:logout', async () => {
    try {
        if (token) await api.request('POST', '/auth/logout');
    } catch {
        // logging out locally is what matters
    }
    setToken(null);
});

ipcMain.handle('api:request', async (event, { method, path: apiPath, body }) => {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Bad method');
    try {
        return { ok: true, data: await api.request(method, apiPath, body) };
    } catch (error) {
        return { ok: false, status: error.status || 0, error: error.body?.error || error.message, body: error.body || null };
    }
});

ipcMain.handle('events:subscribe', (event, guildId) => subscribe(guildId));

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:update', (event, patch) => settings.update(patch));

ipcMain.handle('file:saveCsv', async (event, { fileName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: String(fileName || 'export.csv').replace(/[\\/:*?"<>|]/g, '_'),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { saved: false };
    // BOM so Excel opens Cyrillic correctly
    fs.writeFileSync(filePath, '﻿' + String(content), 'utf8');
    return { saved: true, filePath };
});

ipcMain.handle('update:install', () => {
    quitting = true;
    updater?.quitAndInstall();
});

// --- Auto-update from GitHub Releases (installed builds only) ---------------------

function startAutoUpdate() {
    if (!app.isPackaged) return;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-downloaded', info => send('update:ready', { version: info.version }));
    updater.on('error', error => console.error('Auto-update error:', error?.message || error));
    const check = () => updater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, UPDATE_CHECK_MS).unref?.();
}

// --- Window and tray ------------------------------------------------------------------

function createTray() {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH).resize({ width: 16, height: 16, quality: 'best' }));
    tray.setToolTip('Nexus');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Открыть панель', click: showWindow },
        { type: 'separator' },
        { label: 'Выйти', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'Nexus',
        icon: ICON_PATH,
        backgroundColor: '#0f1218',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    // Links open in the system browser, never inside the app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Close → hide to tray (the live queue and notifications keep working)
    mainWindow.on('close', event => {
        if (quitting || !settings.get().closeToTray || !tray) return;
        event.preventDefault();
        mainWindow.hide();
        if (!trayHintShown && Notification.isSupported()) {
            trayHintShown = true;
            new Notification({
                title: 'Панель работает в трее',
                body: 'Выйти можно через значок в трее → «Выйти».',
                icon: ICON_PATH
            }).show();
        }
    });
    mainWindow.on('closed', () => { mainWindow = null; });

    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }
}

app.whenReady().then(() => {
    if (!gotLock) return;
    app.setAppUserModelId('com.akz0rt.birthdaybot.panel'); // notifications on Windows
    token = tokenStore.load();
    createWindow();
    createTray();
    startAutoUpdate();

    // Cold start from a deep link (Windows passes it in argv)
    const link = findDeepLink(process.argv);
    if (link) handleDeepLink(link);
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
    if (quitting || !tray) {
        stream?.close();
        if (process.platform !== 'darwin') app.quit();
    }
});

app.on('activate', showWindow);
