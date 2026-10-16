// Standalone test (no test framework configured): run with `node test/panel-auth.test.js`
// Verifies the desktop login flow store: one-shot state, PKCE-bound one-time codes, expiry.

const assert = require('assert');
const crypto = require('node:crypto');
const { LoginFlowStore, pkceChallenge } = require('../src/web/v2/auth');

function run() {
    // RFC 7636 appendix B test vector
    assert.strictEqual(
        pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );

    let now = 1_000_000;
    const store = new LoginFlowStore(() => now);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);
    const user = { id: '42', username: 'kira' };

    // state is bound to the challenge and works once
    const state = store.startLogin(challenge);
    assert.strictEqual(store.consumeState(state), challenge);
    assert.strictEqual(store.consumeState(state), null, 'state must be one-shot');
    assert.strictEqual(store.consumeState('forged'), null);

    // code needs the matching verifier and works once
    let code = store.issueCode(user, challenge);
    assert.strictEqual(store.redeemCode(code, 'wrong-verifier'), null);
    assert.strictEqual(store.redeemCode(code, verifier), null, 'a failed attempt burns the code');

    code = store.issueCode(user, challenge);
    assert.deepStrictEqual(store.redeemCode(code, verifier), user);
    assert.strictEqual(store.redeemCode(code, verifier), null, 'code must be one-shot');

    // expiry: code lives 60 s, state 10 min
    code = store.issueCode(user, challenge);
    now += 61 * 1000;
    assert.strictEqual(store.redeemCode(code, verifier), null, 'expired code');

    const oldState = store.startLogin(challenge);
    now += 11 * 60 * 1000;
    assert.strictEqual(store.consumeState(oldState), null, 'expired state');

    console.log('PASS: desktop login flow (state, PKCE, one-time codes)');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
