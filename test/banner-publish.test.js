// Standalone test (no test framework configured): run with `node test/banner-publish.test.js`
// Publishing the banner: the interval, «only if the leader changed», «Обновить сейчас» once a
// minute, the reasons it can't publish (boost level, permission, no background, nothing to
// show — then the current banner stays), history and state, yesterday's leader, restoring;
// and the store's files on disk (the last 10 banners, one background).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const { createPublisher, identity, discordReason } = require('../src/banner/publisher');
const { BannerStore, HISTORY_SIZE } = require('../src/banner/store');
const { resolveBanner } = require('../src/banner/settings');
const { dayKey } = require('../src/banner/data');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

/** In-memory Cosmos container for one partition per guild */
function fakeContainer() {
    const docs = new Map();
    const key = (guildId, id) => `${guildId}/${id}`;
    return {
        docs,
        item: (id, guildId) => ({
            read: async () => {
                const doc = docs.get(key(guildId, id));
                if (!doc) throw Object.assign(new Error('not found'), { code: 404 });
                return { resource: JSON.parse(JSON.stringify(doc)) };
            },
            delete: async () => { docs.delete(key(guildId, id)); }
        }),
        items: {
            upsert: async doc => { docs.set(key(doc.guildId, doc.id), JSON.parse(JSON.stringify(doc))); return { resource: doc }; },
            query: (spec, options) => ({
                fetchAll: async () => ({
                    resources: [...docs.values()]
                        .filter(doc => doc.guildId === options.partitionKey && doc.kind === 'history')
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                })
            })
        }
    };
}

function fakeStore(dir) {
    const store = new BannerStore();
    Object.assign(store, { initialized: true, container: fakeContainer(), root: dir });
    return store;
}

function fakeGuild({ features = ['BANNER', 'ANIMATED_BANNER'], manageGuild = true } = {}) {
    const uploads = [];
    return {
        id: '111111111111111111',
        features,
        uploads,
        members: { me: { permissions: { has: flag => flag === PermissionFlagsBits.ManageGuild && manageGuild } } },
        setBanner: async (data, reason) => {
            if (guildError.next) { const error = guildError.next; guildError.next = null; throw error; }
            uploads.push({ data, reason });
        }
    };
}
const guildError = { next: null };

function setup({ banner = {}, data = { user: { id: 'u1', name: 'maks' }, messages: 10, minutes: 5, calc: 'combined', period: '24h' } } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-publish-'));
    const store = fakeStore(dir);
    const settings = { timezone: 'Europe/Moscow', banner: { ...resolveBanner({ enabled: true, ...banner }) } };
    const calls = { collect: [], compose: [], audit: [] };
    const current = { data };
    const publisher = createPublisher({
        store,
        settings: { get: async () => settings },
        collect: async (guild, s, mode, options) => { calls.collect.push({ mode, ...options }); return current.data; },
        dayKey,
        composeBanner: async options => { calls.compose.push(options); return { buffer: Buffer.from('GIF89a-banner'), type: 'image/gif', bytes: 13 }; },
        thumbnail: async () => Buffer.from('thumb'),
        audit: { log: async entry => { calls.audit.push(entry); } },
        log: { error: () => {}, warn: () => {} }
    });
    return { dir, store, settings, calls, current, publisher };
}

async function withBackground(store, guildId = '111111111111111111', animated = true) {
    await store.saveBackground(guildId, { buffer: Buffer.from('GIF89a-bg'), type: 'image/gif', name: 'fon_blue.gif', animated });
}

async function reasons() {
    const { store, publisher } = setup();
    let result = await publisher.publish(fakeGuild({ features: [] }), { now: NOW });
    assert.strictEqual(result.code, 'boost_level');
    assert.strictEqual((await store.getState('111111111111111111')).lastError.code, 'boost_level', 'the reason is kept for the panel and diagnostics');

    result = await publisher.publish(fakeGuild({ manageGuild: false }), { now: NOW + 31 * MINUTE });
    assert.strictEqual(result.code, 'missing_permission');

    result = await publisher.publish(fakeGuild(), { now: NOW + 62 * MINUTE });
    assert.strictEqual(result.code, 'no_background', 'no background → the bot does not touch the banner');

    const off = setup({ banner: { enabled: false } });
    assert.strictEqual((await off.publisher.publish(fakeGuild(), { now: NOW })).code, 'disabled');

    // Nothing to show: the current banner stays, and it is not an error
    const empty = setup({ data: null });
    await withBackground(empty.store);
    const guild = fakeGuild();
    result = await empty.publisher.publish(guild, { now: NOW });
    assert.deepStrictEqual([result.code, result.skipped, guild.uploads.length], ['no_data', true, 0]);
    assert.strictEqual((await empty.store.getState(guild.id)).lastError, undefined);

    assert.strictEqual(discordReason({ code: 50013 }), 'missing_permission');
    assert.strictEqual(discordReason({ code: 50035, message: 'Invalid Form Body: guild BANNER feature required' }), 'boost_level');
    assert.strictEqual(discordReason({ code: 500 }), 'rejected');
}

async function publishing() {
    const { store, calls, current, publisher } = setup({ banner: { intervalMin: 30, onlyOnChange: true } });
    await withBackground(store);
    const guild = fakeGuild();

    let result = await publisher.publish(guild, { now: NOW });
    assert.ok(result.ok);
    assert.ok(guild.uploads[0].data.startsWith('data:image/gif;base64,'));
    assert.strictEqual(calls.compose[0].animated, true);
    assert.strictEqual(calls.compose[0].stillIfTooLarge, true);
    assert.strictEqual(calls.compose[0].spec.layout, 'left');
    const state = await store.getState(guild.id);
    assert.deepStrictEqual([state.current.mode, state.current.leaderId], ['leader', 'u1']);
    assert.strictEqual(state.leadersByDay[dayKey(NOW, 'Europe/Moscow')], 'u1');
    assert.strictEqual(calls.audit[0].action, 'banner.published');
    const [entry] = await store.listHistory(guild.id);
    assert.deepStrictEqual([entry.caption, entry.type, entry.manual], ['maks', 'image/gif', false]);
    assert.ok(fs.existsSync(store.file(guild.id, entry.file)) && fs.existsSync(store.file(guild.id, entry.thumb)));

    // Within the interval: nothing happens
    result = await publisher.publish(guild, { now: NOW + 10 * MINUTE });
    assert.strictEqual(result.code, 'interval');

    // Same leader, more messages: «only if the leader changed» keeps the banner
    current.data = { ...current.data, messages: 99 };
    result = await publisher.publish(guild, { now: NOW + 31 * MINUTE });
    assert.strictEqual(result.code, 'unchanged');
    assert.strictEqual(guild.uploads.length, 1);

    // A new leader: published after the interval (counted from the last check)
    current.data = { ...current.data, user: { id: 'u2', name: 'Вика' } };
    assert.strictEqual((await publisher.publish(guild, { now: NOW + 40 * MINUTE })).code, 'interval');
    result = await publisher.publish(guild, { now: NOW + 62 * MINUTE });
    assert.ok(result.ok);
    assert.strictEqual((await store.getState(guild.id)).leadersByDay[dayKey(NOW, 'Europe/Moscow')], 'u1', 'the first leader of the day is remembered');

    // «Обновить сейчас»: ignores the interval and «unchanged», once a minute
    result = await publisher.publish(guild, { manual: true, actor: { id: 'a1', tag: 'admin' }, now: NOW + 63 * MINUTE });
    assert.ok(result.ok);
    assert.match(guild.uploads.at(-1).reason, /вручную \(admin\)/);
    result = await publisher.publish(guild, { manual: true, now: NOW + 63 * MINUTE + 30000 });
    assert.strictEqual(result.code, 'too_soon');

    // Without «only if the leader changed», new numbers are a new banner
    const counting = setup({ banner: { intervalMin: 15, onlyOnChange: false } });
    await withBackground(counting.store);
    const other = fakeGuild();
    assert.ok((await counting.publisher.publish(other, { now: NOW })).ok);
    counting.current.data = { ...counting.current.data, messages: 11 };
    assert.ok((await counting.publisher.publish(other, { now: NOW + 16 * MINUTE })).ok);
}

async function boostAndErrors() {
    // Level 2 only: the first frame
    const still = setup();
    await withBackground(still.store);
    await still.publisher.publish(fakeGuild({ features: ['BANNER'] }), { now: NOW });
    assert.strictEqual(still.calls.compose[0].animated, false);

    // Discord refuses: the reason is kept, nothing goes to the history
    const refused = setup();
    await withBackground(refused.store);
    guildError.next = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const result = await refused.publisher.publish(fakeGuild(), { now: NOW });
    assert.strictEqual(result.code, 'missing_permission');
    assert.strictEqual((await refused.store.listHistory('111111111111111111')).length, 0);
}

async function yesterdayLeader() {
    const { store, calls, publisher } = setup({ banner: { exclude: { yesterdayLeader: true } } });
    await withBackground(store);
    const guild = fakeGuild();
    const yesterday = dayKey(NOW - 24 * 60 * MINUTE, 'Europe/Moscow');
    await store.updateState(guild.id, { leadersByDay: { [yesterday]: 'old-leader' } });
    await publisher.publish(guild, { now: NOW });
    assert.strictEqual(calls.collect[0].yesterdayLeaderId, 'old-leader');
}

async function restoring() {
    const { store, calls, current, publisher } = setup();
    await withBackground(store);
    const guild = fakeGuild();
    await publisher.publish(guild, { now: NOW });
    const [first] = await store.listHistory(guild.id);
    current.data = { ...current.data, user: { id: 'u9', name: 'Гриша' } };
    await publisher.publish(guild, { manual: true, now: NOW + 5 * MINUTE });

    const result = await publisher.restore(guild, first.historyId, { actor: { id: 'a1', tag: 'admin' }, now: NOW + 10 * MINUTE });
    assert.ok(result.ok);
    assert.strictEqual(guild.uploads.at(-1).data, `data:image/gif;base64,${Buffer.from('GIF89a-banner').toString('base64')}`);
    assert.strictEqual((await store.getState(guild.id)).current.historyId, first.historyId);
    assert.strictEqual(calls.audit.at(-1).action, 'banner.restored');
    assert.strictEqual((await publisher.restore(guild, 'nope', {})).code, 'not_found');
}

async function storeFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-store-'));
    const store = fakeStore(dir);
    const guildId = '222222222222222222';

    // A new background replaces the old file
    const first = await store.saveBackground(guildId, { buffer: Buffer.from('one'), type: 'image/png', name: 'a.png', animated: false });
    const second = await store.saveBackground(guildId, { buffer: Buffer.from('two'), type: 'image/gif', name: 'b.gif', animated: true });
    assert.ok(!fs.existsSync(store.file(guildId, first.file)) && fs.existsSync(store.file(guildId, second.file)));
    const background = await store.getBackground(guildId);
    assert.deepStrictEqual([background.buffer.toString(), background.meta.name, background.meta.animated], ['two', 'b.gif', true]);

    // Only the last 10 banners are kept, files included
    for (let i = 0; i < HISTORY_SIZE + 3; i++) {
        await store.addHistory(guildId, { buffer: Buffer.from(`b${i}`), type: 'image/png', thumbnail: Buffer.from('t'), mode: 'leader', createdAt: new Date(NOW + i * MINUTE).toISOString() });
    }
    const kept = await store.listHistory(guildId);
    assert.strictEqual(kept.length, HISTORY_SIZE);
    const files = fs.readdirSync(path.join(dir, guildId)).filter(name => name.startsWith('banner-'));
    assert.strictEqual(files.length, HISTORY_SIZE * 2, 'old pictures and thumbnails are deleted');
    assert.strictEqual((await store.readFile(guildId, kept[0].file)).toString(), `b${HISTORY_SIZE + 2}`);

    // Names never leave the server's folder
    assert.throws(() => store.file(guildId, '../x'));
    assert.throws(() => store.file('../etc', 'x'));
    assert.strictEqual(await store.getHistory(guildId, '../../x'), null);

    assert.strictEqual(identity('podium', { places: [{ id: 'a' }, { id: 'b' }] }), 'podium:a,b');
}

(async () => {
    await reasons();
    await publishing();
    await boostAndErrors();
    await yesterdayLeader();
    await restoring();
    await storeFiles();
    console.log('banner-publish.test.js: all passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
