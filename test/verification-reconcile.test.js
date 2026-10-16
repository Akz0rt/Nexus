// Standalone test (no test framework configured): run with `node test/verification-reconcile.test.js`
// Verifies that the startup rebuild never posts to the queue channel: members who already
// hold @unverified get no new card, stale pending cards are only closed.

const assert = require('assert');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const VerificationService = require('../src/modules/verification/VerificationService');

function fakeMember(id, roleIds) {
    return {
        id,
        nickname: null,
        joinedAt: new Date(),
        user: {
            bot: false,
            username: id,
            avatar: 'a',
            createdTimestamp: Date.now() - 365 * 24 * 60 * 60 * 1000,
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
        },
        roles: { cache: new Set(roleIds) }
    };
}

async function run() {
    GuildSettingsService.get = async guildId => ({
        guildId,
        unverifiedRoleId: 'unv',
        verifyQueueChannelId: 'queue',
        modules: { verification: true }
    });

    // old-unv: still unverified, no card → must NOT get a card
    // kept: pending and still unverified → untouched
    // verified: pending but role removed while offline → closed
    // gone: pending but left the server → left
    const cards = {
        kept: { guildId: 'g1', userId: 'kept', status: 'pending', messageId: 'm1' },
        verified: { guildId: 'g1', userId: 'verified', status: 'pending', messageId: 'm2' },
        gone: { guildId: 'g1', userId: 'gone', status: 'pending', messageId: 'm3' }
    };
    QueueCardService.get = async (guildId, userId) => (cards[userId] ? { ...cards[userId] } : null);
    QueueCardService.listPending = async () => Object.values(cards).filter(c => c.status === 'pending');
    QueueCardService.upsert = async card => { cards[card.userId] = { ...card }; return card; };
    AuditLogService.log = async () => {};

    let sent = 0;
    let edited = 0;
    const channel = {
        id: 'queue',
        isTextBased: () => true,
        send: async () => { sent++; return { id: 'new' }; },
        messages: { edit: async () => { edited++; } }
    };
    const members = new Map([
        ['old-unv', fakeMember('old-unv', ['unv'])],
        ['kept', fakeMember('kept', ['unv'])],
        ['verified', fakeMember('verified', ['female'])]
    ]);
    const guild = {
        id: 'g1',
        client: { channels: { fetch: async () => channel } },
        members: { fetch: async () => members }
    };

    const result = await VerificationService.reconcile(guild);

    assert.strictEqual(sent, 0, `Startup must not post to the queue channel, sent ${sent}`);
    assert.strictEqual(cards['old-unv'], undefined, 'no card for members who already had the role');
    assert.strictEqual(cards.kept.status, 'pending');
    assert.strictEqual(cards.verified.status, 'closed');
    assert.strictEqual(cards.gone.status, 'left');
    assert.strictEqual(edited, 2, 'closed cards are edited in place');
    assert.deepStrictEqual(result, { closed: 2, queued: 1 });

    console.log('PASS: startup rebuild posts nothing, only closes stale cards');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
