// Standalone test (no test framework configured): run with `node test/queue-flags.test.js`
// Queue risk flags (young account, kicked before, raid wave, banned look-alike name,
// no avatar) and «Смотрит Kira» presence marks in the live stream.

const assert = require('assert');
const { riskFlags, normalizeName, joinsAround, BannedNames } = require('../src/modules/verification/riskFlags');
const { SseHub } = require('../src/web/v2/events');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T12:00:00Z');

function member({ ageDays = 400, avatar = 'abc', username = 'someone', globalName = null, displayName = null } = {}) {
    return { user: { username, globalName, avatar, createdTimestamp: NOW - ageDays * DAY }, displayName: displayName || username };
}

function names() {
    assert.strictEqual(normalizeName('V1KA'), 'vika');
    assert.strictEqual(normalizeName('xX_V1ka_Xx'), 'xvikax');
    assert.strictEqual(normalizeName('Тоха'), normalizeName('Toxa'), 'Cyrillic look-alikes fold into Latin');
    assert.strictEqual(normalizeName('Boooris__'), 'boris', 'repeats and symbols dropped');
    assert.strictEqual(normalizeName('B0r1s'), 'boris');
}

function flags() {
    const codes = (m, ctx = {}) => riskFlags(m, { youngAccountDays: 7, now: NOW, ...ctx }).map(f => f.code);
    assert.deepStrictEqual(codes(member()), [], 'an old account with an avatar is clean');
    assert.deepStrictEqual(codes(member({ ageDays: 2 })), ['young']);
    assert.deepStrictEqual(codes(member({ ageDays: 2 }), { youngAccountDays: 1 }), [], 'the threshold comes from settings');
    assert.deepStrictEqual(codes(member({ avatar: null })), ['no_avatar']);
    const kicked = riskFlags(member(), { youngAccountDays: 7, kickCount: 2, now: NOW });
    assert.strictEqual(kicked[0].label, 'кикали 2 раза');
    assert.strictEqual(riskFlags(member(), { youngAccountDays: 7, kickCount: 5, now: NOW })[0].label, 'кикали 5 раз');
    assert.deepStrictEqual(codes(member(), { joinsNear: 4 }), [], 'four joins are not a raid');
    assert.deepStrictEqual(codes(member(), { joinsNear: 5 }), ['raid']);
    const banned = new Set([normalizeName('Boris')]);
    assert.deepStrictEqual(codes(member({ username: 'b0r1s_' }), { bannedNames: banned }), ['banned_name']);
    assert.deepStrictEqual(codes(member({ username: 'x', displayName: 'Борис' }), { bannedNames: new Set([normalizeName('Борис')]) }), ['banned_name'], 'the server nick counts too');
    assert.deepStrictEqual(codes(member({ username: 'bo' }), { bannedNames: new Set(['bo']) }), [], 'too short to compare');
    const tones = Object.fromEntries(riskFlags(member({ ageDays: 1, avatar: null, username: 'boris' }), {
        youngAccountDays: 7, bannedNames: banned, kickCount: 1, joinsNear: 9, now: NOW
    }).map(f => [f.code, f.tone]));
    assert.deepStrictEqual(tones, { young: 'danger', kicked: 'danger', raid: 'danger', banned_name: 'warn', no_avatar: null });
}

function raid() {
    const minute = 60 * 1000;
    const joins = [0, 1, 2, 3, 4].map(m => NOW + m * minute).concat([NOW + 60 * minute]);
    const around = joinsAround(joins);
    assert.strictEqual(around(NOW + 2 * minute), 5, 'five within ±5 minutes');
    assert.strictEqual(around(NOW + 60 * minute), 1, 'a lone join later');
}

async function bans() {
    let calls = 0;
    const pages = [new Map([['1', { user: { username: 'Boris', globalName: 'Боря' } }]])];
    const guild = {
        id: 'g', bans: {
            fetch: async () => {
                calls++;
                const page = pages[calls - 1] || new Map();
                return Object.assign(page, { lastKey: () => [...page.keys()].pop() });
            }
        }
    };
    const index = new BannedNames();
    const set = await index.get(guild);
    assert.ok(set.has('boris') && set.has(normalizeName('Боря')));
    await index.get(guild);
    assert.strictEqual(calls, 1, 'cached between requests');
    index.invalidate('g');
    await index.get(guild);
    assert.strictEqual(calls, 2);
    const noRight = await new BannedNames().get({ id: 'h', bans: { fetch: async () => { throw new Error('Missing Permissions'); } } });
    assert.strictEqual(noRight.size, 0, 'without the right the flag just never shows');
}

function viewing() {
    const hub = new SseHub();
    const frames = [];
    const stream = () => ({ writeHead() {}, write(frame) { frames.push(frame); }, on() {}, flushHeaders() {} });
    const kira = stream();
    const flix = stream();
    hub.subscribe('g', kira, { id: 'kira', displayName: 'Kira' });
    hub.subscribe('g', flix, { id: 'flix', displayName: 'Flix' });
    hub.setViewing('g', 'kira', '42', NOW);
    const presence = hub.presence('g', NOW + 1000);
    assert.strictEqual(presence.find(u => u.id === 'kira').viewingId, '42');
    assert.strictEqual(presence.find(u => u.id === 'flix').viewingId, null);
    assert.ok(frames.at(-1).includes('"viewingId":"42"'), 'everyone hears about it');
    assert.strictEqual(hub.presence('g', NOW + 7 * 60 * 1000).find(u => u.id === 'kira').viewingId, null, 'a stale mark expires');
    const before = frames.length;
    hub.setViewing('g', 'kira', '42', NOW + 2000);
    assert.strictEqual(frames.length, before, 'refreshing the same card sends nothing');
    hub.unsubscribe('g', kira);
    hub.subscribe('g', kira, { id: 'kira', displayName: 'Kira' });
    assert.strictEqual(hub.presence('g', NOW + 3000).find(u => u.id === 'kira').viewingId, null, 'closing the app clears the mark');
    hub.stopHeartbeat();
}

(async () => {
    names();
    flags();
    raid();
    await bans();
    viewing();
    console.log('queue flags tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
