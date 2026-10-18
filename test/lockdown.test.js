// Standalone test (no test framework configured): run with `node test/lockdown.test.js`
// Lockdown pauses invites and sets slowmode, then restores exactly what was there
// (invites already paused stay paused, old slowmode comes back); admins only.

const assert = require('assert');
const { GuildFeature, PermissionFlagsBits } = require('discord.js');

const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const LockdownService = require('../src/modules/lockdown/LockdownService');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const MOD = '100000000000000002';
const START = '600000000000000001';
const RULES = '600000000000000002';

let doc;
let logged;
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, doc);
GuildSettingsService.update = async (guildId, patch) => { doc = { ...doc, ...patch }; return doc; };
AuditLogService.log = async entry => { logged.push(entry); return entry; };

function setup({ invitesPaused = false } = {}) {
    doc = { lockdown: { channelIds: [START, RULES], slowmodeSeconds: 60 } };
    logged = [];
    const guild = makeGuild();
    guild.features = invitesPaused ? [GuildFeature.InvitesDisabled] : ['COMMUNITY'];
    guild.edits = [];
    guild.edit = async ({ features }) => { guild.edits.push(features); guild.features = features; };
    const textChannel = (id, name, slowmode) => {
        const channel = {
            id, name, rateLimitPerUser: slowmode, calls: [],
            setRateLimitPerUser: async seconds => { channel.calls.push(seconds); channel.rateLimitPerUser = seconds; }
        };
        guild.channels.cache.set(id, channel);
        return channel;
    };
    textChannel(START, 'старт', 0);
    textChannel(RULES, 'правила', 120); // already slower than the lockdown's 60 s
    makeMember(guild, ADMIN, { perms: flag => flag === PermissionFlagsBits.Administrator });
    makeMember(guild, MOD, { perms: flag => flag === PermissionFlagsBits.KickMembers });
    return guild;
}

const admin = { id: ADMIN, tag: 'admin' };

async function roundTrip() {
    const guild = setup();
    const on = await LockdownService.enable(guild, admin, 'panel');
    assert.strictEqual(on.ok, true);
    assert.ok(guild.features.includes(GuildFeature.InvitesDisabled));
    assert.ok(guild.features.includes('COMMUNITY'), 'other features are kept');
    assert.strictEqual(guild.channels.cache.get(START).rateLimitPerUser, 60);
    assert.deepStrictEqual(guild.channels.cache.get(RULES).calls, [], 'a slower slowmode is left alone');
    assert.strictEqual(on.status.active, true);
    assert.deepStrictEqual(on.status.channels, [{ id: START, name: 'старт' }, { id: RULES, name: 'правила' }], 'the banner gets channel names');
    assert.strictEqual(logged[0].action, 'server.lockdown_on');
    assert.strictEqual((await LockdownService.enable(guild, admin, 'panel')).code, 'already_active');

    const off = await LockdownService.disable(guild, admin, 'panel');
    assert.strictEqual(off.ok, true);
    assert.ok(!guild.features.includes(GuildFeature.InvitesDisabled));
    assert.strictEqual(guild.channels.cache.get(START).rateLimitPerUser, 0);
    assert.strictEqual(guild.channels.cache.get(RULES).rateLimitPerUser, 120);
    assert.strictEqual(off.status.active, false);
    assert.strictEqual(logged[1].action, 'server.lockdown_off');
    assert.strictEqual((await LockdownService.disable(guild, admin, 'panel')).code, 'not_active');
}

async function invitesAlreadyPaused() {
    const guild = setup({ invitesPaused: true });
    await LockdownService.enable(guild, admin, 'panel');
    assert.deepStrictEqual(guild.edits, [], 'no need to pause twice');
    await LockdownService.disable(guild, admin, 'panel');
    assert.ok(guild.features.includes(GuildFeature.InvitesDisabled), 'paused before → stays paused');
}

async function guards() {
    const guild = setup();
    assert.strictEqual((await LockdownService.enable(guild, { id: MOD }, 'panel')).code, 'forbidden');
    guild.members.me.permissions = { has: flag => flag !== PermissionFlagsBits.ManageGuild };
    assert.strictEqual((await LockdownService.enable(guild, admin, 'panel')).code, 'bot_missing_manage_guild');
    guild.members.me.permissions = { has: () => true };
    // A deleted start channel is reported, the rest still works
    guild.channels.cache.delete(RULES);
    const on = await LockdownService.enable(guild, admin, 'panel');
    assert.strictEqual(on.ok, true);
    assert.deepStrictEqual(on.failed.map(f => f.code), ['channel_not_found']);
}

(async () => {
    await roundTrip();
    await invitesAlreadyPaused();
    await guards();
    console.log('lockdown tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
