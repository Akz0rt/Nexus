// Standalone test (no test framework configured): run with `node test/tasks-routes.test.js`
// The background path over HTTP: a group move answers { ok, task } at once, its
// progress reaches only the starter's live stream, /tasks lists only your own,
// «Отменить всё» moves people back, and nobody else may stop or undo it.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const TaskService = require('../src/services/TaskService');
const { createApp } = require('../src/server');
const { makeGuild, makeChannel, makeMember } = require('./fake-voice-guild');

AuditLogService.log = async entry => entry;

const FLIX = '100000000000000001';
const KIRA = '100000000000000002';
const A = '300000000000000001';
const B = '300000000000000002';
const LOBBY = '500000000000000001';
const MAFIA = '500000000000000002';

const guild = makeGuild();
guild.iconURL = () => null;
makeChannel(guild, { id: LOBBY, name: 'Лобби' });
makeChannel(guild, { id: MAFIA, name: 'Мафия' });
const moveRight = flag => flag === PermissionFlagsBits.MoveMembers || flag === PermissionFlagsBits.Connect;
makeMember(guild, FLIX, { position: 10, perms: moveRight, channelId: LOBBY });
makeMember(guild, KIRA, { position: 10, perms: moveRight });
makeMember(guild, A, { channelId: LOBBY });
makeMember(guild, B, { channelId: LOBBY });
guild.members.me = { id: 'bot', permissions: { has: () => true }, roles: { highest: { position: 99 } } };
guild.memberCount = guild.members.cache.size;

async function readUntil(reader, test, ms = 3000) {
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({}), 150))]);
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        if (test(buffer)) return buffer;
    }
    return buffer;
}

(async () => {
    PanelSessionService.get = async token => ({ flix: { userId: FLIX, username: 'flix' }, kira: { userId: KIRA, username: 'kira' } }[token] || null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body, token = 'flix') => {
        const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    const readers = [];
    try {
        const flixStream = (await fetch(`${base}/events`, { headers: { Authorization: 'Bearer flix' } })).body.getReader();
        const kiraStream = (await fetch(`${base}/events`, { headers: { Authorization: 'Bearer kira' } })).body.getReader();
        readers.push(flixStream, kiraStream);

        const started = await call('POST', '/voice/move', { userIds: [A, B], channelId: MAFIA, background: true });
        assert.strictEqual(started.status, 200, JSON.stringify(started.body));
        assert.strictEqual(started.body.ok, true);
        assert.strictEqual(started.body.task.title, 'Перенос в «Мафия»');
        assert.strictEqual(started.body.task.total, 2);
        const id = started.body.task.id;
        await TaskService.get(id).promise;
        assert.strictEqual(guild.members.cache.get(A).voice.channelId, MAFIA);

        const flixFrames = await readUntil(flixStream, text => text.includes('"status":"done"'));
        assert.ok(flixFrames.includes('event: task') && flixFrames.includes(id), 'the starter sees the progress');
        const kiraFrames = await readUntil(kiraStream, () => false, 600);
        assert.ok(!kiraFrames.includes('event: task'), 'another moderator does not');

        assert.deepStrictEqual((await call('GET', '/tasks')).body.items.map(t => t.id), [id]);
        assert.deepStrictEqual((await call('GET', '/tasks', null, 'kira')).body.items, []);
        assert.strictEqual((await call('POST', `/tasks/${id}/cancel`, null, 'kira')).status, 403);
        assert.strictEqual((await call('POST', `/tasks/${id}/revert`, null, 'kira')).status, 403);

        const back = await call('POST', `/tasks/${id}/revert`);
        assert.strictEqual(back.status, 200, JSON.stringify(back.body));
        assert.strictEqual(back.body.task.title, 'Возврат на места');
        await TaskService.get(back.body.task.id).promise;
        assert.strictEqual(guild.members.cache.get(A).voice.channelId, LOBBY);
        assert.strictEqual(guild.members.cache.get(B).voice.channelId, LOBBY);
        assert.strictEqual((await call('POST', `/tasks/${id}/revert`)).body.error, 'not_revertable');

        // A refusal is answered at once, with no task
        const refused = await call('POST', '/voice/move', { userIds: [A], channelId: '500000000000000099', background: true });
        assert.strictEqual(refused.body.error, 'channel_not_found');
        console.log('task route tests passed');
    } finally {
        for (const reader of readers) await reader.cancel().catch(() => {});
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
