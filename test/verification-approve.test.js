// Standalone test (no test framework configured): run with `node test/verification-approve.test.js`
// Verifies that two moderators clicking at once produce exactly one roles.set,
// the second one sees "already handled", our own role change is recognised
// as ours (member is locked while roles.set runs), and members without a card
// (queued before stage 1 / while the bot was down) can still be approved.

const assert = require('assert');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const VerificationService = require('../src/modules/verification/VerificationService');

let cards;
let logged;

function setup() {
    GuildSettingsService.get = async guildId => ({
        guildId,
        unverifiedRoleId: 'unv',
        maleRoleId: 'male',
        femaleRoleId: 'female',
        verifyQueueChannelId: 'queue',
        modules: { verification: true }
    });

    cards = {};
    QueueCardService.get = async (guildId, userId) => (cards[userId] ? { ...cards[userId] } : null);
    QueueCardService.upsert = async card => { cards[card.userId] = { ...card }; return card; };

    logged = [];
    AuditLogService.log = async entry => { logged.push(entry); };
}

// Fake guild with one member; roles.set really replaces the role cache, like Discord
function makeGuild(roleIds) {
    const state = { setCalls: [], renders: 0, lockedDuringSet: false };
    const member = {
        id: 'u1',
        roles: {
            cache: new Map(roleIds.map(id => [id, {}])),
            set: async roles => {
                state.lockedDuringSet = VerificationService.isLocked('g1', 'u1');
                await new Promise(resolve => setTimeout(resolve, 150)); // slow Discord API
                state.setCalls.push(roles);
                member.roles.cache = new Map(roles.map(id => [id, {}]));
            }
        }
    };
    const moderator = { permissions: { has: () => true } };
    const guild = {
        id: 'g1',
        members: { fetch: async arg => (typeof arg === 'string' ? moderator : member) }
    };
    VerificationService.renderCard = async card => { state.renders++; return card; };
    return { guild, state };
}

async function concurrentClicks() {
    setup();
    cards.u1 = { guildId: 'g1', userId: 'u1', status: 'pending', messageId: 'm1', channelId: 'queue' };
    const { guild, state } = makeGuild(['everyone', 'unv']);

    const [first, second] = await Promise.all([
        VerificationService.approve(guild, 'u1', 'female', { id: 'kira', tag: 'Kira' }, 'discord'),
        VerificationService.approve(guild, 'u1', 'male', { id: 'bob', tag: 'Bob' }, 'discord')
    ]);

    assert.strictEqual(state.setCalls.length, 1, `Expected exactly 1 roles.set, got ${state.setCalls.length}`);
    assert.deepStrictEqual([...state.setCalls[0]].sort(), ['everyone', 'female']);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.code, 'already_handled');
    assert.strictEqual(second.card.handledBy, 'kira');
    assert.strictEqual(second.card.gender, 'female');
    assert.strictEqual(state.lockedDuringSet, true, 'member must be locked while our roles.set runs');
    assert.strictEqual(VerificationService.isLocked('g1', 'u1'), false, 'lock must be released');
    assert.deepStrictEqual(logged.map(e => e.action), ['verification.approved']);
}

async function cardlessMember() {
    setup();
    const { guild, state } = makeGuild(['everyone', 'unv']);

    const result = await VerificationService.approve(guild, 'u1', 'male', { id: 'kira', tag: 'Kira' }, 'panel');

    assert.strictEqual(result.ok, true, `cardless approve failed: ${result.code}`);
    assert.strictEqual(state.setCalls.length, 1);
    assert.strictEqual(cards.u1.status, 'approved', 'a card is recorded so the member shows in "handled today"');
    assert.strictEqual(cards.u1.messageId, null);
    assert.strictEqual(logged[0].source, 'panel');
}

async function notInQueue() {
    setup();
    const { guild, state } = makeGuild(['everyone', 'female']);

    const result = await VerificationService.approve(guild, 'u1', 'male', { id: 'kira', tag: 'Kira' }, 'panel');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'already_handled');
    assert.strictEqual(state.setCalls.length, 0);
}

async function undo() {
    setup();
    cards.u1 = { guildId: 'g1', userId: 'u1', status: 'pending', messageId: 'm1', channelId: 'queue' };
    const { guild, state } = makeGuild(['everyone', 'unv', 'booster']);
    const kira = { id: 'kira', tag: 'Kira' };

    await VerificationService.approve(guild, 'u1', 'female', kira, 'panel');

    // someone else can't undo Kira's decision
    const foreign = await VerificationService.undoApprove(guild, 'u1', { id: 'bob', tag: 'Bob' }, 'panel');
    assert.strictEqual(foreign.code, 'forbidden');

    const result = await VerificationService.undoApprove(guild, 'u1', kira, 'panel');
    assert.strictEqual(result.ok, true, `undo failed: ${result.code}`);
    assert.deepStrictEqual([...state.setCalls[1]].sort(), ['booster', 'everyone', 'unv'], 'gender role off, @unverified back');
    assert.strictEqual(cards.u1.status, 'pending');
    assert.strictEqual(cards.u1.messageId, 'm1', 'the Discord card is reopened, not replaced');
    assert.deepStrictEqual(logged.map(e => e.action), ['verification.approved', 'verification.undone']);

    // nothing left to undo
    assert.strictEqual((await VerificationService.undoApprove(guild, 'u1', kira, 'panel')).code, 'nothing_to_undo');

    // too late
    cards.u1 = { ...cards.u1, status: 'approved', gender: 'male', handledBy: 'kira', handledAt: new Date(Date.now() - 60000).toISOString() };
    assert.strictEqual((await VerificationService.undoApprove(guild, 'u1', kira, 'panel')).code, 'undo_expired');
}

(async () => {
    await concurrentClicks();
    await undo();
    await cardlessMember();
    await notInQueue();
    console.log('PASS: approve runs once per member, works without a card, ignores verified members, undo within window');
})().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
