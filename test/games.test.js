// Standalone test (no test framework configured): run with `node test/games.test.js`
// Transfers, coin flips and duels: real EconomyService.move/transfer over an in-memory
// store — balances never go below zero, the winner gets 95%, bets are limited.

const assert = require('assert');

const EconomyService = require('../src/modules/economy/EconomyService');
const games = require('../src/modules/economy/games');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const A = '200000000000000001';
const B = '200000000000000002';
const BOT = '200000000000000009';

const docs = new Map();
const txs = [];
let version = 0;
EconomyService.initialize = async () => {};
EconomyService.readRaw = async (guildId, userId) => {
    const saved = docs.get(userId);
    return saved ? { doc: { ...saved.doc }, etag: saved.etag } : null;
};
EconomyService.writeRaw = async (doc, etag) => {
    const saved = docs.get(doc.id);
    if (etag ? saved?.etag !== etag : saved) throw Object.assign(new Error('race'), { code: etag ? 412 : 409 });
    docs.set(doc.id, { doc: { ...doc }, etag: `e${++version}` });
};
EconomyService.addTransactions = async entries => { txs.push(...entries); };
const money = id => docs.get(id)?.doc.money ?? 0;
const setMoney = (id, value) => docs.set(id, { doc: { ...EconomyService.blankAccount('g', id), money: value }, etag: `e${++version}` });

const guild = makeGuild();
const a = makeMember(guild, A, {});
const b = makeMember(guild, B, {});
const bot = makeMember(guild, BOT, { bot: true });

async function transfers() {
    setMoney(A, 1000);
    assert.strictEqual((await games.pay(guild.id, a, a, 10)).code, 'self');
    assert.strictEqual((await games.pay(guild.id, a, bot, 10)).code, 'bot');
    assert.strictEqual((await games.pay(guild.id, a, b, 0)).code, 'invalid_amount');
    assert.strictEqual((await games.pay(guild.id, a, b, 1001)).code, 'insufficient_funds');
    const result = await games.pay(guild.id, a, b, 300, 'за пиццу');
    assert.ok(result.ok);
    assert.deepStrictEqual([money(A), money(B)], [700, 300], 'no fee');
    assert.deepStrictEqual(txs.slice(-2).map(t => [t.userId, t.amount]), [[A, -300], [B, 300]]);
    assert.match(txs.at(-1).cause, /за пиццу/);
}

async function coinflips() {
    setMoney(A, 1000);
    assert.strictEqual((await games.coinflip(guild.id, a, 5, 'heads', 1e6)).code, 'invalid_bet');
    assert.strictEqual((await games.coinflip(guild.id, a, 50001, 'heads', 1e6)).code, 'invalid_bet');
    assert.strictEqual((await games.coinflip(guild.id, a, 2000, 'heads', 1e6)).code, 'insufficient_funds');
    games.random.coin = () => true; // heads
    let result = await games.coinflip(guild.id, a, 100, 'heads', 1e6);
    assert.deepStrictEqual([result.won, result.amount, money(A)], [true, 95, 1095]);
    assert.strictEqual((await games.coinflip(guild.id, a, 100, 'heads', 1e6 + 1000)).code, 'cooldown');
    result = await games.coinflip(guild.id, a, 100, 'tails', 1e6 + 6000);
    assert.deepStrictEqual([result.won, result.amount, money(A)], [false, -100, 995]);
}

async function duels() {
    setMoney(A, 500);
    setMoney(B, 50);
    assert.strictEqual((await games.challenge(guild.id, a, a, 100)).code, 'self');
    assert.strictEqual((await games.challenge(guild.id, a, b, 1000)).code, 'insufficient_funds', 'the challenger must afford it');
    let duel = await games.challenge(guild.id, a, b, 100, 0);
    assert.strictEqual((await games.answer(guild, duel.id, a, true, 1000)).code, 'not_opponent');
    assert.strictEqual((await games.answer(guild, duel.id, b, true, 1000)).code, 'insufficient_funds', 'the opponent must afford it');
    assert.deepStrictEqual([money(A), money(B)], [500, 50], 'nothing moved');

    setMoney(B, 200);
    duel = await games.challenge(guild.id, a, b, 100, 0);
    assert.strictEqual((await games.answer(guild, duel.id, b, true, 61000)).code, 'duel_gone', 'a minute to answer');

    duel = await games.challenge(guild.id, a, b, 100, 0);
    games.random.coin = () => false; // the opponent wins
    const result = await games.answer(guild, duel.id, b, true, 1000);
    assert.deepStrictEqual([result.winnerId, result.prize, money(A), money(B)], [B, 95, 400, 295]);
    assert.strictEqual((await games.answer(guild, duel.id, b, true, 1000)).code, 'duel_gone', 'answered once');

    duel = await games.challenge(guild.id, a, b, 100, 0);
    assert.ok((await games.answer(guild, duel.id, b, false, 1000)).declined);
    assert.deepStrictEqual([money(A), money(B)], [400, 295]);
}

(async () => {
    await transfers();
    await coinflips();
    await duels();
    console.log('games tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
