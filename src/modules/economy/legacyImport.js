/**
 * Turns the old economy bot's rows into accounts and journal entries for the
 * `economy` / `economy_tx` containers. The stored level and exp are the source of
 * truth: the old bot had exp sources beyond voice and messages, so they are never
 * rebuilt from the voice and message counters.
 */

const curve = require('./curve');

const SNOWFLAKE_RE = /^\d{17,20}$/;

/** All-time exp under the old curve (no level cap: 5000·N per level, forever). */
function legacyTotal(level, exp) {
    return 2500 * level * (level - 1) + exp;
}

function parseHistory(raw) {
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * One old journal entry → ours. The old bot stored `money` as a number or a string,
 * and wrote "take" amounts sometimes negative and sometimes positive.
 */
function normalizeEntry(guildId, userId, entry, index) {
    const size = Math.abs(Number(entry.money) || 0);
    const amount = entry.type === 'take' ? -size : size;
    const cause = String(entry.cause || '').slice(0, 200);
    return {
        id: `import-${userId}-${index}`,
        guildId,
        userId,
        amount,
        balance: Number.isFinite(Number(entry.balance)) ? Number(entry.balance) : null,
        kind: cause === 'Повысил уровень' ? 'level' : 'legacy',
        cause,
        actorId: null,
        source: 'import',
        createdAt: entry.time && !Number.isNaN(Date.parse(entry.time)) ? new Date(entry.time).toISOString() : null
    };
}

/**
 * `presentIds` — who is on the server now (null: everyone counts as present);
 * `anonymize()` — a random key for the accounts of those who are not.
 * @returns {{ accounts: object[], transactions: object[], skipped: string[], mismatches: object[] }}
 */
function buildImport(rows, guildId, now = new Date().toISOString(), presentIds = null, anonymize = null) {
    const accounts = [];
    const transactions = [];
    const skipped = [];
    const mismatches = [];
    for (const row of rows) {
        const userId = String(row.id);
        if (!SNOWFLAKE_RE.test(userId)) { skipped.push(userId); continue; }
        const level = Math.max(1, Number(row.level) || 1);
        const exp = Math.max(0, Number(row.exp) || 0);
        const total = legacyTotal(level, exp);
        const next = curve.fromTotal(total);
        const voiceSeconds = Math.max(0, Number(row.voiceall) || 0);
        const messages = Math.max(0, Number(row.messageall) || 0);
        // Information only: how far the counters are from the stored progress
        const fromCounters = voiceSeconds + 10 * messages;
        if (Math.abs(fromCounters - total) > Math.max(1000, total * 0.01)) {
            mismatches.push({ userId, level, total, fromCounters });
        }
        // Not on the server any more: stored obfuscated from the start, like anyone who leaves
        const gone = Boolean(presentIds && !presentIds.has(userId));
        const ownerId = gone && anonymize ? anonymize() : userId;
        accounts.push({
            id: ownerId, guildId, userId: gone && anonymize ? null : userId,
            username: null, displayName: null,
            level: next.level, exp: next.exp, prestige: next.prestige,
            totalExp: curve.totalOf(next.level, next.exp, next.prestige),
            money: Math.max(0, Number(row.money) || 0),
            voiceSeconds, messages,
            legacy: { level, exp },
            leftAt: gone ? now : null,
            linkable: false,
            createdAt: now, updatedAt: now, importedAt: now
        });
        parseHistory(row.historytrans).forEach((entry, index) => {
            const tx = normalizeEntry(guildId, ownerId, entry, index);
            if (tx.amount !== 0 && tx.createdAt) transactions.push(tx);
        });
    }
    return { accounts, transactions, skipped, mismatches };
}

/**
 * Personal roles from the old history that still exist in Discord and whose creator
 * is still on the server. `holdersOf(roleId)` — who wears it now. Every role gets a
 * full period from `now`; other wearers become buyers for the same period.
 */
function legacyPersonalRoles(rows, guildId, { roles, holdersOf, memberIds, periodDays, now = Date.now() }) {
    const creators = new Map(); // roleId -> owner (the latest creation entry wins)
    for (const row of rows) {
        for (const entry of parseHistory(row.historytrans)) {
            const match = /^Создание личной роли <@&(\d+)>/.exec(String(entry.cause || ''));
            if (!match) continue;
            const known = creators.get(match[1]);
            if (!known || String(entry.time) > known.time) creators.set(match[1], { ownerId: String(row.id), time: String(entry.time) });
        }
    }
    const until = new Date(now + periodDays * 24 * 60 * 60 * 1000).toISOString();
    const docs = [];
    for (const [roleId, { ownerId }] of creators) {
        if (!roles.has(roleId) || !memberIds.has(ownerId)) continue;
        const holders = holdersOf(roleId);
        docs.push({
            id: roleId, guildId, roleId, ownerId,
            ownerWears: holders.includes(ownerId),
            price: null,
            buyers: holders.filter(id => id !== ownerId).map(userId => ({ userId, expiresAt: until })),
            expiresAt: until,
            remindedAt: null,
            createdAt: new Date(now).toISOString(),
            importedAt: new Date(now).toISOString()
        });
    }
    return docs;
}

module.exports = { legacyTotal, normalizeEntry, buildImport, legacyPersonalRoles };
