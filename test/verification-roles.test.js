// Standalone test (no test framework configured): run with `node test/verification-roles.test.js`
// Verifies the pure role helpers used by the verification queue.

const assert = require('assert');
const { computeNewRoles, diffUnverified, shouldAssignUnverified } = require('../src/modules/verification/roles');

const ids = { unverifiedId: 'unv', maleId: 'male', femaleId: 'female' };

function fakeMember(roleIds, extra = {}) {
    const set = new Set(roleIds);
    return { roles: { cache: { has: id => set.has(id) } }, ...extra };
}

function run() {
    // computeNewRoles: keeps unrelated roles (incl. managed/booster), swaps unverified → gender
    assert.deepStrictEqual(
        computeNewRoles(['everyone', 'unv', 'booster'], ids, 'female').sort(),
        ['booster', 'everyone', 'female']
    );
    assert.deepStrictEqual(
        computeNewRoles(['everyone', 'unv'], ids, 'male').sort(),
        ['everyone', 'male']
    );

    // Removes the opposite gender role if it was there by mistake
    assert.deepStrictEqual(
        computeNewRoles(['unv', 'male', 'x'], ids, 'female').sort(),
        ['female', 'x']
    );

    // Idempotent when the target role is already present
    assert.deepStrictEqual(computeNewRoles(['female'], ids, 'female'), ['female']);

    assert.throws(() => computeNewRoles(['unv'], ids, 'other'), /Unknown gender/);
    assert.throws(() => computeNewRoles(['unv'], { ...ids, maleId: undefined }, 'male'), /not configured/);

    // diffUnverified
    assert.strictEqual(diffUnverified(fakeMember([]), fakeMember(['unv']), 'unv'), 'added');
    assert.strictEqual(diffUnverified(fakeMember(['unv']), fakeMember(['female']), 'unv'), 'removed');
    assert.strictEqual(diffUnverified(fakeMember(['unv']), fakeMember(['unv', 'x']), 'unv'), null);
    assert.strictEqual(diffUnverified(fakeMember([]), fakeMember(['x']), 'unv'), null);
    assert.strictEqual(diffUnverified(fakeMember([], { partial: true }), fakeMember(['unv']), 'unv'), null);
    assert.strictEqual(diffUnverified(fakeMember([]), fakeMember(['unv']), undefined), null);

    // shouldAssignUnverified
    const human = roles => fakeMember(roles, { user: { bot: false } });
    assert.strictEqual(shouldAssignUnverified(human([]), ids), true);
    assert.strictEqual(shouldAssignUnverified(human(['unv']), ids), false, 'third-party bot already gave it');
    assert.strictEqual(shouldAssignUnverified(human(['female']), ids), false, 'already verified');
    assert.strictEqual(shouldAssignUnverified(fakeMember([], { user: { bot: true } }), ids), false, 'bots skipped');
    assert.strictEqual(shouldAssignUnverified(human([]), { ...ids, unverifiedId: undefined }), false);

    console.log('PASS: verification role helpers');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
