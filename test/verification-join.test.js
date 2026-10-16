// Standalone test (no test framework configured): run with `node test/verification-join.test.js`
// Verifies that on join the bot gives @unverified only if nobody else did it first.

const assert = require('assert');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const VerificationService = require('../src/modules/verification/VerificationService');

let settings;
GuildSettingsService.get = async guildId => ({ guildId, ...settings });
AuditLogService.log = async () => {};

function makeMember(roleIds, { bot = false } = {}) {
    const added = [];
    const member = {
        id: 'u1',
        user: { bot, tag: 'newbie' },
        roles: { cache: new Set(roleIds), add: async id => { added.push(id); } }
    };
    member.guild = { id: 'g1' };
    return { member, added };
}

async function run() {
    settings = {
        unverifiedRoleId: 'unv',
        maleRoleId: 'male',
        femaleRoleId: 'female',
        verifyQueueChannelId: 'queue',
        modules: { verification: true },
        assignUnverifiedOnJoin: true
    };

    // Nobody gave the role → we give it
    let t = makeMember([]);
    assert.strictEqual(await VerificationService.assignOnJoin(t.member), 'assigned');
    assert.deepStrictEqual(t.added, ['unv']);

    // Third-party bot already gave it → skip
    t = makeMember(['unv']);
    assert.strictEqual(await VerificationService.assignOnJoin(t.member), 'skipped');
    assert.deepStrictEqual(t.added, []);

    // Bots are never touched
    t = makeMember([], { bot: true });
    assert.strictEqual(await VerificationService.assignOnJoin(t.member), 'skipped');
    assert.deepStrictEqual(t.added, []);

    // Feature switched off → skip
    settings.assignUnverifiedOnJoin = false;
    t = makeMember([]);
    assert.strictEqual(await VerificationService.assignOnJoin(t.member), 'skipped');
    assert.deepStrictEqual(t.added, []);

    console.log('PASS: @unverified on join is given only when missing');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
