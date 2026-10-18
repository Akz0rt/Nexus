/**
 * Level curve. Levels 1–50 are the old economy bot's (so imported levels carry over
 * as is): going from level N to N+1 costs 5000·N exp, and exp starts over at each
 * level. Level 50 is the last one; after it every 500 000 exp is one more prestige.
 *
 * Reaching level N pays 100·(N−1) coins, as in the old bot; each prestige pays 10 000.
 */

const EXP_PER_LEVEL = 5000;
const MAX_LEVEL = 50;
const PRESTIGE_EXP = 500_000;
const PRESTIGE_REWARD = 10_000;

/** Exp needed from `level` to the next level (or, at the top level, to the next prestige). */
function levelCost(level) {
    return level >= MAX_LEVEL ? PRESTIGE_EXP : EXP_PER_LEVEL * level;
}

/** Exp spent to reach `level` from level 1. */
function expToReach(level) {
    const capped = Math.min(level, MAX_LEVEL);
    return (EXP_PER_LEVEL * capped * (capped - 1)) / 2;
}

/** Coins for reaching `level`. */
function levelReward(level) {
    return 100 * (level - 1);
}

/** All-time exp total for a level, prestige and the exp within the current step. */
function totalOf(level, exp, prestige = 0) {
    return expToReach(level) + prestige * PRESTIGE_EXP + exp;
}

/**
 * Add exp. @returns {{ level, exp, prestige, reached: number[], prestiges: number, rewards: number }}
 * `reached` lists the levels reached on the way, `prestiges` how many new prestiges.
 */
function addExp({ level, exp, prestige = 0 }, gain) {
    let nextLevel = level;
    let nextPrestige = prestige;
    let rest = exp + gain;
    const reached = [];
    while (rest >= levelCost(nextLevel)) {
        rest -= levelCost(nextLevel);
        if (nextLevel >= MAX_LEVEL) {
            nextPrestige++;
        } else {
            nextLevel++;
            reached.push(nextLevel);
        }
    }
    const prestiges = nextPrestige - prestige;
    const rewards = reached.reduce((sum, l) => sum + levelReward(l), 0) + prestiges * PRESTIGE_REWARD;
    return { level: nextLevel, exp: rest, prestige: nextPrestige, reached, prestiges, rewards };
}

/** Level, prestige and exp within the step for an all-time exp total. */
function fromTotal(totalExp) {
    const { level, exp, prestige } = addExp({ level: 1, exp: 0 }, Math.max(0, Math.floor(totalExp)));
    return { level, exp, prestige };
}

module.exports = {
    EXP_PER_LEVEL, MAX_LEVEL, PRESTIGE_EXP, PRESTIGE_REWARD,
    levelCost, expToReach, levelReward, totalOf, addExp, fromTotal
};
