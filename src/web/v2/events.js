const EventBus = require('../../services/EventBus');

const HEARTBEAT_MS = 25 * 1000; // well under Azure's ~230 s idle timeout

/**
 * Server-Sent Events fan-out per guild. Every action goes through
 * AuditLogService.log → EventBus 'audit', so panel clicks, Discord buttons and
 * manual role changes all reach every open app. Open streams double as presence:
 * whoever has the app open on a guild is "on shift" there.
 */
class SseHub {
    constructor() {
        this.clients = new Map(); // guildId -> Map<res, user>
        this.heartbeat = null;
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
        if (!streams || !streams.delete(res)) return;
        if (streams.size === 0) this.clients.delete(guildId);
        else this.broadcastPresence(guildId);
        if (this.clients.size === 0) this.stopHeartbeat();
    }

    /** Distinct users with at least one open stream on the guild. */
    presence(guildId) {
        const users = new Map();
        for (const user of this.clients.get(guildId)?.values() || []) {
            if (user && !users.has(user.id)) users.set(user.id, user);
        }
        return [...users.values()];
    }

    broadcastPresence(guildId) {
        this.broadcast(guildId, 'presence', { users: this.presence(guildId) });
    }

    broadcast(guildId, event, data) {
        const streams = this.clients.get(guildId);
        if (!streams) return 0;
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of streams.keys()) res.write(frame);
        return streams.size;
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

    /** Forward audit-log entries to the guild's open streams. */
    attach(bus = EventBus) {
        bus.on('audit', entry => this.broadcast(entry.guildId, 'audit', entry));
        return this;
    }
}

module.exports = { SseHub };
