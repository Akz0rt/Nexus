// Standalone test (no test framework configured): run with `node test/punish-real.test.js`
// The mockup's own case with the real ModerationService: the target already has a warn,
// «Флуд» (мут 10 мин + варн) makes it warn #2, escalation gives a 1 h mute — and the
// template's 10-minute mute must not shorten it.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const WarningService = require('../src/modules/moderation/WarningService');
const ModerationService = require('../src/modules/moderation/ModerationService');
const { cleanSteps, DEFAULT_PUNISH_TEMPLATES } = require('../src/modules/moderation/templates');

const HOUR = 60 * 60 * 1000;
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, {});
const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };
const warns = [{ id: 'w0', userId: 'grisha' }];
WarningService.add = async warn => { const doc = { ...warn, id: `w${warns.length}` }; warns.push(doc); return doc; };
WarningService.listActive = async (guildId, userId) => warns.filter(w => !userId || w.userId === userId);

function member(id, position, perms = () => false) {
    const m = {
        id, user: { id, bot: false, send: async () => {} }, displayName: id,
        roles: { highest: { position } }, permissions: { has: perms },
        moderatable: true, communicationDisabledUntilTimestamp: null,
        timeouts: [],
        timeout: async ms => { m.timeouts.push(ms); m.communicationDisabledUntilTimestamp = ms ? Date.now() + ms : null; }
    };
    return m;
}

(async () => {
    const mod = member('mod', 10, flag => flag === PermissionFlagsBits.ModerateMembers);
    const grisha = member('grisha', 1);
    const guild = { id: 'g', name: 'Тест', ownerId: 'owner', members: { fetch: async ({ user }) => ({ mod, grisha }[user]) } };

    const flood = cleanSteps(DEFAULT_PUNISH_TEMPLATES.find(t => t.id === 'flood').steps);
    const result = await ModerationService.punish(guild, 'grisha', flood, 'Флуд', { id: 'mod', tag: 'mod' }, 'panel');
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(result.steps.map(s => [s.kind, s.ok, Boolean(s.kept)]), [['warn', true, false], ['mute', true, true]]);
    assert.deepStrictEqual(grisha.timeouts, [HOUR], 'the escalation hour stays; the 10 minutes are not applied over it');
    assert.ok(grisha.communicationDisabledUntilTimestamp > Date.now() + 50 * 60 * 1000);

    // Without a longer mute running, the template's mute is applied as usual
    const fresh = member('fresh', 1);
    guild.members.fetch = async ({ user }) => ({ mod, fresh }[user]);
    const second = await ModerationService.punish(guild, 'fresh', flood, 'Флуд', { id: 'mod', tag: 'mod' }, 'panel');
    assert.deepStrictEqual(second.steps.map(s => [s.kind, s.ok, Boolean(s.kept)]), [['warn', true, false], ['mute', true, false]]);
    assert.deepStrictEqual(fresh.timeouts, [10 * 60 * 1000]);
    console.log('real punish tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
