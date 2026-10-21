// Standalone test (no test framework configured): run with `node test/birthdays-activity.test.js`
// Birthdays: next-birthday maths (year wrap, 29 February), only this server's
// members, «Поздравить сейчас» once and only today, «Пропустить» marks the
// coming date. Activity: text + voice merge and the 30-day series.

const assert = require('assert');

const CosmosDBService = require('../src/services/CosmosDBService');
const NotificationService = require('../src/services/NotificationService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const { nextBirthday, describeBirthdays } = require('../src/web/v2/routes/birthdays');
const { mergeTop, dailySeries, CHART_DAYS } = require('../src/web/v2/routes/activity');
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
    // Each server has its own list and «congratulated» marks
    const marked = new Map(); // `${guildId}:${userId}` -> date
    CosmosDBService.getTodayDateString = () => '2026-10-18';
    CosmosDBService.wasCongratulatedOn = async (guildId, userId, date) => marked.get(`${guildId}:${userId}`) === date;
    CosmosDBService.markCongratulated = async (guildId, userId, date) => { marked.set(`${guildId}:${userId}`, date); };
    const channels = {};
    GuildSettingsService.get = async guildId => ({ guildId, timezone: 'UTC', birthdayCongratsChannelId: channels[guildId] || '' });

    const makeServer = (id, channelId) => {
        const guild = makeGuild();
        guild.id = id;
        makeMember(guild, 'a', {});
        const posts = [];
        guild.channels.cache.set(channelId, { id: channelId, guild, isTextBased: () => true, send: async payload => posts.push(payload) });
        channels[id] = channelId;
        return { guild, posts };
    };
    const one = makeServer('g1', 'c1');
    const two = makeServer('g2', 'c2');

    assert.strictEqual((await NotificationService.congratulate(one.guild, 'a')).ok, true);
    assert.strictEqual((await NotificationService.congratulate(one.guild, 'a')).code, 'already_congratulated');
    assert.strictEqual(one.posts.length, 1);
    assert.ok(one.posts[0].content.includes('<@a>'));
    // Congratulated on server 1 doesn't count on server 2; each posts in its own channel
    assert.strictEqual((await NotificationService.congratulate(two.guild, 'a')).ok, true);
    assert.strictEqual(two.posts.length, 1);
    assert.strictEqual(one.posts.length, 1);

    assert.strictEqual((await NotificationService.congratulate(one.guild, 'ghost')).code, 'member_not_found');
    // A channel of another server is never used
    channels.g1 = 'c2';
    marked.clear();
    assert.strictEqual((await NotificationService.congratulate(one.guild, 'a')).code, 'no_channel');
    channels.g1 = '';
    assert.strictEqual((await NotificationService.congratulate(one.guild, 'a')).code, 'no_channel');
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
    // The charts follow the chosen period
    assert.deepStrictEqual(CHART_DAYS, { day: 7, week: 7, month: 30 });
    const week = dailySeries([], [], CHART_DAYS.week, today);
    assert.strictEqual(week.length, 7);
    assert.strictEqual(week[0].date, '2026-10-12');
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
