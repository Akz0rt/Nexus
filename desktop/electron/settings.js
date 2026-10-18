const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// Per-machine app preferences (not secrets) in userData/settings.json
const DEFAULTS = {
    notifications: true, // Windows notification when a newcomer joins the queue
    sound: true,         // chime for a newcomer in the queue or a new report (played by the window)
    closeToTray: true    // closing the window keeps the app running in the tray
};

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache = null;

function get() {
    if (!cache) {
        try {
            cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
        } catch {
            cache = { ...DEFAULTS };
        }
    }
    return cache;
}

function update(patch) {
    const next = { ...get() };
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof patch?.[key] === typeof DEFAULTS[key]) next[key] = patch[key];
    }
    cache = next;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
    return next;
}

module.exports = { get, update };
