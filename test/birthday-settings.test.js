// Standalone test (no test framework configured): run with `node test/birthday-settings.test.js`
// Settings → «Дни рождения», часовой пояс, канал ИИ: every server saves its own, checked and applied
// at once (its daily check moves); Azure's values are the main server's defaults only.

const assert = require('assert');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
const MAIN = '900000000000000009';
Object.assign(config, {
    clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: MAIN,
    checkTime: '00:00', congratsChannel: '500000000000000009', timezone: 'Europe/Moscow', aiChannelId: '500000000000000008'
});

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const SchedulerService = require('../src/services/SchedulerService');
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
SchedulerService.start = (guild, options) => scheduled.push({ guildId: guild.id, ...options });

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
        guilds: { cache: new Map([[main.id, main], [other.id, other]]) }
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
        // Main server until saved: Azure's values, marked as such
        const before = await call(MAIN, 'GET');
        assert.strictEqual(before.body.values.birthdayGuild, true);
        assert.strictEqual(before.body.values.birthdayCheckTime, '00:00');
        assert.strictEqual(before.body.values.birthdayCongratsChannelId, '500000000000000009');
        assert.strictEqual(before.body.values.timezone, 'Europe/Moscow');
        assert.strictEqual(before.body.values.aiChannelId, '500000000000000008');
        assert.ok(before.body.values.fromEnv.includes('birthdayCongratsChannelId'));
        assert.ok(before.body.options.timezones.includes('Europe/Moscow'));

        // Another server: birthdays of its own (older apps read birthdayGuild), none of Azure's ids
        const otherBefore = (await call(other.id, 'GET')).body.values;
        assert.strictEqual(otherBefore.birthdayGuild, true);
        assert.strictEqual(otherBefore.birthdayCongratsChannelId, '', 'Azure channel never leaks to another server');
        assert.strictEqual(otherBefore.aiChannelId, '', 'Azure AI channel never leaks to another server');
        assert.deepStrictEqual(otherBefore.fromEnv, []);
        assert.strictEqual(otherBefore.timezone, 'Europe/Moscow', 'Azure TIMEZONE is everyone\'s default calendar');

        assert.strictEqual((await call(MAIN, 'PATCH', { birthdayCheckTime: '25:00' })).body.error, 'invalid_time');
        assert.strictEqual((await call(MAIN, 'PATCH', { birthdayCongratsChannelId: VOICE })).body.error, 'channel_not_found');
        assert.strictEqual((await call(MAIN, 'PATCH', { timezone: 'Mars/Olympus' })).body.error, 'invalid_timezone');
        assert.strictEqual((await call(MAIN, 'PATCH', { aiChannelId: VOICE })).body.error, 'channel_not_found');

        const saved = await call(MAIN, 'PATCH', { birthdayCheckTime: '09:00', birthdayCongratsChannelId: CONGRATS, birthdayAnnounceChannelId: '' });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(saved.body.values.birthdayCheckTime, '09:00');
        // Applied at once: the check moves to 09:00 without the startup catch-up run
        assert.deepStrictEqual(scheduled.at(-1), { guildId: MAIN, checkTime: '09:00', timezone: 'Europe/Moscow', initialCheck: false });

        // The other server sets its own time, zone and AI channel — the main one is untouched
        const otherSaved = await call(other.id, 'PATCH', { birthdayCheckTime: '08:15', timezone: 'Asia/Tokyo', aiChannelId: CONGRATS });
        assert.strictEqual(otherSaved.status, 200, JSON.stringify(otherSaved.body));
        assert.deepStrictEqual(scheduled.at(-1), { guildId: other.id, checkTime: '08:15', timezone: 'Asia/Tokyo', initialCheck: false });
        assert.strictEqual(otherSaved.body.values.aiChannelId, CONGRATS);
        assert.strictEqual((await call(MAIN, 'GET')).body.values.timezone, 'Europe/Moscow');
        assert.strictEqual((await call(MAIN, 'GET')).body.values.birthdayCheckTime, '09:00');

        // A channel cleared in the panel stays cleared — no fallback to Azure's
        const cleared = await call(MAIN, 'PATCH', { birthdayCongratsChannelId: '', aiChannelId: '' });
        assert.strictEqual(cleared.body.values.birthdayCongratsChannelId, '');
        assert.strictEqual(cleared.body.values.aiChannelId, '');
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
