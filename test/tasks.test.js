// Standalone test (no test framework configured): run with `node test/tasks.test.js`
// Background group actions (TaskTray): progress per member, a refusal answered at
// once without a task, stopping half-way, «Отменить всё» (moves go back, mutes are
// lifted, a disconnect can't be undone), «Повторить для неудачных», role jobs that
// stop and remember who they changed.

const assert = require('assert');
const EventBus = require('../src/services/EventBus');
const AuditLogService = require('../src/services/AuditLogService');
const VoiceService = require('../src/modules/voice/VoiceService');
const { TaskService } = require('../src/services/TaskService');
const tasks = require('../src/web/v2/voiceTasks');
const { makeGuild, makeChannel, makeMember, ALL } = require('./fake-voice-guild');

const MOD = { id: 'mod', tag: 'Mod' };
AuditLogService.log = async entry => entry;

function world() {
    const guild = makeGuild();
    makeChannel(guild, { id: 'lobby', name: 'Лобби' });
    makeChannel(guild, { id: 'mafia', name: 'Мафия' });
    makeMember(guild, 'mod', { position: 10, perms: ALL, channelId: 'lobby' });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) makeMember(guild, id, { channelId: 'lobby' });
    guild.members.me = { permissions: { has: () => true }, roles: { highest: { position: 99 } } };
    return guild;
}

const until = async (test, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!test()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 5));
    }
};

async function moveWithProgress() {
    const service = new TaskService();
    const guild = world();
    const frames = [];
    const listener = task => frames.push(task);
    EventBus.on('task', listener);
    guild.members.cache.get('c').voice.failWith = 50013; // no permission for this one
    const started = await service.start(tasks.moveSpec(guild, ['a', 'b', 'c'], 'mafia', MOD));
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.task.title, 'Перенос в «Мафия»');
    assert.strictEqual(started.task.total, 3);
    const task = service.get(started.task.id);
    await task.promise;
    const last = service.publicTask(task);
    assert.strictEqual(last.status, 'done');
    assert.strictEqual(last.doneCount, 2);
    assert.deepStrictEqual(last.failed.map(f => f.userId), ['c'], 'the one Discord refused');
    assert.ok(last.canRevert && last.canRetry);
    assert.ok(frames.length >= 2 && frames.at(-1).status === 'done', 'progress reaches the app');
    assert.strictEqual(guild.members.cache.get('a').voice.channelId, 'mafia');

    // «Отменить всё»: back to the lobby, as a task of its own
    const back = await service.revert(task.id, guild.id, MOD);
    assert.strictEqual(back.ok, true);
    assert.strictEqual(back.task.title, 'Возврат на места');
    await service.get(back.task.id).promise;
    assert.strictEqual(guild.members.cache.get('a').voice.channelId, 'lobby');
    assert.strictEqual(guild.members.cache.get('b').voice.channelId, 'lobby');
    assert.strictEqual(service.publicTask(task).canRevert, false, 'only once');
    assert.strictEqual((await service.revert(task.id, guild.id, MOD)).code, 'not_revertable');

    // «Повторить для неудачных»: just «c»
    delete guild.members.cache.get('c').voice.failWith;
    const again = await service.retry(task.id, guild.id, MOD);
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.task.total, 1);
    await service.get(again.task.id).promise;
    assert.strictEqual(guild.members.cache.get('c').voice.channelId, 'mafia');

    // Someone else's task is not theirs to touch, and they don't hear about it
    assert.strictEqual(service.cancel(task.id, guild.id, 'other').code, 'forbidden');
    assert.deepStrictEqual(service.list(guild.id, 'other'), []);
    assert.strictEqual(service.list(guild.id, 'mod').length, 3);
    EventBus.off('task', listener);
}

async function refusedAtOnce() {
    const service = new TaskService();
    const guild = world();
    const refused = await service.start(tasks.moveSpec(guild, ['a'], 'nowhere', MOD));
    assert.deepStrictEqual(refused, { ok: false, code: 'channel_not_found' });
    assert.strictEqual(service.tasks.size, 0, 'no task for a refused request');
}

async function cancelHalfWay() {
    const service = new TaskService();
    const guild = world();
    // More people than moves run at once (5); each move waits until released, so the task can be stopped in the middle
    const people = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    for (const id of people.slice(6)) makeMember(guild, id, { channelId: 'lobby' });
    const gates = [];
    for (const id of people) {
        const member = guild.members.cache.get(id);
        const move = member.voice.setChannel;
        member.voice.setChannel = async target => { await new Promise(r => gates.push(r)); return move(target); };
    }
    const muted = await service.start(tasks.moveSpec(guild, people, 'mafia', MOD));
    const moving = service.get(muted.task.id);
    await until(() => gates.length >= 5);
    gates.splice(0, 2).forEach(release => release());
    await until(() => moving.done.length >= 2);
    service.cancel(moving.id, guild.id, 'mod');
    const flush = setInterval(() => gates.splice(0).forEach(release => release()), 5);
    await moving.promise;
    clearInterval(flush);
    const result = service.publicTask(moving);
    assert.strictEqual(result.status, 'cancelled');
    assert.ok(result.doneCount < people.length, `stopped early (${result.doneCount} moved)`);
    assert.strictEqual(guild.members.cache.get('l').voice.channelId, 'lobby', 'the last one was never reached');
    assert.strictEqual(result.failedCount, 0, 'members not reached are not failures');
}

async function disconnectIsFinal() {
    const service = new TaskService();
    const guild = world();
    const started = await service.start(tasks.actionSpec(guild, 'disconnect', ['a', 'b'], MOD));
    assert.strictEqual(started.task.title, 'Отключаем от голоса');
    await service.get(started.task.id).promise;
    assert.strictEqual(service.publicTask(service.get(started.task.id)).canRevert, false, 'a disconnect cannot be undone');
    assert.strictEqual((await service.revert(started.task.id, guild.id, MOD)).code, 'not_revertable');
}

async function muteRevert() {
    const service = new TaskService();
    const guild = world();
    const started = await service.start(tasks.muteChannelSpec(guild, 'lobby', true, ['mod'], MOD));
    await service.get(started.task.id).promise;
    assert.strictEqual(guild.members.cache.get('a').voice.serverMute, true);
    assert.strictEqual(guild.members.cache.get('mod').voice.serverMute, false, 'the host keeps the mic');
    const back = await service.revert(started.task.id, guild.id, MOD);
    await service.get(back.task.id).promise;
    assert.strictEqual(guild.members.cache.get('a').voice.serverMute, false);
}

async function roleJobs() {
    const RoleJobService = require('../src/modules/roles/RoleJobService');
    const RoleService = require('../src/services/RoleService');
    const guild = { id: 'g', members: { cache: new Map(), fetch: async () => {} }, memberCount: 0 };
    RoleService.authorizeRole = async () => ({ ok: true, role: { id: 'r', name: 'Ивент' } });
    RoleService.resolveTargets = () => ({ ok: true, userIds: ['1', '2', '3', '4'] });
    RoleService.expiryOf = () => ({ ok: true, durationMs: null, expiresAt: null });
    RoleService.roleReason = () => 'test';
    let release;
    const gate = new Promise(r => { release = r; });
    let calls = 0;
    RoleService.changeMemberRole = async (g, userId) => { calls++; if (calls === 2) await gate; return { userId }; };
    RoleService.mapLimit = async (items, fn, onProgress) => {
        const results = [];
        for (const item of items) { results.push(await fn(item)); onProgress(results); }
        return results;
    };
    RoleService.finishBulk = async (g, results) => ({ done: results.filter(r => !r.code).map(r => r.userId), failed: results.filter(r => r.code) });
    const started = await RoleJobService.start(guild, { roleId: 'r', add: true, filter: {} }, MOD, 'panel');
    assert.strictEqual(started.ok, true);
    assert.strictEqual(RoleJobService.cancel('g', 'other').code, 'forbidden');
    assert.strictEqual(RoleJobService.cancel('g', 'mod').ok, true);
    release();
    await until(() => RoleJobService.current('g').status !== 'running');
    const job = RoleJobService.current('g');
    assert.strictEqual(job.status, 'cancelled');
    assert.deepStrictEqual(job.doneIds, ['1', '2'], '«Отменить всё» knows exactly who got the role');
    assert.strictEqual(job.failedCount, 0);
}

(async () => {
    await moveWithProgress();
    await refusedAtOnce();
    await cancelHalfWay();
    await disconnectIsFinal();
    await muteRevert();
    await roleJobs();
    console.log('tasks tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
