const EventBus = require('../../services/EventBus');

const HEARTBEAT_MS = 25 * 1000; // well under Azure's ~230 s idle timeout

/**
 * Server-Sent Events fan-out per guild. Every action goes through
 * AuditLogService.log → EventBus 'audit', so panel clicks, Discord buttons and
 * manual role changes all reach every open app.
 */
class SseHub {
    constructor() {
        this.clients = new Map(); // guildId -> Set<res>
        this.heartbeat = null;
    }

    subscribe(guildId, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();
        res.write('retry: 5000\n\n');

        if (!this.clients.has(guildId)) this.clients.set(guildId, new Set());
        this.clients.get(guildId).add(res);
        this.ensureHeartbeat();

        res.on('close', () => this.unsubscribe(guildId, res));
    }

    unsubscribe(guildId, res) {
        const set = this.clients.get(guildId);
        if (!set) return;
        set.delete(res);
        if (set.size === 0) this.clients.delete(guildId);
        if (this.clients.size === 0) this.stopHeartbeat();
    }

    broadcast(guildId, event, data) {
        const set = this.clients.get(guildId);
        if (!set) return 0;
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of set) res.write(frame);
        return set.size;
    }

    ensureHeartbeat() {
        if (this.heartbeat) return;
        this.heartbeat = setInterval(() => {
            for (const set of this.clients.values()) {
                for (const res of set) res.write(': ping\n\n');
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
