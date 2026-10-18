// Standalone test (no test framework configured): run with `node test/events.test.js`
// Events: the form is validated, the card is published and kept up to date,
// sign-ups are not lost when two people click at once, the 15-minute reminder
// pings only those going and only once, the start closes sign-up and a weekly
// event publishes next week's card.

const assert = require('assert');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const AuditLogService = require('../src/services/AuditLogService');
const EventService = require('../src/modules/events/EventService');
const { buildEventMessage } = require('../src/modules/events/card');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const A = '200000000000000001';
const B = '200000000000000002';
const TEXT = '600000000000000001';
const VOICE = '600000000000000002';

const docs = new Map();
EventService.initialize = async () => {};
EventService.get = async (guildId, id) => (docs.has(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null);
EventService.save = async event => {
    await new Promise(resolve => setTimeout(resolve, 5)); // slow DB: a lost update would show
    docs.set(event.id, JSON.parse(JSON.stringify(event)));
    return event;
};
EventService.listDue = async now => [...docs.values()]
    .filter(e => e.status === 'scheduled' && Date.parse(e.startsAt) <= now + EventService.REMIND_BEFORE_MS);
const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };

const guild = makeGuild();
const sent = [];
const messages = new Map();
const channel = {
    id: TEXT, name: 'ивенты', type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => {
        const id = `7000000000000000${String(sent.length).padStart(2, '0')}`;
        const message = { id, payload, edit: async next => { message.payload = next; } };
        sent.push(payload);
        messages.set(id, message);
        return message;
    },
    messages: {
        fetch: async id => messages.get(id) || Promise.reject(new Error('Unknown Message')),
        delete: async id => messages.delete(id)
    }
};
guild.channels.cache.set(TEXT, channel);
guild.channels.cache.set(VOICE, { id: VOICE, name: 'Мафия', type: ChannelType.GuildVoice });
makeMember(guild, MOD, { perms: flag => flag === PermissionFlagsBits.MoveMembers });
const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
const mod = { id: MOD, tag: 'mod' };
const inMinutes = n => new Date(Date.now() + n * 60000).toISOString();

async function validation() {
    const bad = (body, code) => assert.strictEqual(EventService.validate(guild, body).code, code);
    bad({ title: '', startsAt: inMinutes(60), channelId: TEXT }, 'invalid_title');
    bad({ title: 'Мафия', startsAt: inMinutes(-5), channelId: TEXT }, 'invalid_time');
    bad({ title: 'Мафия', startsAt: inMinutes(60), channelId: VOICE }, 'channel_not_found');
    bad({ title: 'Мафия', startsAt: inMinutes(60), channelId: TEXT, voiceChannelId: TEXT }, 'channel_not_found');
    const ok = EventService.validate(guild, { title: ' Мафия ', startsAt: inMinutes(60), channelId: TEXT, voiceChannelId: VOICE, repeatWeekly: 1 });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual([ok.fields.title, ok.fields.voiceChannelId, ok.fields.repeatWeekly], ['Мафия', VOICE, true]);
}

async function signUps() {
    const created = await EventService.create(guild, { title: 'Мафия', startsAt: inMinutes(60), channelId: TEXT, voiceChannelId: VOICE }, mod, 'panel');
    assert.strictEqual(created.ok, true);
    const event = created.event;
    assert.ok(event.messageId, 'card published');
    assert.strictEqual(sent[0].components.length, 1, 'buttons while sign-up is open');

    const [a, b] = await Promise.all([
        EventService.setGoing(guild.id, event.id, A, true),
        EventService.setGoing(guild.id, event.id, B, true)
    ]);
    assert.ok(a.ok && b.ok);
    assert.deepStrictEqual(docs.get(event.id).going.sort(), [A, B].sort(), 'no sign-up lost');
    assert.strictEqual((await EventService.setGoing(guild.id, event.id, A, true)).changed, false);
    await EventService.setGoing(guild.id, event.id, B, false);
    assert.deepStrictEqual(docs.get(event.id).going, [A]);
    const card = buildEventMessage(docs.get(event.id));
    assert.ok(JSON.stringify(card.embeds[0].toJSON()).includes(`<@${A}>`));
    assert.deepStrictEqual(card.allowedMentions, { parse: [] }, 'the card never pings');
    return event.id;
}

async function reminderAndStart(eventId) {
    const event = docs.get(eventId);
    const startsAt = Date.parse(event.startsAt);

    sent.length = 0;
    assert.strictEqual(await EventService.processDue(client, startsAt - 20 * 60000), 0, 'too early');
    await EventService.processDue(client, startsAt - 14 * 60000);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].content.includes(`<@${A}>`) && sent[0].content.includes(`<#${VOICE}>`));
    assert.deepStrictEqual(sent[0].allowedMentions, { users: [A] });
    await EventService.processDue(client, startsAt - 10 * 60000);
    assert.strictEqual(sent.length, 1, 'reminded once');

    await EventService.processDue(client, startsAt + 1000);
    const done = docs.get(eventId);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(messages.get(done.messageId).payload.components.length, 0, 'sign-up closed on the card');
    assert.strictEqual((await EventService.setGoing(guild.id, eventId, B, true)).code, 'event_closed');
}

async function weekly() {
    const created = await EventService.create(guild, { title: 'Мафия по пятницам', startsAt: inMinutes(30), channelId: TEXT, repeatWeekly: true }, mod, 'panel');
    const first = created.event;
    await EventService.setGoing(guild.id, first.id, A, true);
    await EventService.processDue(client, Date.parse(first.startsAt) + 1000);
    const next = [...docs.values()].find(e => e.seriesId === first.id && e.id !== first.id);
    assert.ok(next, 'next week created');
    assert.strictEqual(Date.parse(next.startsAt) - Date.parse(first.startsAt), 7 * 24 * 3600000);
    assert.deepStrictEqual(next.going, [], 'fresh sign-up');
    assert.ok(next.messageId && next.messageId !== first.messageId, 'its own card');
    assert.strictEqual(next.status, 'scheduled');
}

async function cancelling() {
    const { event } = await EventService.create(guild, { title: 'Кино', startsAt: inMinutes(90), channelId: TEXT }, mod, 'panel');
    const cancelled = await EventService.cancel(guild, event.id, mod, 'panel');
    assert.strictEqual(cancelled.event.status, 'cancelled');
    assert.strictEqual(messages.get(event.messageId).payload.components.length, 0);
    assert.strictEqual((await EventService.cancel(guild, event.id, mod, 'panel')).code, 'event_closed');
    assert.ok(logged.some(e => e.action === 'event.cancelled'));
}

async function failingChannel() {
    const { event } = await EventService.create(guild, { title: 'Сломанный канал', startsAt: inMinutes(30), channelId: TEXT, repeatWeekly: true }, mod, 'panel');
    await EventService.setGoing(guild.id, event.id, A, true);
    const realSend = channel.send;
    channel.send = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    const startsAt = Date.parse(event.startsAt);
    const before = logged.filter(e => e.action === 'event.started').length;
    await EventService.processDue(client, startsAt - 10 * 60000); // reminder fails
    assert.ok(docs.get(event.id).remindedAt, 'a failed reminder is not retried every minute');
    await EventService.processDue(client, startsAt + 1000);       // next week's card fails
    await EventService.processDue(client, startsAt + 61000);
    assert.strictEqual(docs.get(event.id).status, 'done');
    assert.strictEqual(logged.filter(e => e.action === 'event.started').length - before, 1, 'started exactly once');
    const next = [...docs.values()].find(e => e.seriesId === event.id && e.id !== event.id);
    assert.ok(next && next.status === 'scheduled' && !next.messageId, 'next week saved without a card');
    channel.send = realSend;
}

(async () => {
    await validation();
    const id = await signUps();
    await reminderAndStart(id);
    await weekly();
    await cancelling();
    await failingChannel();
    console.log('events tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
