// Standalone test (no test framework configured): run with `node test/desktop-sse-parse.test.js`
// Verifies the desktop app's SSE frame parser against what the server's SseHub writes,
// including frames split across network chunks and heartbeat comments.

const assert = require('assert');
const { parseSse } = require('../desktop/electron/api');

function run() {
    const frame = 'event: audit\ndata: {"guildId":"g1","action":"verification.approved"}\n\n';

    // retry hint + heartbeat + one event
    let [events, rest] = parseSse('retry: 5000\n\n: ping\n\n' + frame);
    assert.deepStrictEqual(events, [{ event: 'audit', data: '{"guildId":"g1","action":"verification.approved"}' }]);
    assert.strictEqual(rest, '');

    // a frame split across chunks is held back until complete
    [events, rest] = parseSse(frame.slice(0, 20));
    assert.deepStrictEqual(events, []);
    [events, rest] = parseSse(rest + frame.slice(20) + frame);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(JSON.parse(events[1].data).guildId, 'g1');

    // CRLF line endings and multi-line data
    [events] = parseSse('event: x\r\ndata: a\r\ndata: b\r\n\r\n');
    assert.deepStrictEqual(events, [{ event: 'x', data: 'a\nb' }]);

    console.log('PASS: desktop SSE parser');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
