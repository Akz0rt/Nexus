/**
 * Risk flags on a newcomer for the panel's queue: each one has a short label and
 * a tone (danger — likely trouble, warn — worth a look, null — neutral).
 * The bans list is kept in memory per guild and refreshed now and then.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RAID_WINDOW_MS = 10 * 60 * 1000;   // joins this close together…
const RAID_MIN_JOINS = 5;                // …this many of them look like a raid
const BANS_TTL_MS = 10 * 60 * 1000;
const BANS_MAX_PAGES = 10;               // 10 000 bans is plenty for name matching
const MIN_NAME_LENGTH = 3;

// Digits and look-alikes people swap in to dodge a ban on a name
const LOOKALIKE = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };
// Cyrillic letters that look like Latin ones
const CYRILLIC = { а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };

/** «xX_V1ka_Xx» and «вика» come out the same: lower case, look-alikes folded, symbols and repeats dropped. */
function normalizeName(name) {
    const text = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    let out = '';
    for (const char of text) {
        const folded = CYRILLIC[char] || LOOKALIKE[char] || char;
        if (!/\p{L}/u.test(folded)) continue;
        if (out.endsWith(folded)) continue;
        out += folded;
    }
    return out;
}

/** The names a member is known by, normalized (username, global name, server nick). */
function namesOf(user, displayName) {
    return [...new Set([user?.username, user?.globalName, displayName].map(normalizeName))]
        .filter(name => name.length >= MIN_NAME_LENGTH);
}

/**
 * How many members joined within ±5 minutes of each join time.
 * @param {number[]} joins join timestamps of everyone on the server
 * @returns {(at: number) => number}
 */
function joinsAround(joins) {
    const sorted = [...joins].filter(Number.isFinite).sort((a, b) => a - b);
    const lowerBound = value => {
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] < value) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
    return at => lowerBound(at + RAID_WINDOW_MS / 2 + 1) - lowerBound(at - RAID_WINDOW_MS / 2);
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/**
 * @param {{ user: { username, globalName, avatar, createdTimestamp }, displayName: string, joinedTimestamp: number }} member
 * @param {{ youngAccountDays: number, bannedNames?: Set<string>, kickCount?: number, joinsNear?: number, now?: number }} context
 * @returns {Array<{ code: string, label: string, tone: 'danger'|'warn'|null }>}
 */
function riskFlags(member, { youngAccountDays, bannedNames = new Set(), kickCount = 0, joinsNear = 0, now = Date.now() }) {
    const flags = [];
    if (now - member.user.createdTimestamp < youngAccountDays * DAY_MS) {
        flags.push({ code: 'young', label: 'новый аккаунт', tone: 'danger' });
    }
    if (kickCount > 0) {
        flags.push({ code: 'kicked', label: `кикали ${kickCount} ${plural(kickCount, 'раз', 'раза', 'раз')}`, tone: 'danger' });
    }
    if (joinsNear >= RAID_MIN_JOINS) {
        flags.push({ code: 'raid', label: 'волна рейда', tone: 'danger' });
    }
    if (namesOf(member.user, member.displayName).some(name => bannedNames.has(name))) {
        flags.push({ code: 'banned_name', label: 'ник как у забаненного', tone: 'warn' });
    }
    if (!member.user.avatar) {
        flags.push({ code: 'no_avatar', label: 'без аватара', tone: null });
    }
    return flags;
}

/** Normalized names of everyone banned on a guild, cached for a few minutes. */
class BannedNames {
    constructor() {
        this.cache = new Map(); // guildId -> { at, names }
    }

    invalidate(guildId) {
        this.cache.delete(guildId);
    }

    async get(guild) {
        const cached = this.cache.get(guild.id);
        if (cached && Date.now() - cached.at < BANS_TTL_MS) return cached.names;
        const names = new Set();
        try {
            let after;
            for (let page = 0; page < BANS_MAX_PAGES; page++) {
                const bans = await guild.bans.fetch({ limit: 1000, after, cache: false });
                for (const ban of bans.values()) for (const name of namesOf(ban.user, null)) names.add(name);
                if (bans.size < 1000) break;
                after = bans.lastKey(); // Discord pages bans by user id, ascending
            }
        } catch {
            // No «Банить участников»: the flag just never shows (Diagnostics tells about the right)
        }
        this.cache.set(guild.id, { at: Date.now(), names });
        return names;
    }
}

module.exports = {
    riskFlags,
    normalizeName,
    namesOf,
    joinsAround,
    BannedNames,
    bannedNames: new BannedNames(),
    RAID_MIN_JOINS
};
