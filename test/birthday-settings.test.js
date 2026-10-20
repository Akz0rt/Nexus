// Standalone test (no test framework configured): run with `node test/birthday-settings.test.js`
// Settings → «Дни рождения»: the time and channels are saved for the main server only, checked,
// and applied at once (the daily check moves, the channels switch); until saved, Azure's values.

const assert = require('assert');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
const MAIN = '900000000000000009';
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: MAIN, checkTime: '00:00', congratsChannel: '500000000000000009' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const SchedulerService = require('../src/services/SchedulerService');
const NotificationService = require('../src/services/NotificationService');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const CONGRATS = '500000000000000001';
const VOICE = '500000000000000002';

const docs = {};
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, docs[guildId] || {});
GuildSettingsService.update = async (guildId, patch) => { docs[guildId] = { ...(docs[guildId] || {}), ...patch }; return docs[guildId]; };
AuditLogService.log = async entry => entry;
const scheduled = [];
SchedulerService.start = options => scheduled.push(options);
let channels = null;
NotificationService.setChannels = (announce, congrats) => { channels = { announce: announce?.id || null, congrats: congrats?.id || null }; };

function guildWith(id) {
    const guild = makeGuild();
    guild.id = id;
    guild.iconURL = () => null;
    const text = { id: CONGRATS, name: 'поздравления', type: ChannelType.GuildText, isTextBased: () => true };
    guild.channels.cache.set(CONGRATS, text);
    guild.channels.cache.set(VOICE, { id: VOICE, name: 'голос', type: ChannelType.GuildVoice, isTextBased: () => false });
    makeMember(guild, ADMIN, { position: 10, perms: flag => flag === PermissionFlagsBits.Administrator });
    guild.members.me.roles = { highest: { position: 50 } };
    guild.memberCount = guild.members.cache.size;
    return guild;
}

(async () => {
    const main = guildWith(MAIN);
    const other = guildWith('900000000000000010');
    PanelSessionService.get = async token => (token === 'admin' ? { userId: ADMIN, username: 'admin' } : null);
    state.client = {
        isReady: () => true,
        guilds: { cache: new Map([[main.id, main], [other.id, other]]) },
        channels: { fetch: async id => main.channels.cache.get(id) || null }
    };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const call = async (guildId, method, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/guilds/${guildId}/settings`, {
            method, headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        // Until saved: Azure's values, marked as such
        const before = await call(MAIN, 'GET');
        assert.strictEqual(before.body.values.birthdayGuild, true);
        assert.strictEqual(before.body.values.birthdayCheckTime, '00:00');
        assert.strictEqual(before.body.values.birthdayCongratsChannelId, '500000000000000009');
        assert.ok(before.body.values.fromEnv.includes('birthdayCongratsChannelId'));
        assert.strictEqual((await call(other.id, 'GET')).body.values.birthdayGuild, false);

        assert.strictEqual((await call(MAIN, 'PATCH', { birthdayCheckTime: '25:00' })).body.error, 'invalid_time');
        assert.strictEqual((await call(MAIN, 'PATCH', { birthdayCongratsChannelId: VOICE })).body.error, 'channel_not_found');
        assert.strictEqual((await call(other.id, 'PATCH', { birthdayCheckTime: '09:00' })).body.error, 'not_birthday_guild');

        const saved = await call(MAIN, 'PATCH', { birthdayCheckTime: '09:00', birthdayCongratsChannelId: CONGRATS, birthdayAnnounceChannelId: '' });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(saved.body.values.birthdayCheckTime, '09:00');
        // Applied at once: the check moves to 09:00 without the startup catch-up run, the channel switches
        assert.deepStrictEqual(scheduled.at(-1), { checkTime: '09:00', initialCheck: false });
        assert.strictEqual(channels.congrats, CONGRATS);
        // A channel cleared in the panel stays cleared — no fallback to Azure's
        const cleared = await call(MAIN, 'PATCH', { birthdayCongratsChannelId: '' });
        assert.strictEqual(cleared.body.values.birthdayCongratsChannelId, '');
        assert.ok(!cleared.body.values.fromEnv.includes('birthdayCongratsChannelId'));
        // An unchanged (Azure) channel isn't re-checked: changing only the time works
        delete docs[MAIN];
        assert.strictEqual((await call(MAIN, 'PATCH', { birthdayCheckTime: '10:30', birthdayCongratsChannelId: '500000000000000009' })).status, 200);
        console.log('birthday settings tests passed');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
