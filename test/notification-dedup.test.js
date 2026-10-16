// Standalone test (no test framework configured): run with `node test/notification-dedup.test.js`
// Verifies that birthday congratulations are idempotent — calling the notifier
// twice in the same day must send exactly one message per birthday user.

const assert = require('assert');

const CosmosDBService = require('../src/services/CosmosDBService');
const NotificationService = require('../src/services/NotificationService');

async function run() {
    // --- Arrange: stub CosmosDB so no real network/DB is touched ---
    const congratulated = {}; // userId -> dateStr (persisted "already congratulated" marker)

    CosmosDBService.getTodaysBirthdays = async () => ['u1'];
    CosmosDBService.getTodayDateString = () => '2026-06-08';
    CosmosDBService.wasCongratulatedOn = async (userId, dateStr) => congratulated[userId] === dateStr;
    CosmosDBService.markCongratulated = async (userId, dateStr) => { congratulated[userId] = dateStr; };

    // --- Arrange: fake Discord channel that counts sends ---
    let sendCount = 0;
    const fakeMember = {
        displayName: 'Tester',
        user: { username: 'tester', displayAvatarURL: () => 'http://example/avatar.png' }
    };
    const fakeChannel = {
        guild: { members: { fetch: async () => fakeMember } },
        send: async () => { sendCount++; }
    };
    NotificationService.setChannels(fakeChannel, fakeChannel);

    // --- Act: simulate the startup check + the scheduled check on the same day ---
    await NotificationService.sendBirthdayNotifications();
    await NotificationService.sendBirthdayNotifications();

    // --- Assert ---
    assert.strictEqual(sendCount, 1, `Expected exactly 1 congratulation, got ${sendCount}`);
    console.log('PASS: birthday congratulation is idempotent (sent once across two checks)');
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
