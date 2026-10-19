const EventBus = require('../../services/EventBus');
const { canUserSee } = require('./visibility');

const HEARTBEAT_MS = 25 * 1000; // well under Azure's ~230 s idle timeout
// «Смотрит Kira»: the app repeats what it has open every few minutes; older marks are dropped
const VIEWING_TTL_MS = 6 * 60 * 1000;

/**
 * Server-Sent Events fan-out per guild. Every action goes through
 * AuditLogService.log → EventBus 'audit', so panel clicks, Discord buttons and
 * manual role changes all reach every open app. Open streams double as presence:
 * whoever has the app open on a guild is "on shift" there.
 */
class SseHub {
    /** @param {{ canSee?: (guildId, userId, entry) => boolean }} [options] who may see an audit entry */
    constructor({ canSee = canUserSee } = {}) {
        this.clients = new Map(); // guildId -> Map<res, user>
        this.viewing = new Map(); // guildId -> Map<userId, { targetId, at }> whose member card each moderator has open
        this.heartbeat = null;
        this.canSee = canSee;
    }

    /**
     * @param {string} guildId
     * @param {import('http').ServerResponse} res
     * @param {{ id: string, displayName?: string|null, avatarURL?: string|null }} [user]
     */
    subscribe(guildId, res, user = null) {
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
        this.ensureHeartbeat();
        this.broadcastPresence(guildId);

        res.on('close', () => this.unsubscribe(guildId, res));
    }

    unsubscribe(guildId, res) {
        const streams = this.clients.get(guildId);
        const user = streams?.get(res);
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
    }

    stopHeartbeat() {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    /**
     * Forward audit-log entries, voice-board changes and mass role job progress to
     * the guild's open streams. Message-log entries go only to who may read them.
     */
    attach(bus = EventBus) {
        bus.on('audit', entry => this.broadcast(entry.guildId, 'audit', entry,
            user => this.canSee(entry.guildId, user?.id, entry)));
        bus.on('voice', change => this.broadcast(change.guildId, 'voice', change));
        bus.on('job', job => this.broadcast(job.guildId, 'job', job));
        // A background task is the business of whoever started it
        bus.on('task', task => this.broadcast(task.guildId, 'task', task, user => user?.id === task.actorId));
        bus.on('event', change => this.broadcast(change.guildId, 'event', change));
        return this;
    }
}

module.exports = { SseHub };
