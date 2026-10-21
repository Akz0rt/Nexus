// Standalone test (no test framework configured): run with `node test/notification-dedup.test.js`
// Verifies that birthday congratulations are idempotent — calling the notifier
// twice in the same day must send exactly one message per birthday user — and
// that each server's daily run reads only its own list.

const assert = require('assert');

const CosmosDBService = require('../src/services/CosmosDBService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const NotificationService = require('../src/services/NotificationService');

async function run() {
    // --- Arrange: stub CosmosDB so no real network/DB is touched ---
    const congratulated = {}; // `${guildId}:${userId}` -> dateStr (persisted "already congratulated" marker)
    const lists = { g1: ['u1'], g2: [] };
    const asked = [];

    CosmosDBService.getTodaysBirthdays = async (guildId, timezone) => { asked.push([guildId, timezone]); return lists[guildId]; };
    CosmosDBService.getTodayDateString = () => '2026-06-08';
    CosmosDBService.wasCongratulatedOn = async (guildId, userId, dateStr) => congratulated[`${guildId}:${userId}`] === dateStr;
    CosmosDBService.markCongratulated = async (guildId, userId, dateStr) => { congratulated[`${guildId}:${userId}`] = dateStr; };
    GuildSettingsService.get = async guildId => ({ guildId, timezone: 'Asia/Tokyo', birthdayCongratsChannelId: 'c1' });

    // --- Arrange: fake Discord server with a channel that counts sends ---
    let sendCount = 0;
    const fakeMember = {
        displayName: 'Tester',
        user: { username: 'tester', displayAvatarURL: () => 'http://example/avatar.png' }
    };
    const guild = { id: 'g1', members: { fetch: async () => fakeMember }, channels: { cache: new Map() } };
    guild.channels.cache.set('c1', { id: 'c1', guild, isTextBased: () => true, send: async () => { sendCount++; } });

    // --- Act: simulate the startup check + the scheduled check on the same day ---
    await NotificationService.sendBirthdayNotifications(guild);
    await NotificationService.sendBirthdayNotifications(guild);

    // --- Assert ---
    assert.strictEqual(sendCount, 1, `Expected exactly 1 congratulation, got ${sendCount}`);
    assert.deepStrictEqual(asked, [['g1', 'Asia/Tokyo'], ['g1', 'Asia/Tokyo']], 'only this server\'s list, by its own calendar');
    console.log('PASS: birthday congratulation is idempotent (sent once across two checks)');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
