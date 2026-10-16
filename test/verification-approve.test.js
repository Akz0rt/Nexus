// Standalone test (no test framework configured): run with `node test/verification-approve.test.js`
// Verifies that two moderators clicking at once produce exactly one roles.set,
// the second one sees "already handled", and our own role change is recognised
// as ours (member is locked while roles.set runs).

const assert = require('assert');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const VerificationService = require('../src/modules/verification/VerificationService');

async function run() {
    // --- Arrange: stub settings, cards, audit log and card rendering ---
    GuildSettingsService.get = async guildId => ({
        guildId,
        unverifiedRoleId: 'unv',
        maleRoleId: 'male',
        femaleRoleId: 'female',
        verifyQueueChannelId: 'queue',
        modules: { verification: true }
    });

    const cards = { u1: { guildId: 'g1', userId: 'u1', status: 'pending', messageId: 'm1', channelId: 'queue' } };
    QueueCardService.get = async (guildId, userId) => (cards[userId] ? { ...cards[userId] } : null);
    QueueCardService.upsert = async card => { cards[card.userId] = { ...card }; return card; };

    const logged = [];
    AuditLogService.log = async entry => { logged.push(entry); };
    VerificationService.renderCard = async card => card;

    // --- Arrange: fake guild with one unverified member ---
    const setCalls = [];
    let lockedDuringSet = false;
    const member = {
        id: 'u1',
        roles: {
            cache: new Map([['everyone', {}], ['unv', {}]]),
            set: async roles => {
                lockedDuringSet = VerificationService.isLocked('g1', 'u1');
                await new Promise(resolve => setTimeout(resolve, 150)); // slow Discord API
                setCalls.push(roles);
            }
        }
    };
    const moderator = { permissions: { has: () => true } };
    const guild = {
        id: 'g1',
        members: { fetch: async arg => (typeof arg === 'string' ? moderator : member) }
    };

    // --- Act: two moderators click at the same time ---
    const [first, second] = await Promise.all([
        VerificationService.approve(guild, 'u1', 'female', { id: 'kira', tag: 'Kira' }, 'discord'),
        VerificationService.approve(guild, 'u1', 'male', { id: 'bob', tag: 'Bob' }, 'discord')
    ]);

    // --- Assert ---
    assert.strictEqual(setCalls.length, 1, `Expected exactly 1 roles.set, got ${setCalls.length}`);
    assert.deepStrictEqual(setCalls[0].sort(), ['everyone', 'female']);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.code, 'already_handled');
    assert.strictEqual(second.card.handledBy, 'kira');
    assert.strictEqual(second.card.gender, 'female');
    assert.strictEqual(lockedDuringSet, true, 'member must be locked while our roles.set runs');
    assert.strictEqual(VerificationService.isLocked('g1', 'u1'), false, 'lock must be released');
    assert.deepStrictEqual(logged.map(e => e.action), ['verification.approved']);

    console.log('PASS: concurrent approve runs once; second click sees who handled it');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
