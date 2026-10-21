// Standalone test (no test framework configured): run with `node test/banner-routes.test.js`
// The «Баннер» screen's API: settings (turned on only with a background), the background
// upload (checked, brought to 960×540, journal), its small picture, the preview (also
// «Только фон»), the status line and the history.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const BannerStore = require('../src/banner/store');
const { resolveBanner } = require('../src/banner/settings');

const GUILD = '333333333333333333';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-routes-'));

// In-memory Cosmos for the store, files in a temp folder
const docs = new Map();
Object.assign(BannerStore, {
    initialized: true,
    root: dir,
    container: {
        item: (id, guildId) => ({
            read: async () => {
                const doc = docs.get(`${guildId}/${id}`);
                if (!doc) throw Object.assign(new Error('not found'), { code: 404 });
                return { resource: doc };
            },
            delete: async () => { docs.delete(`${guildId}/${id}`); }
        }),
        items: {
            upsert: async doc => { docs.set(`${doc.guildId}/${doc.id}`, doc); return { resource: doc }; },
            query: () => ({ fetchAll: async () => ({ resources: [...docs.values()].filter(doc => doc.kind === 'history') }) })
        }
    }
});

let stored = { banner: resolveBanner(undefined) };
GuildSettingsService.get = async () => ({ timezone: 'UTC', ...stored });
GuildSettingsService.update = async (guildId, patch) => { stored = { ...stored, ...patch }; };
const journal = [];
AuditLogService.log = async entry => { journal.push(entry); };

const guild = {
    id: GUILD,
    premiumTier: 3,
    features: ['BANNER', 'ANIMATED_BANNER'],
    members: { cache: new Map(), fetch: async () => null, me: null },
    channels: { cache: new Map() }
};

function app() {
    const server = express();
    server.use(express.json());
    server.use((req, res, next) => {
        req.guild = guild;
        req.session = { userId: '1', username: 'admin' };
        req.panelRole = 'senior';
        next();
    });
    server.use('/banner', require('../src/web/v2/routes/banner'));
    return server.listen(0);
}

function call(server, method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const req = http.request({
            port: server.address().port, method, path: url,
            headers: { ...(payload && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const json = (res.headers['content-type'] || '').includes('json') ? JSON.parse(buffer.toString()) : null;
                resolve({ status: res.statusCode, headers: res.headers, buffer, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function testPng(size = '1280x720') {
    const out = path.join(dir, `bg-${size}.png`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=1`, '-frames:v', '1', out]);
    return fs.readFileSync(out);
}

(async () => {
    const server = app();
    try {
        // Settings: turning on needs a background
        let res = await call(server, 'GET', '/banner/settings');
        assert.strictEqual(res.json.values.enabled, false);
        res = await call(server, 'PUT', '/banner/settings', { enabled: true });
        assert.deepStrictEqual([res.status, res.json.error], [400, 'no_background']);
        res = await call(server, 'PUT', '/banner/settings', { period: '2h', layouts: { leader: 'right' } });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual([stored.banner.period, stored.banner.layouts.leader, stored.banner.layouts.podium], ['2h', 'right', 'center']);
        assert.strictEqual(journal.at(-1).action, 'banner.settings_updated');

        // Upload: not a picture, too big, then a 4:3 PNG brought to 960×540
        res = await call(server, 'POST', '/banner/background', Buffer.from('hello'), { 'Content-Type': 'application/octet-stream' });
        assert.deepStrictEqual([res.status, res.json.error], [400, 'bad_background']);
        res = await call(server, 'POST', '/banner/background', Buffer.alloc(16 * 1024 * 1024, 1), { 'Content-Type': 'image/png' });
        assert.deepStrictEqual([res.status, res.json.error], [413, 'file_too_large']);
        res = await call(server, 'POST', '/banner/background', testPng('800x600'), { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('фон 4x3.png') });
        assert.strictEqual(res.status, 200, JSON.stringify(res.json));
        assert.deepStrictEqual([res.json.background.name, res.json.background.type, res.json.background.animated], ['фон 4x3.png', 'image/png', false]);
        const saved = await BannerStore.getBackground(GUILD);
        assert.deepStrictEqual([saved.buffer.readUInt32BE(16), saved.buffer.readUInt32BE(20)], [960, 540]);
        assert.strictEqual(journal.at(-1).action, 'banner.background_changed');

        res = await call(server, 'GET', '/banner/background/image');
        assert.deepStrictEqual([res.status, res.headers['content-type'], res.buffer.readUInt32BE(16)], [200, 'image/png', 320]);

        // Now it can be turned on
        res = await call(server, 'PUT', '/banner/settings', { enabled: true });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(stored.banner.enabled, true);

        // Preview: «Только фон» needs no data; leader without activity draws the example
        res = await call(server, 'GET', '/banner/preview?mode=background');
        assert.deepStrictEqual([res.status, res.headers['content-type'], res.headers['x-banner-sample']], [200, 'image/png', '0']);
        res = await call(server, 'GET', '/banner/status');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual([res.json.enabled, res.json.boost.animated, res.json.background.name, res.json.lastError], [true, true, 'фон 4x3.png', null]);

        // An animated background: stays a GIF, and the preview draws its first frame
        const gifFile = path.join(dir, 'bg.gif');
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=5', '-t', '0.6', gifFile]);
        res = await call(server, 'POST', '/banner/background', fs.readFileSync(gifFile), { 'Content-Type': 'image/gif', 'X-File-Name': 'bg.gif' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.json));
        assert.deepStrictEqual([res.json.background.type, res.json.background.animated], ['image/gif', true]);
        assert.strictEqual(stored.banner.backgroundBlobId, (await BannerStore.readDoc(GUILD, 'background')).backgroundId, 'the settings name the background in use');
        let started = Date.now();
        res = await call(server, 'GET', '/banner/preview?mode=leader&layout=center');
        assert.deepStrictEqual([res.status, res.headers['content-type'], res.headers['x-banner-sample']], [200, 'image/png', '1']);
        const first = Date.now() - started;
        started = Date.now();
        res = await call(server, 'GET', '/banner/preview?mode=leader&layout=right&blur=10');
        assert.strictEqual(res.status, 200);
        assert.ok(Date.now() - started < 1000, `a preview after the first stays under a second (first ${first} ms, then ${Date.now() - started} ms)`);
        res = await call(server, 'GET', '/banner/background/image');
        assert.deepStrictEqual([res.status, res.buffer.readUInt32BE(16), res.buffer.readUInt32BE(20)], [200, 320, 180]);

        res = await call(server, 'GET', '/banner/history');
        assert.deepStrictEqual(res.json, { items: [], currentId: null });
        res = await call(server, 'GET', '/banner/history/nope/image');
        assert.strictEqual(res.status, 404);
        console.log('banner-routes.test.js: all passed');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
