// Standalone test (no test framework configured): run with `node test/panel-access.test.js`
// Verifies how Discord permissions map to panel roles.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');
const { panelRoleFromPermissions, hasRole } = require('../src/web/v2/access');

function perms(...flags) {
    const set = new Set(flags);
    return { has: flag => set.has(flag) };
}

function run() {
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.Administrator)), 'senior');
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.ManageRoles)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.KickMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.ModerateMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.BanMembers)), 'admin');
    assert.strictEqual(panelRoleFromPermissions(perms(PermissionFlagsBits.SendMessages)), 'none');
    assert.strictEqual(panelRoleFromPermissions(perms()), 'none');
    assert.strictEqual(panelRoleFromPermissions(null), 'none');

    assert.strictEqual(hasRole('senior', 'admin'), true);
    assert.strictEqual(hasRole('admin', 'admin'), true);
    assert.strictEqual(hasRole('admin', 'senior'), false);
    assert.strictEqual(hasRole('none', 'admin'), false);

    console.log('PASS: panel roles from Discord permissions');
}

try {
    run();
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
