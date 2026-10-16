// Standalone test (no test framework configured): run with `node test/panel-sse.test.js`
// Verifies SSE fan-out: events reach only the guild's streams, closed streams are dropped,
// and audit-log events on the bus are forwarded.

const assert = require('assert');
const { EventEmitter } = require('node:events');
const { SseHub } = require('../src/web/v2/events');

function fakeRes() {
    const res = new EventEmitter();
    res.frames = [];
    res.headers = null;
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.write = chunk => { res.frames.push(chunk); };
    return res;
}

function run() {
    const bus = new EventEmitter();
    const hub = new SseHub().attach(bus);

    const a1 = fakeRes();
    const a2 = fakeRes();
    const b1 = fakeRes();
    hub.subscribe('guildA', a1, { id: 'kira', displayName: 'Kira' });
    hub.subscribe('guildA', a2, { id: 'kira', displayName: 'Kira' }); // same moderator, second window
    hub.subscribe('guildB', b1, { id: 'bob', displayName: 'Bob' });

    // presence: distinct users per guild, pushed to that guild's streams
    assert.deepStrictEqual(hub.presence('guildA').map(u => u.id), ['kira']);
    assert.deepStrictEqual(hub.presence('guildB').map(u => u.id), ['bob']);
    assert.ok(a1.frames.some(f => f.startsWith('event: presence')));
    assert.ok(!b1.frames.some(f => f.includes('kira')), 'presence must not leak across guilds');

    assert.strictEqual(a1.headers['Content-Type'], 'text/event-stream');

    bus.emit('audit', { guildId: 'guildA', action: 'verification.approved' });
    const last = res => res.frames[res.frames.length - 1];
    assert.ok(last(a1).startsWith('event: audit\ndata: {"guildId":"guildA"'));
    assert.strictEqual(last(a1), last(a2));
    assert.ok(!b1.frames.some(f => f.includes('verification.approved')), 'other guild must not receive it');

    // closing a stream unsubscribes it
    a2.emit('close');
    assert.strictEqual(hub.broadcast('guildA', 'audit', {}), 1);

    // kira still has a1 open → still on shift
    assert.deepStrictEqual(hub.presence('guildA').map(u => u.id), ['kira']);

    // last stream gone → heartbeat stops
    a1.emit('close');
    b1.emit('close');
    assert.strictEqual(hub.clients.size, 0);
    assert.strictEqual(hub.heartbeat, null);

    console.log('PASS: SSE hub per-guild fan-out and presence');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
