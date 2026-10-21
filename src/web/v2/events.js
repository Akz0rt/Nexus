const EventBus = require('../../services/EventBus');
const PanelSessionService = require('../../services/PanelSessionService');
const state = require('../../state');
const { getPanelRole, hasRole } = require('./access');
const { canUserSee, canUserSeeVoice, canUserManageRoles } = require('./visibility');

const HEARTBEAT_MS = 25 * 1000; // well under Azure's ~230 s idle timeout
// «Смотрит Kira»: the app repeats what it has open every few minutes; older marks are dropped
const VIEWING_TTL_MS = 6 * 60 * 1000;
// Rights are checked at connect and again this often: a demoted, kicked or logged-out
// moderator stops receiving the server's events
const RECHECK_MS = 60 * 1000;

/** Still logged in, the bot still on the server, still a panel user there? */
async function stillAllowed(guildId, userId, token) {
    if (!token || !(await PanelSessionService.get(token))) return false;
    const guild = state.client?.guilds?.cache.get(guildId);
    if (!guild) return false;
    return hasRole(await getPanelRole(guild, userId), 'admin');
}

/**
 * Server-Sent Events fan-out per guild. Every action goes through
 * AuditLogService.log → EventBus 'audit', so panel clicks, Discord buttons and
 * manual role changes all reach every open app. Open streams double as presence:
 * whoever has the app open on a guild is "on shift" there.
 */
class SseHub {
    /**
     * @param {{ canSee?: (guildId, userId, entry) => boolean, canSeeVoice?: (guildId, userId, channelId) => boolean,
     *   canManageRoles?: (guildId, userId) => boolean, authorize?: (guildId, userId, token) => Promise<boolean> }} [options]
     *   who may see an audit entry, a voice channel, role jobs; whether a stream may stay open
     */
    constructor({ canSee = canUserSee, canSeeVoice = canUserSeeVoice, canManageRoles = canUserManageRoles, authorize = stillAllowed } = {}) {
        this.clients = new Map(); // guildId -> Map<res, user>
        this.tokens = new Map(); // res -> session token (kept apart from the user, which is broadcast as presence)
        this.viewing = new Map(); // guildId -> Map<userId, { targetId, at }> whose member card each moderator has open
        this.heartbeat = null;
        this.recheckTimer = null;
        this.canSee = canSee;
        this.canSeeVoice = canSeeVoice;
        this.canManageRoles = canManageRoles;
        this.authorize = authorize;
    }

    /**
     * @param {string} guildId
     * @param {import('http').ServerResponse} res
     * @param {{ id: string, displayName?: string|null, avatarURL?: string|null }} [user]
     * @param {string|null} [token] the session the stream belongs to (closed on logout)
     */
    subscribe(guildId, res, user = null, token = null) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();
        res.write('retry: 5000\n\n');

        if (!this.clients.has(guildId)) this.clients.set(guildId, new Map());
        this.clients.get(guildId).set(res, user);
        if (token) this.tokens.set(res, token);
        this.ensureHeartbeat();
        this.broadcastPresence(guildId);

        res.on('close', () => this.unsubscribe(guildId, res));
    }

    unsubscribe(guildId, res) {
        const streams = this.clients.get(guildId);
        const user = streams?.get(res);
        this.tokens.delete(res);
        if (!streams || !streams.delete(res)) return;
        if (streams.size === 0) this.clients.delete(guildId);
        // Gone from the app altogether: nobody is looking at a card on their behalf any more
        if (user && ![...streams.values()].some(other => other?.id === user.id)) this.viewing.get(guildId)?.delete(user.id);
        if (streams.size > 0) this.broadcastPresence(guildId);
        if (this.clients.size === 0) this.stopHeartbeat();
    }

    /** Distinct users with at least one open stream on the guild, with whose card they have open. */
    presence(guildId, now = Date.now()) {
        const users = new Map();
        const viewing = this.viewing.get(guildId);
        for (const user of this.clients.get(guildId)?.values() || []) {
            if (!user || users.has(user.id)) continue;
            const mark = viewing?.get(user.id);
            users.set(user.id, { ...user, viewingId: mark && now - mark.at < VIEWING_TTL_MS ? mark.targetId : null });
        }
        return [...users.values()];
    }

    /** A moderator opened (targetId) or closed (null) a member card. */
    setViewing(guildId, userId, targetId, now = Date.now()) {
        if (!this.viewing.has(guildId)) this.viewing.set(guildId, new Map());
        const marks = this.viewing.get(guildId);
        const before = marks.get(userId)?.targetId || null;
        if (targetId) marks.set(userId, { targetId, at: now });
        else marks.delete(userId);
        if (before !== (targetId || null)) this.broadcastPresence(guildId, now);
    }

    broadcastPresence(guildId, now = Date.now()) {
        this.broadcast(guildId, 'presence', { users: this.presence(guildId, now) });
    }

    /** @param {(user) => boolean} [allow] limits the frame to some streams */
    broadcast(guildId, event, data, allow = null) {
        const streams = this.clients.get(guildId);
        if (!streams) return 0;
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        let sent = 0;
        for (const [res, user] of streams) {
            if (allow && !allow(user)) continue;
            res.write(frame);
            sent++;
        }
        return sent;
    }

    ensureHeartbeat() {
        if (this.heartbeat) return;
        this.heartbeat = setInterval(() => {
            for (const streams of this.clients.values()) {
                for (const res of streams.keys()) res.write(': ping\n\n');
            }
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
        this.recheckTimer = setInterval(() => this.recheck().catch(error =>
            console.error('SSE recheck error:', error.message || error)), RECHECK_MS);
        this.recheckTimer.unref?.();
    }

    stopHeartbeat() {
        clearInterval(this.heartbeat);
        clearInterval(this.recheckTimer);
        this.heartbeat = null;
        this.recheckTimer = null;
    }

    /** Close one stream and drop it. */
    end(guildId, res) {
        try {
            res.end?.();
        } finally {
            this.unsubscribe(guildId, res);
        }
    }

    /** Close every stream that has lost access: logged out, demoted, left or kicked, bot removed. */
    async recheck() {
        const pairs = [];
        for (const [guildId, streams] of this.clients) {
            for (const [res, user] of streams) pairs.push({ guildId, res, user });
        }
        for (const { guildId, res, user } of pairs) {
            const allowed = await this.authorize(guildId, user?.id, this.tokens.get(res)).catch(() => false);
            if (!allowed) this.end(guildId, res);
        }
    }

    /** Logout: that session's streams close at once. */
    closeSession(token) {
        if (!token) return 0;
        let closed = 0;
        for (const [guildId, streams] of [...this.clients]) {
            for (const res of [...streams.keys()]) {
                if (this.tokens.get(res) !== token) continue;
                this.end(guildId, res);
                closed++;
            }
        }
        return closed;
    }

    /**
     * Forward audit-log entries, voice-board changes and mass role job progress to
     * the guild's open streams. Message-log entries go only to who may read them.
     */
    attach(bus = EventBus) {
        bus.on('audit', entry => this.broadcast(entry.guildId, 'audit', entry,
            user => this.canSee(entry.guildId, user?.id, entry)));
        // Who moved where only to those who can see that channel; the others just learn the board changed
        bus.on('voice', change => {
            if (change.channels || !change.channelId) {
                // A channel list change, or someone left voice: nothing in it may name a hidden channel
                this.broadcast(change.guildId, 'voice', change.channels ? change : { guildId: change.guildId });
                return;
            }
            const sees = user => this.canSeeVoice(change.guildId, user?.id, change.channelId);
            this.broadcast(change.guildId, 'voice', change, sees);
            this.broadcast(change.guildId, 'voice', { guildId: change.guildId }, user => !sees(user));
        });
        bus.on('job', job => this.broadcast(job.guildId, 'job', job, user => this.canManageRoles(job.guildId, user?.id)));
        // A background task is the business of whoever started it
        bus.on('task', task => this.broadcast(task.guildId, 'task', task, user => user?.id === task.actorId));
        bus.on('event', change => this.broadcast(change.guildId, 'event', change));
        return this;
    }
}

module.exports = { SseHub };
