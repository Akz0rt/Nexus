/**
 * Which invite brought each newcomer in. Discord doesn't say, so the bot keeps the
 * use counts of every invite and, when someone joins, looks which one went up.
 * Needs the GuildInvites intent and «Управлять сервером» (Discord hides invites without it).
 */

const MAX_JOINS = 5000; // remembered joins per process (the queue card keeps them for good)

/**
 * The invite whose use count went up between two snapshots.
 * @param {Map<string, { uses: number, inviterId: string|null }>} before
 * @param {Map<string, { uses: number, inviterId: string|null }>} after
 * @param {{ before: number|null, after: number|null }} vanity the vanity URL's use counts
 * @returns {{ code: string|null, inviterId: string|null, vanity: boolean } | null} null — can't tell
 */
function diffInvites(before, after, vanity = { before: null, after: null }) {
    const grown = [];
    for (const [code, invite] of after) {
        const was = before.get(code)?.uses ?? 0;
        if (invite.uses > was) grown.push({ code, inviterId: invite.inviterId });
    }
    // A one-use invite disappears once used: gone from «after» while it had room left
    for (const [code, invite] of before) {
        if (!after.has(code) && invite.maxUses && invite.uses + 1 >= invite.maxUses) grown.push({ code, inviterId: invite.inviterId });
    }
    if (grown.length === 1) return { ...grown[0], vanity: false };
    if (grown.length === 0 && vanity.after !== null && vanity.before !== null && vanity.after > vanity.before) {
        return { code: null, inviterId: null, vanity: true };
    }
    return null; // nothing grew, or two invites at once — guessing would mislead
}

class InviteTracker {
    constructor() {
        this.snapshots = new Map(); // guildId -> { invites: Map, vanityUses: number|null }
        this.joins = new Map();     // `${guildId}:${userId}` -> { code, inviterId, vanity }
        this.queues = new Map();    // guildId -> Promise: joins are diffed one at a time
        this.unavailable = new Set(); // guilds where the bot can't read invites
    }

    async read(guild) {
        const fetched = await guild.invites.fetch({ cache: false });
        const invites = new Map([...fetched.values()].map(invite => [invite.code, {
            uses: invite.uses ?? 0, maxUses: invite.maxUses || 0, inviterId: invite.inviterId || invite.inviter?.id || null
        }]));
        let vanityUses = null;
        if (guild.vanityURLCode) vanityUses = (await guild.fetchVanityData().catch(() => null))?.uses ?? null;
        return { invites, vanityUses };
    }

    async snapshot(guild) {
        try {
            this.snapshots.set(guild.id, await this.read(guild));
            this.unavailable.delete(guild.id);
        } catch {
            this.unavailable.add(guild.id);
        }
    }

    /** An invite was created or deleted: just re-read the list. */
    refresh(guild) {
        return this.enqueue(guild.id, () => this.snapshot(guild));
    }

    enqueue(guildId, task) {
        const next = (this.queues.get(guildId) || Promise.resolve()).then(task, task);
        this.queues.set(guildId, next.catch(() => {}));
        return next;
    }

    /** Someone joined: find the invite and remember it. */
    onJoin(member) {
        const guild = member.guild;
        return this.enqueue(guild.id, async () => {
            const before = this.snapshots.get(guild.id);
            let after;
            try {
                after = await this.read(guild);
                this.unavailable.delete(guild.id);
            } catch {
                this.unavailable.add(guild.id);
                return null;
            }
            this.snapshots.set(guild.id, after);
            if (!before) return null;
            const found = diffInvites(before.invites, after.invites, { before: before.vanityUses, after: after.vanityUses });
            if (found) this.remember(guild.id, member.id, found);
            return found;
        });
    }

    remember(guildId, userId, invite) {
        this.joins.set(`${guildId}:${userId}`, invite);
        if (this.joins.size > MAX_JOINS) this.joins.delete(this.joins.keys().next().value);
    }

    joinOf(guildId, userId) {
        return this.joins.get(`${guildId}:${userId}`) || null;
    }

    canTrack(guildId) {
        return !this.unavailable.has(guildId);
    }
}

module.exports = new InviteTracker();
module.exports.InviteTracker = InviteTracker;
module.exports.diffInvites = diffInvites;
