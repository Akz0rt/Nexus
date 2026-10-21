const crypto = require('node:crypto');
const EconomyService = require('./EconomyService');

const MIN_BET = 10;
const MAX_BET = 50_000;
const WIN_SHARE = 0.95; // the house keeps 5%
const DUEL_TIMEOUT_MS = 60 * 1000;
const COINFLIP_COOLDOWN_MS = 5 * 1000;

const duels = new Map(); // id -> { guildId, challengerId, opponentId, bet, expiresAt }
const lastFlip = new Map(); // guildId:userId -> ms

const winnings = bet => Math.floor(bet * WIN_SHARE);

function checkBet(bet) {
    return Number.isInteger(bet) && bet >= MIN_BET && bet <= MAX_BET;
}

/** Fair coin; replaced in tests. */
const random = { coin: () => crypto.randomInt(2) === 0 };

/**
 * Against the bot: win 95% of the bet or lose the bet.
 * @returns {{ ok, won?, side?, amount?, balance?, code? }}
 */
async function coinflip(guildId, member, bet, side, now = Date.now()) {
    if (!checkBet(bet)) return { ok: false, code: 'invalid_bet' };
    const key = `${guildId}:${member.id}`;
    if (now - (lastFlip.get(key) || 0) < COINFLIP_COOLDOWN_MS) return { ok: false, code: 'cooldown' };
    const account = await EconomyService.get(guildId, member.id);
    if (!account || account.money < bet) return { ok: false, code: 'insufficient_funds', balance: account?.money || 0 };
    lastFlip.set(key, now);
    const landed = random.coin() ? 'heads' : 'tails';
    const won = landed === side;
    const amount = won ? winnings(bet) : -bet;
    const result = await EconomyService.move(guildId, member, amount, {
        kind: 'game', cause: won ? 'Выигрыш в «Орёл или решка»' : 'Проигрыш в «Орёл или решка»'
    });
    if (!result.ok) return result;
    return { ok: true, won, landed, amount, balance: result.account.money };
}

/** A challenge waiting for the opponent's answer. */
async function challenge(guildId, challenger, opponent, bet, now = Date.now()) {
    if (!checkBet(bet)) return { ok: false, code: 'invalid_bet' };
    if (opponent.id === challenger.id) return { ok: false, code: 'self' };
    if (opponent.user?.bot) return { ok: false, code: 'bot' };
    const mine = await EconomyService.get(guildId, challenger.id);
    if (!mine || mine.money < bet) return { ok: false, code: 'insufficient_funds', balance: mine?.money || 0 };
    for (const [id, duel] of duels) if (duel.expiresAt <= now) duels.delete(id);
    const id = crypto.randomUUID().slice(0, 8);
    duels.set(id, { id, guildId, challengerId: challenger.id, opponentId: opponent.id, bet, expiresAt: now + DUEL_TIMEOUT_MS });
    return { ok: true, id, bet, expiresAt: now + DUEL_TIMEOUT_MS };
}

/**
 * The opponent answers. Accepting checks both balances, picks the winner 50/50, takes
 * the bet from the loser and pays the winner 95% of it.
 */
async function answer(guild, duelId, member, accept, now = Date.now()) {
    const duel = duels.get(duelId);
    if (!duel || duel.expiresAt <= now) { duels.delete(duelId); return { ok: false, code: 'duel_gone' }; }
    // A duel belongs to the server it was started on
    if (duel.guildId !== guild.id) return { ok: false, code: 'duel_gone' };
    if (member.id !== duel.opponentId) return { ok: false, code: 'not_opponent' };
    duels.delete(duelId);
    if (!accept) return { ok: true, declined: true, duel };

    const [challengerAccount, opponentAccount] = await Promise.all([
        EconomyService.get(guild.id, duel.challengerId),
        EconomyService.get(guild.id, duel.opponentId)
    ]);
    if (!challengerAccount || challengerAccount.money < duel.bet) return { ok: false, code: 'challenger_broke', duel };
    if (!opponentAccount || opponentAccount.money < duel.bet) return { ok: false, code: 'insufficient_funds', duel };

    const challengerWins = random.coin();
    const winnerId = challengerWins ? duel.challengerId : duel.opponentId;
    const loserId = challengerWins ? duel.opponentId : duel.challengerId;
    const winner = guild.members.cache.get(winnerId) || { id: winnerId };
    const loser = guild.members.cache.get(loserId) || { id: loserId };
    const paid = await EconomyService.transfer(guild.id, loser, winner, duel.bet, {
        fee: duel.bet - winnings(duel.bet), kind: 'game', outCause: 'Проигрыш в дуэли', inCause: 'Выигрыш в дуэли'
    });
    if (!paid.ok) return { ok: false, code: loserId === duel.challengerId ? 'challenger_broke' : 'insufficient_funds', duel };
    return { ok: true, duel, winnerId, loserId, prize: winnings(duel.bet) };
}

/** Send coins to another member, no fee. */
async function pay(guildId, from, to, amount, note) {
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) return { ok: false, code: 'invalid_amount' };
    if (to.id === from.id) return { ok: false, code: 'self' };
    if (to.user?.bot) return { ok: false, code: 'bot' };
    const comment = String(note || '').trim().slice(0, 100);
    const fromName = from.displayName || from.user?.username || from.id;
    const toName = to.displayName || to.user?.username || to.id;
    return EconomyService.transfer(guildId, from, to, amount, {
        kind: 'transfer',
        outCause: `Перевод для ${toName}${comment ? `: ${comment}` : ''}`,
        inCause: `Перевод от ${fromName}${comment ? `: ${comment}` : ''}`
    });
}

module.exports = { MIN_BET, MAX_BET, WIN_SHARE, winnings, random, coinflip, challenge, answer, pay, duels };
