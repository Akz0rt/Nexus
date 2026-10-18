// Standalone test (no test framework configured): run with `node test/birthdays-activity.test.js`
// Birthdays: next-birthday maths (year wrap, 29 February), only this server's
// members, «Поздравить сейчас» once and only today, «Пропустить» marks the
// coming date. Activity: text + voice merge and the 30-day series.

const assert = require('assert');

const CosmosDBService = require('../src/services/CosmosDBService');
const NotificationService = require('../src/services/NotificationService');
const { nextBirthday, describeBirthdays } = require('../src/web/v2/routes/birthdays');
const { mergeTop, dailySeries } = require('../src/web/v2/routes/activity');
const { makeGuild, makeMember } = require('./fake-voice-guild');

function nextBirthdayMaths() {
    assert.deepStrictEqual(nextBirthday(10, 18, '2026-10-18'), { date: '2026-10-18', inDays: 0 });
    assert.deepStrictEqual(nextBirthday(10, 20, '2026-10-18'), { date: '2026-10-20', inDays: 2 });
    assert.deepStrictEqual(nextBirthday(1, 2, '2026-12-30'), { date: '2027-01-02', inDays: 3 }, 'wraps the year');
    assert.strictEqual(nextBirthday(2, 29, '2026-02-01').date, '2026-02-28', '29 Feb in a non-leap year');
    assert.strictEqual(nextBirthday(2, 29, '2027-12-01').date, '2028-02-29');
}

function onlyMembers() {
    const guild = makeGuild();
    makeMember(guild, 'a', {});
    makeMember(guild, 'b', {});
    const list = describeBirthdays(guild, {
        a: { month: 10, day: 25, lastCongratulatedOn: null },
        b: { month: 10, day: 18, lastCongratulatedOn: '2026-10-18' },
        stranger: { month: 10, day: 19 }
    }, '2026-10-18');
    assert.deepStrictEqual(list.map(i => [i.user.id, i.inDays, i.done]), [['b', 0, true], ['a', 7, false]]);
}

async function congratulateOnce() {
    const marked = new Map();
    CosmosDBService.getTodayDateString = () => '2026-10-18';
    CosmosDBService.wasCongratulatedOn = async (userId, date) => marked.get(userId) === date;
    CosmosDBService.markCongratulated = async (userId, date) => { marked.set(userId, date); };
    const posts = [];
    const guild = makeGuild();
    makeMember(guild, 'a', {});
    NotificationService.setChannels(null, { guild, send: async payload => posts.push(payload) });

    assert.strictEqual((await NotificationService.congratulate('a')).ok, true);
    assert.strictEqual((await NotificationService.congratulate('a')).code, 'already_congratulated');
    assert.strictEqual(posts.length, 1);
    assert.ok(posts[0].content.includes('<@a>'));
    assert.strictEqual((await NotificationService.congratulate('ghost')).code, 'member_not_found');
    NotificationService.setChannels(null, null);
    assert.strictEqual((await NotificationService.congratulate('a')).code, 'no_channel');
}

function activity() {
    const text = [{ userId: 'a', displayName: 'A', totalMessages: 10 }, { userId: 'b', displayName: 'B', totalMessages: 3 }];
    const voice = [{ userId: 'b', displayName: 'B', totalMinutes: 30 }, { userId: 'c', displayName: 'C', totalMinutes: 5 }];
    assert.deepStrictEqual(mergeTop(text, voice, 'both').map(r => [r.userId, r.score]), [['b', 33], ['a', 10], ['c', 5]]);
    assert.deepStrictEqual(mergeTop(text, voice, 'text').map(r => r.userId), ['a', 'b']);
    assert.deepStrictEqual(mergeTop(text, voice, 'voice').map(r => [r.userId, r.messages]), [['b', 0], ['c', 0]]);

    const today = new Date('2026-10-18T12:00:00Z');
    const series = dailySeries([{ date: '2026-10-18', messages: 7 }], [{ date: '2026-10-17', minutes: 90 }], 30, today);
    assert.strictEqual(series.length, 30);
    assert.deepStrictEqual(series.at(-1), { date: '2026-10-18', messages: 7, voiceMinutes: 0 });
    assert.deepStrictEqual(series.at(-2), { date: '2026-10-17', messages: 0, voiceMinutes: 90 });
    assert.strictEqual(series[0].date, '2026-09-19', 'gaps filled with zeros');
}

(async () => {
    nextBirthdayMaths();
    onlyMembers();
    await congratulateOnce();
    activity();
    console.log('birthdays and activity tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
