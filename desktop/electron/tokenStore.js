const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

// Session token, encrypted with the OS keychain (DPAPI on Windows) via safeStorage.
const file = () => path.join(app.getPath('userData'), 'session.bin');

function load() {
    try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(fs.readFileSync(file()));
    } catch {
        return null;
    }
}

function save(token) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS encryption is unavailable — cannot store the session safely');
    }
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), safeStorage.encryptString(token));
}

function clear() {
    try {
        fs.unlinkSync(file());
    } catch {
        // already gone
    }
}

module.exports = { load, save, clear };
