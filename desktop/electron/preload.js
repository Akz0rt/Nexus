const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

// The only API the renderer gets: no Node, no token, no raw network access.
contextBridge.exposeInMainWorld('panel', {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    request: (method, path, body) => ipcRenderer.invoke('api:request', { method, path, body }),
    subscribe: guildId => ipcRenderer.invoke('events:subscribe', guildId),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
    saveCsv: (fileName, content) => ipcRenderer.invoke('file:saveCsv', { fileName, content }),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onAuthChanged: callback => listen('auth:changed', callback),
    onAuthError: callback => listen('auth:error', callback),
    onEvent: callback => listen('events:message', callback),
    onStreamState: callback => listen('events:state', callback),
    onNavigate: callback => listen('app:navigate', callback),
    onUpdateReady: callback => listen('update:ready', callback)
});
