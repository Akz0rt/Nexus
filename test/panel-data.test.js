// Standalone test (no test framework configured): run with `node test/panel-data.test.js`
// Verifies pure data helpers behind the panel API: queue merge, audit query
// building, member ID extraction and the timezone-aware "today".

const assert = require('assert');
const { mergeQueue } = require('../src/web/v2/serialize');
const { buildAuditQuery } = require('../src/services/AuditLogService');
const { extractId } = require('../src/web/v2/routes/members');
const { startOfToday } = require('../src/utils/dateUtils');

function run() {
    // mergeQueue: role holders are the queue; pending cards attach, others don't; bots dropped; oldest first
    const holders = [
        { id: 'b', joinedAt: '2026-10-16T12:00:00Z', bot: false },
        { id: 'a', joinedAt: '2026-10-15T12:00:00Z', bot: false },
        { id: 'c', joinedAt: '2026-10-16T13:00:00Z', bot: false },
        { id: 'robot', joinedAt: '2026-10-01T00:00:00Z', bot: true }
    ];
    const cards = [
        { userId: 'a', status: 'pending', createdAt: 'x', messageId: 'm' },
        { userId: 'c', status: 'approved', handledBy: 'kira' },
        { userId: 'gone', status: 'pending' }
    ];
    const queue = mergeQueue(holders, cards);
    assert.deepStrictEqual(queue.map(item => item.member.id), ['a', 'b', 'c']);
    assert.strictEqual(queue[0].card.status, 'pending');
    assert.strictEqual(queue[0].card.hasDiscordMessage, true);
    assert.strictEqual(queue[1].card, null, 'member without a card is still queued');
    assert.strictEqual(queue[2].card, null, 'stale non-pending card is not shown as the queue card');

    // buildAuditQuery: only given filters, all parameterised
    const q = buildAuditQuery({ guildId: 'g1', action: 'verification.approved', targetId: 'u1', source: '' });
    assert.strictEqual(
        q.query,
        'SELECT * FROM c WHERE c.guildId = @guildId AND c.action = @action AND ARRAY_CONTAINS(c.targetIds, @targetId) ORDER BY c.createdAt DESC'
    );
    assert.deepStrictEqual(q.parameters.map(p => p.name), ['@guildId', '@action', '@targetId']);
    assert.ok(!q.query.includes('u1'), 'values must not be inlined');

    // extractId
    assert.strictEqual(extractId('<@123456789012345678>'), '123456789012345678');
    assert.strictEqual(extractId('<@!123456789012345678>'), '123456789012345678');
    assert.strictEqual(extractId('123456789012345678'), '123456789012345678');
    assert.strictEqual(extractId('kira'), null);

    // startOfToday: 01:30 in Moscow (UTC+3) → midnight Moscow = 21:00 UTC the day before
    assert.strictEqual(
        startOfToday('Europe/Moscow', new Date('2026-10-16T22:30:00Z')).toISOString(),
        '2026-10-16T21:00:00.000Z'
    );
    assert.strictEqual(startOfToday('UTC', new Date('2026-10-16T22:30:00Z')).toISOString(), '2026-10-16T00:00:00.000Z');

    console.log('PASS: panel data helpers');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
