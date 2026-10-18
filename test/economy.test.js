// Standalone test (no test framework configured): run with `node test/economy.test.js`
// Levels and coins: the curve (old bot's up to 50, then prestige), credits with
// level-ups and rewards, concurrent writes, hand adjustments, who earns in voice,
// the message cooldown and the level-up announcement with level roles.

const assert = require('assert');
const { ChannelType, Collection } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const EconomyService = require('../src/modules/economy/EconomyService');
const economy = require('../src/modules/economy');
const curve = require('../src/modules/economy/curve');
const { sanitizeSettings } = require('../src/web/v2/routes/economy');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const G = '900000000000000001';
const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';

// ---- in-memory store with etags ----
const docs = new Map();
const txs = [];
let version = 0;
let raceOnce = null; // userId whose next write loses a race once
EconomyService.initialize = async () => {};
EconomyService.readRaw = async (guildId, userId) => {
    const saved = docs.get(`${guildId}:${userId}`);
    return saved ? { doc: { ...saved.doc }, etag: saved.etag } : null;
};
EconomyService.writeRaw = async (doc, etag) => {
    const key = `${doc.guildId}:${doc.id}`;
    const saved = docs.get(key);
    if (raceOnce === doc.id) {
        raceOnce = null;
        // Someone else credited 7 coins in between
        docs.set(key, { doc: { ...(saved?.doc || EconomyService.blankAccount(doc.guildId, doc.id)), money: (saved?.doc.money || 0) + 7 }, etag: `e${++version}` });
        throw Object.assign(new Error('precondition'), { code: saved ? 412 : 409 });
    }
    if (etag ? saved?.etag !== etag : saved) throw Object.assign(new Error('race'), { code: etag ? 412 : 409 });
    docs.set(key, { doc: { ...doc }, etag: `e${++version}` });
};
EconomyService.addTransactions = async entries => { txs.push(...entries); };
const audit = [];
AuditLogService.log = async entry => { audit.push(entry); return entry; };

function curveMatchesOldBot() {
    assert.strictEqual(curve.levelCost(1), 5000);
    assert.strictEqual(curve.levelCost(49), 245000);
    assert.strictEqual(curve.levelCost(50), curve.PRESTIGE_EXP, 'at the top level the next step is a prestige');
    assert.strictEqual(curve.expToReach(2), 5000);
    assert.strictEqual(curve.expToReach(26), 1625000);
    assert.strictEqual(curve.levelReward(2), 100);
    assert.strictEqual(curve.levelReward(26), 2500, 'as in the old history: level 26 paid 2500');
    // Rows from the dump keep their level and exp under the new curve
    assert.deepStrictEqual(curve.fromTotal(2971), { level: 1, exp: 2971, prestige: 0 });
    assert.deepStrictEqual(curve.fromTotal(curve.expToReach(26) + 24427), { level: 26, exp: 24427, prestige: 0 });
    // A veteran of level 84 under the old curve: 50 and prestige from the rest
    const total = 2500 * 84 * 83 + 308842;
    assert.deepStrictEqual(curve.fromTotal(total), { level: 50, exp: (total - curve.expToReach(50)) % 500000, prestige: 23 });
    const step = curve.addExp({ level: 49, exp: 244990, prestige: 0 }, 500020);
    assert.deepStrictEqual([step.level, step.prestige, step.exp, step.reached, step.prestiges], [50, 1, 10, [50], 1]);
    assert.strictEqual(step.rewards, 4900 + curve.PRESTIGE_REWARD);
}

async function credits() {
    const member = { id: A, displayName: 'Аня', user: { username: 'anya' } };
    let result = await EconomyService.credit(G, member, { exp: 4990, money: 1, voiceSeconds: 60 });
    assert.deepStrictEqual([result.account.level, result.reached], [1, []]);
    result = await EconomyService.credit(G, member, { exp: 60, money: 1, voiceSeconds: 60 });
    assert.deepStrictEqual([result.account.level, result.account.exp, result.reached], [2, 50, [2]]);
    assert.strictEqual(result.account.money, 1 + 1 + 100, 'level 2 pays 100 in the same write');
    assert.strictEqual(result.account.displayName, 'Аня');
    assert.strictEqual(result.account.totalExp, 5050);
    assert.deepStrictEqual(txs.map(t => [t.amount, t.balance, t.kind]), [[100, 102, 'level']]);

    // A big gain crosses several levels: each reward is journaled with its own balance
    result = await EconomyService.credit(G, member, { exp: 25000 });
    assert.deepStrictEqual(result.reached, [3, 4]);
    assert.deepStrictEqual(txs.slice(-2).map(t => [t.amount, t.balance]), [[200, 302], [300, 602]]);

    // A concurrent write in between is not lost
    raceOnce = A;
    result = await EconomyService.credit(G, member, { exp: 0, money: 5 });
    assert.strictEqual(result.account.money, 602 + 7 + 5);
}

async function adjustments() {
    const guild = makeGuild();
    makeMember(guild, B, {});
    const mod = { id: '100000000000000001', tag: 'mod' };
    assert.strictEqual((await EconomyService.adjust(guild, B, 0, 'x', mod)).code, 'invalid_amount');
    assert.strictEqual((await EconomyService.adjust(guild, B, 50, '  ', mod)).code, 'invalid_reason');
    assert.strictEqual((await EconomyService.adjust(guild, B, -1, 'штраф', mod)).code, 'insufficient_funds', 'never below zero');
    let result = await EconomyService.adjust(guild, B, 500, 'Победа в ивенте', mod);
    assert.strictEqual(result.account.money, 500);
    result = await EconomyService.adjust(guild, B, -200, 'Штраф', mod);
    assert.strictEqual(result.account.money, 300);
    assert.deepStrictEqual(txs.slice(-2).map(t => [t.amount, t.balance, t.actorId]), [[500, 500, mod.id], [-200, 300, mod.id]]);
    assert.deepStrictEqual(audit.slice(-2).map(e => e.action), ['economy.given', 'economy.taken']);
    const stranger = '300000000000000009';
    guild.members.fetch = async () => null;
    assert.strictEqual((await EconomyService.adjust(guild, stranger, 5, 'x', mod)).code, 'member_not_found');
}

function voiceRules() {
    const guild = makeGuild();
    guild.afkChannelId = 'afk';
    const channel = (id, members) => {
        guild.channels.cache.set(id, { id, type: ChannelType.GuildVoice, members: new Collection(members.map(m => [m.id, m])) });
    };
    const person = (id, voice = {}, bot = false) => ({ id, user: { bot }, voice });
    channel('duo', [person('1'), person('2')]);
    channel('alone', [person('3'), person('bot', {}, true)]);
    channel('afk', [person('4'), person('5')]);
    channel('deaf', [person('6'), person('7', { selfDeaf: true })]);
    channel('trio', [person('8'), person('9'), person('10', { serverDeaf: true })]);
    guild.channels.cache.set('text', { id: 'text', type: ChannelType.GuildText, members: new Collection() });
    assert.deepStrictEqual(economy.earningVoiceMembers(guild).map(m => m.id).sort(), ['1', '2', '8', '9']);
}

async function messagesAndLevelUps() {
    const guild = makeGuild();
    const member = makeMember(guild, C, {});
    const sent = [];
    guild.channels.cache.set('levels', { id: 'levels', isTextBased: () => true, send: async payload => { sent.push(payload); } });
    guild.roles.cache.set('r2', { id: 'r2', name: 'Новичок', editable: true, managed: false });
    guild.roles.cache.set('r9', { id: 'r9', name: 'Ветеран', editable: true, managed: false });
    let settings = { enabled: false, channelId: 'levels', levelRoles: [{ level: 2, roleId: 'r2' }, { level: 9, roleId: 'r9' }] };
    GuildSettingsService.get = async () => ({ economy: settings });
    const message = (content, bot = false) => ({ guild, author: { id: C, bot }, member, content });

    assert.strictEqual(await economy.onMessage(message('привет всем'), 101000), null, 'off until enabled');
    settings = { ...settings, enabled: true };
    assert.strictEqual(await economy.onMessage(message('ок'), 101000), null, 'too short');
    assert.strictEqual(await economy.onMessage(message('привет всем', true), 101000), null, 'bots earn nothing');
    let result = await economy.onMessage(message('привет всем'), 101000);
    assert.deepStrictEqual([result.account.exp, result.account.money, result.account.messages], [60, 1, 1]);
    assert.strictEqual(await economy.onMessage(message('ещё сообщение'), 130000), null, 'once a minute');
    result = await economy.onMessage(message('ещё сообщение'), 162000);
    assert.strictEqual(result.account.messages, 2);

    // Push the member to the edge of level 2: the next message levels up
    const key = `${guild.id}:${C}`;
    docs.get(key).doc.exp = 4990;
    result = await economy.onMessage(message('и ещё одно'), 230000);
    assert.deepStrictEqual(result.reached, [2]);
    assert.ok(member.roles.cache.has('r2') && !member.roles.cache.has('r9'), 'only the roles reached');
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].embeds[0].data.description, /2 уровня/);
    assert.match(sent[0].embeds[0].data.description, /100/);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] }, 'the announcement pings no one');
    assert.strictEqual(economy.levelLabel({ level: 50, prestige: 3 }), '50 ★3');
}

async function leaving() {
    const guild = makeGuild();
    const member = makeMember(guild, '200000000000000077', {});
    await EconomyService.credit(guild.id, member, { exp: 100, money: 40 });
    const key = `${guild.id}:${member.id}`;
    await EconomyService.markLeft(guild.id, member.id);
    let doc = docs.get(key).doc;
    assert.ok(doc.leftAt && doc.displayName === null && doc.username === null, 'left: no name');
    assert.strictEqual(doc.money, 40, 'coins kept in case they come back');
    assert.strictEqual(await EconomyService.markLeft(guild.id, '200000000000000078'), null, 'no account, nothing created');
    assert.ok(!docs.has(`${guild.id}:200000000000000078`));
    await EconomyService.markReturned(guild.id, member);
    doc = docs.get(key).doc;
    assert.deepStrictEqual([doc.leftAt, doc.displayName, doc.money], [null, member.displayName, 40]);

    // Left while the bot was offline: the daily check notices
    EconomyService.presentIds = async () => [member.id, '200000000000000079'];
    docs.set(`${guild.id}:200000000000000079`, { doc: { ...EconomyService.blankAccount(guild.id, '200000000000000079'), displayName: 'Ушедший' }, etag: 'x' });
    guild.members.fetch = async () => guild.members.cache;
    assert.strictEqual(await economy.reconcileLeft(guild), 1);
    assert.ok(docs.get(`${guild.id}:200000000000000079`).doc.leftAt);
    assert.strictEqual(docs.get(key).doc.leftAt, null, 'still here, untouched');
}

function settingsChecks() {
    const guild = makeGuild();
    const actor = makeMember(guild, '100000000000000001', { position: 10 });
    guild.ownerId = 'someone-else';
    const role = (id, position, perms = () => false) => guild.roles.cache.set(id, { id, name: id, position, editable: true, managed: false, permissions: { has: perms } });
    role('low', 1);
    role('high', 20);
    role('mod', 2, () => true);
    const current = { enabled: false, channelId: null, levelRoles: [] };
    assert.strictEqual(sanitizeSettings(guild, actor, { levelRoles: [{ level: 5, roleId: 'high' }] }, current).code, 'role_higher');
    assert.strictEqual(sanitizeSettings(guild, actor, { levelRoles: [{ level: 5, roleId: 'mod' }] }, current).code, 'role_dangerous');
    assert.strictEqual(sanitizeSettings(guild, actor, { levelRoles: [{ level: 51, roleId: 'low' }] }, current).code, 'invalid_level');
    const ok = sanitizeSettings(guild, actor, { enabled: true, levelRoles: [{ level: 10, roleId: 'low' }] }, current);
    assert.deepStrictEqual(ok.value, { enabled: true, channelId: null, levelRoles: [{ level: 10, roleId: 'low' }] });
}

(async () => {
    curveMatchesOldBot();
    await credits();
    await adjustments();
    voiceRules();
    await messagesAndLevelUps();
    await leaving();
    settingsChecks();
    console.log('economy tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
