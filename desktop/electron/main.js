const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const config = require('./config');
const tokenStore = require('./tokenStore');
const { ApiClient } = require('./api');

let mainWindow = null;
let token = null;
let pendingVerifier = null; // PKCE verifier of the login in progress
let stream = null;

const api = new ApiClient(config.apiUrl, () => token, () => setToken(null));

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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
    if (!code || !verifier) {
        send('auth:error', { message: 'Вход не был начат в этом окне. Попробуйте ещё раз.' });
        return;
    }

    try {
        const result = await api.request('POST', '/auth/token', { code, verifier });
        setToken(result.token);
    } catch (error) {
        send('auth:error', { message: `Не удалось войти: ${error.message}` });
    }
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
}

const findDeepLink = argv => argv.find(arg => arg.startsWith(`${config.appScheme}://`));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // Windows/Linux: the deep link starts a second instance — forward it here
    app.on('second-instance', (event, argv) => {
        const link = findDeepLink(argv);
        if (link) handleDeepLink(link);
    });
    // macOS
    app.on('open-url', (event, link) => {
        event.preventDefault();
        handleDeepLink(link);
    });
}

// --- IPC: the renderer's only door to the network ----------------------------------

ipcMain.handle('auth:status', () => ({ loggedIn: Boolean(token), apiUrl: config.apiUrl }));

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

ipcMain.handle('events:subscribe', (event, guildId) => {
    stream?.close();
    stream = guildId
        ? api.stream(guildId,
            (name, data) => send('events:message', { guildId, event: name, data }),
            stateName => send('events:state', { guildId, state: stateName }))
        : null;
});

// --- Window -------------------------------------------------------------------------

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 560,
        title: 'BirthdayBot Panel',
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

    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    if (!gotLock) return;
    token = tokenStore.load();
    createWindow();

    // Cold start from a deep link (Windows passes it in argv)
    const link = findDeepLink(process.argv);
    if (link) handleDeepLink(link);
});

app.on('window-all-closed', () => {
    stream?.close();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
