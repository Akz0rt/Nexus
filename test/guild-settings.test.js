// Standalone test (no test framework configured): run with `node test/guild-settings.test.js`
// Verifies per-guild settings resolution: guild doc → env (default guild only) → undefined.

const assert = require('assert');

const config = require('../src/config');
const GuildSettingsService = require('../src/services/GuildSettingsService');

async function run() {
    // --- Arrange: env defaults for the default guild, no real Cosmos ---
    Object.assign(config, {
        guildId: 'g-default',
        unverifiedRoleId: 'env-unv',
        maleRoleId: 'env-male',
        femaleRoleId: 'env-female',
        verifyQueueChannelId: 'env-queue',
        moduleVerificationEnabled: undefined
    });

    const docs = {
        'g-default': { guildId: 'g-default', verifyQueueChannelId: 'db-queue' },
        'g-other': { guildId: 'g-other', unverifiedRoleId: 'other-unv', modules: { verification: false } }
    };
    GuildSettingsService.readDoc = async guildId => docs[guildId] || null;

    // Default guild: DB value wins, env fills the gaps
    const def = await GuildSettingsService.get('g-default');
    assert.strictEqual(def.verifyQueueChannelId, 'db-queue');
    assert.strictEqual(def.unverifiedRoleId, 'env-unv');
    assert.strictEqual(def.maleRoleId, 'env-male');
    assert.strictEqual(def.modules.verification, true, 'enabled by default when unverified role is set');

    // Other guild: env never leaks into it
    const other = await GuildSettingsService.get('g-other');
    assert.strictEqual(other.unverifiedRoleId, 'other-unv');
    assert.strictEqual(other.maleRoleId, undefined);
    assert.strictEqual(other.verifyQueueChannelId, undefined);
    assert.strictEqual(other.modules.verification, false);

    // Unknown guild: nothing configured, module off
    const unknown = await GuildSettingsService.get('g-unknown');
    assert.strictEqual(unknown.unverifiedRoleId, undefined);
    assert.strictEqual(unknown.modules.verification, false);

    // Assigning @unverified on join is on by default; ASSIGN_UNVERIFIED_ON_JOIN=false turns it off
    assert.strictEqual(def.assignUnverifiedOnJoin, true);
    config.assignUnverifiedOnJoin = 'false';
    GuildSettingsService.cache.clear();
    assert.strictEqual((await GuildSettingsService.get('g-default')).assignUnverifiedOnJoin, false);
    assert.strictEqual((await GuildSettingsService.get('g-other')).assignUnverifiedOnJoin, true, 'env does not leak');

    // MODULE_VERIFICATION_ENABLED=false turns the module off for the default guild
    config.moduleVerificationEnabled = 'false';
    GuildSettingsService.cache.clear();
    assert.strictEqual((await GuildSettingsService.get('g-default')).modules.verification, false);

    console.log('PASS: guild settings resolution');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
