const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');
const EventBus = require('../../services/EventBus');
const { buildEventMessage, stamp } = require('./card');

const EVENTS_CONTAINER = 'events';
const MINUTE_MS = 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const REMIND_BEFORE_MS = 15 * MINUTE_MS;
const LATE_REMINDER_MS = 5 * MINUTE_MS; // the bot was down: don't remind once it has long started
const MAX_AHEAD_MS = 365 * 24 * 60 * MINUTE_MS;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/**
 * Events with sign-up: a card with «Иду» / «Не иду» in a text channel, a ping to
 * those going 15 minutes before, the card closes at the start, a weekly event
 * publishes its next week by itself. Those going can become a voice squad.
 */
class EventService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
        this.locks = new Map(); // eventId -> promise chain, so two clicks don't lose a sign-up
    }

    async initialize() {
        if (this.initialized) return;
        this.client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: EVENTS_CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.container = database.container(EVENTS_CONTAINER);
        this.initialized = true;
    }

    async get(guildId, eventId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(String(eventId), guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async save(event) {
        await this.initialize();
        event.updatedAt = new Date().toISOString();
        await this.container.items.upsert(event);
        return event;
    }

    /** @param {'upcoming'|'past'} group */
    async list(guildId, group = 'upcoming') {
        await this.initialize();
        const upcoming = group !== 'past';
        const { resources } = await this.container.items.query({
            query: upcoming
                ? "SELECT * FROM c WHERE c.guildId = @guildId AND c.status = 'scheduled' ORDER BY c.startsAt ASC"
                : "SELECT * FROM c WHERE c.guildId = @guildId AND c.status != 'scheduled' ORDER BY c.startsAt DESC",
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId, maxItemCount: 100 }).fetchNext();
        return resources || [];
    }

    /** Scheduled events starting within 15 minutes (or already started), across guilds. */
    async listDue(now = Date.now()) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: "SELECT * FROM c WHERE c.status = 'scheduled' AND c.startsAt <= @soon",
            parameters: [{ name: '@soon', value: new Date(now + REMIND_BEFORE_MS).toISOString() }]
        }).fetchAll();
        return resources;
    }

    emit(event) {
        try {
            EventBus.emit('event', { guildId: event.guildId, eventId: event.id });
        } catch (error) {
            console.error('EventService: event listener failed:', error.message || error);
        }
    }

    async log(event, action, actor, source, extra = {}) {
        await AuditLogService.log({
            guildId: event.guildId,
            action,
            actorId: actor?.id || null,
            actorTag: actor?.tag || null,
            source,
            details: { eventId: event.id, eventTitle: event.title, startsAt: event.startsAt, ...extra }
        });
    }

    /**
     * Check a create/edit form.
     * @returns {{ ok: true, fields } | { ok: false, code, field }}
     */
    validate(guild, body, { now = Date.now() } = {}) {
        const fail = (field, code) => ({ ok: false, field, code });
        const title = String(body.title || '').trim().slice(0, 100);
        if (!title) return fail('title', 'invalid_title');
        const description = String(body.description || '').trim().slice(0, 1000);
        const startsAt = Date.parse(body.startsAt);
        if (!Number.isFinite(startsAt) || startsAt < now + MINUTE_MS || startsAt > now + MAX_AHEAD_MS) return fail('startsAt', 'invalid_time');

        const channel = guild.channels.cache.get(String(body.channelId || ''));
        if (!channel || !TEXT_TYPES.has(channel.type)) return fail('channelId', 'channel_not_found');
        const perms = channel.permissionsFor(guild.members.me);
        if (![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].every(f => perms?.has(f))) {
            return fail('channelId', 'bot_cannot_channel');
        }
        let voiceChannelId = null;
        if (body.voiceChannelId) {
            const voice = guild.channels.cache.get(String(body.voiceChannelId));
            if (!voice || !VOICE_TYPES.has(voice.type)) return fail('voiceChannelId', 'channel_not_found');
            voiceChannelId = voice.id;
        }
        return {
            ok: true,
            fields: { title, description, startsAt: new Date(startsAt).toISOString(), channelId: channel.id, voiceChannelId, repeatWeekly: Boolean(body.repeatWeekly) }
        };
    }

    async publish(guild, event) {
        const channel = guild.channels.cache.get(event.channelId);
        const message = await channel.send(buildEventMessage(event));
        event.messageId = message.id;
        return event;
    }

    /** Edit the card; if it was deleted (or the channel changed), post a new one. */
    async render(guild, event, { moved = false } = {}) {
        const channel = guild.channels.cache.get(event.channelId);
        if (!channel) return event;
        if (event.messageId && !moved) {
            const message = await channel.messages.fetch(event.messageId).catch(() => null);
            if (message) {
                await message.edit(buildEventMessage(event));
                return event;
            }
        }
        if (event.status !== 'scheduled') return event;
        return this.publish(guild, event);
    }

    async create(guild, body, actor, source) {
        const check = this.validate(guild, body);
        if (!check.ok) return check;
        const id = crypto.randomUUID();
        const event = {
            id,
            guildId: guild.id,
            ...check.fields,
            seriesId: id,
            messageId: null,
            going: [],
            status: 'scheduled',
            remindedAt: null,
            createdBy: actor.id,
            createdAt: new Date().toISOString()
        };
        await this.publish(guild, event);
        await this.save(event);
        await this.log(event, 'event.created', actor, source);
        this.emit(event);
        return { ok: true, event };
    }

    async update(guild, eventId, body, actor, source) {
        return this.withLock(eventId, async () => {
            const event = await this.get(guild.id, eventId);
            if (!event) return { ok: false, code: 'event_not_found' };
            if (event.status !== 'scheduled') return { ok: false, code: 'event_closed' };
            const check = this.validate(guild, body);
            if (!check.ok) return check;
            const oldChannelId = event.channelId;
            const oldMessageId = event.messageId;
            const timeChanged = check.fields.startsAt !== event.startsAt;
            Object.assign(event, check.fields);
            if (timeChanged) event.remindedAt = null;
            const moved = oldChannelId !== event.channelId;
            await this.render(guild, event, { moved });
            if (moved && oldMessageId) {
                await guild.channels.cache.get(oldChannelId)?.messages.delete(oldMessageId).catch(() => {});
            }
            await this.save(event);
            await this.log(event, 'event.updated', actor, source);
            this.emit(event);
            return { ok: true, event };
        });
    }

    async cancel(guild, eventId, actor, source) {
        return this.withLock(eventId, async () => {
            const event = await this.get(guild.id, eventId);
            if (!event) return { ok: false, code: 'event_not_found' };
            if (event.status !== 'scheduled') return { ok: false, code: 'event_closed' };
            event.status = 'cancelled';
            await this.render(guild, event).catch(error => console.error('EventService: card edit failed:', error.message || error));
            await this.save(event);
            await this.log(event, 'event.cancelled', actor, source);
            this.emit(event);
            return { ok: true, event };
        });
    }

    withLock(eventId, fn) {
        const previous = this.locks.get(eventId) || Promise.resolve();
        const run = previous.catch(() => {}).then(fn);
        this.locks.set(eventId, run);
        run.finally(() => { if (this.locks.get(eventId) === run) this.locks.delete(eventId); }).catch(() => {});
        return run;
    }

    /** «Иду» / «Не иду» from the card. */
    async setGoing(guildId, eventId, userId, going) {
        return this.withLock(eventId, async () => {
            const event = await this.get(guildId, eventId);
            if (!event) return { ok: false, code: 'event_not_found' };
            if (event.status !== 'scheduled') return { ok: false, code: 'event_closed', event };
            const list = new Set(event.going || []);
            const had = list.has(userId);
            if (going) list.add(userId); else list.delete(userId);
            if (had === going) return { ok: true, event, changed: false };
            event.going = [...list];
            await this.save(event);
            this.emit(event);
            return { ok: true, event, changed: true };
        });
    }

    /** Ping those going, once, 15 minutes before. */
    async remind(guild, event, now) {
        event.remindedAt = new Date(now).toISOString();
        const going = event.going || [];
        if (going.length === 0) return;
        const channel = guild.channels.cache.get(event.channelId);
        if (!channel) return;
        const where = event.voiceChannelId ? ` Сбор в <#${event.voiceChannelId}>.` : '';
        const mentions = going.slice(0, 90).map(id => `<@${id}>`).join(' ');
        await channel.send({
            content: `⏰ «${event.title}» начинается ${stamp(event.startsAt, 'R')}.${where}\n${mentions}`,
            allowedMentions: { users: going.slice(0, 90) }
        });
    }

    /** At the start: close sign-up; a weekly event publishes next week's card. */
    async start(guild, event) {
        event.status = 'done';
        await this.render(guild, event).catch(error => console.error('EventService: card edit failed:', error.message || error));
        await this.log(event, 'event.started', null, 'auto', { going: (event.going || []).length });
        if (!event.repeatWeekly) return null;

        let startsAt = Date.parse(event.startsAt) + WEEK_MS;
        while (startsAt < Date.now() + MINUTE_MS) startsAt += WEEK_MS; // the bot was down for weeks
        const next = {
            ...event,
            id: crypto.randomUUID(),
            startsAt: new Date(startsAt).toISOString(),
            messageId: null,
            going: [],
            status: 'scheduled',
            remindedAt: null,
            createdAt: new Date().toISOString()
        };
        delete next._rid; delete next._self; delete next._etag; delete next._attachments; delete next._ts;
        if (guild.channels.cache.get(next.channelId)) await this.publish(guild, next);
        await this.save(next);
        await this.log(next, 'event.created', null, 'auto', { repeated: true });
        this.emit(next);
        return next;
    }

    /** Called every minute: reminders and starts. Returns how many events changed. */
    async processDue(client, now = Date.now()) {
        let changed = 0;
        for (const due of await this.listDue(now)) {
            const guild = client.guilds.cache.get(due.guildId);
            if (!guild) continue;
            try {
                await this.withLock(due.id, async () => {
                    const event = await this.get(due.guildId, due.id);
                    if (!event || event.status !== 'scheduled') return;
                    const startsAt = Date.parse(event.startsAt);
                    if (!event.remindedAt && now >= startsAt - REMIND_BEFORE_MS && now < startsAt + LATE_REMINDER_MS) {
                        await this.remind(guild, event, now);
                        await this.save(event);
                        changed++;
                    }
                    if (now >= startsAt) {
                        await this.start(guild, event);
                        await this.save(event);
                        this.emit(event);
                        changed++;
                    }
                });
            } catch (error) {
                console.error(`Events: processing ${due.id} failed:`, error.message || error);
            }
        }
        return changed;
    }
}

module.exports = new EventService();
module.exports.REMIND_BEFORE_MS = REMIND_BEFORE_MS;
