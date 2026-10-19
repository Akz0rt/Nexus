const crypto = require('node:crypto');
const EventBus = require('./EventBus');

const EMIT_EVERY_MS = 250;           // progress frames per task, at most
const KEEP_FINISHED_MS = 10 * 60 * 1000;
const FAILURES_SHOWN = 20;

/**
 * Group actions run in the background with progress («Перенос в «Мафия»: 5 / 6»).
 * A task is started from a spec:
 *   exec(hooks)        — does the work; calls hooks.onStart(total) once the request
 *                        checked out, hooks.onItem(result) per member, and stops early
 *                        when hooks.isCancelled() says so; resolves to { ok, done, failed, ... }
 *   revert(task, actor) → spec that undoes what was done («Отменить всё»), or null
 *   retry(ids, actor)   → spec that tries the failed ones again, or null
 * Progress goes over SSE ('task' events) to the person who started it.
 * Tasks live in memory: a restart forgets them, Discord keeps whatever was done.
 */
class TaskService {
    constructor() {
        this.tasks = new Map(); // id -> task
    }

    publicTask(task) {
        return {
            id: task.id,
            guildId: task.guildId,
            kind: task.kind,
            title: task.title,
            actorId: task.actorId,
            total: task.total,
            processed: task.processed,
            doneCount: task.done.length,
            failedCount: task.failed.length,
            failed: task.failed.slice(0, FAILURES_SHOWN),
            status: task.status,
            canRevert: Boolean(task.spec.revert) && task.done.length > 0 && !task.reverted,
            canRetry: Boolean(task.spec.retry) && task.failed.length > 0 && !task.retried,
            // A line about what else happened ("в ЛС позвали 2"), once it is known
            note: task.result && task.spec.note ? task.spec.note(task.result) : null,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt
        };
    }

    emit(task, force = false) {
        if (!force && Date.now() - task.lastEmit < EMIT_EVERY_MS) return;
        task.lastEmit = Date.now();
        try {
            EventBus.emit('task', this.publicTask(task));
        } catch (error) {
            console.error('TaskService: event listener failed:', error.message || error);
        }
    }

    forgetOld(now = Date.now()) {
        for (const [id, task] of this.tasks) {
            if (task.finishedAt && now - Date.parse(task.finishedAt) > KEEP_FINISHED_MS) this.tasks.delete(id);
        }
    }

    /**
     * Start a task. Resolves once the request checked out: { ok: true, task } (running or,
     * for a small one, already done), or the refusal ({ ok: false, code }) — no task then.
     * @param {{ guildId: string, kind: string, title: string, actorId: string, exec: Function, revert?: Function, retry?: Function }} spec
     */
    start(spec) {
        this.forgetOld();
        const task = {
            id: crypto.randomUUID(),
            guildId: spec.guildId,
            kind: spec.kind,
            title: spec.title,
            actorId: spec.actorId,
            spec,
            total: 0,
            processed: 0,
            done: [],
            failed: [],
            status: 'running',
            cancelRequested: false,
            reverted: false,
            retried: false,
            result: null,
            lastEmit: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null
        };
        return new Promise(resolve => {
            let started = false;
            const begin = total => {
                if (started) return;
                started = true;
                task.total = total;
                this.tasks.set(task.id, task);
                this.emit(task, true);
                resolve({ ok: true, task: this.publicTask(task) });
            };
            const hooks = {
                onStart: begin,
                onItem: result => {
                    if (result.code === 'cancelled') return;
                    task.processed++;
                    if (result.code) task.failed.push({ userId: result.userId, name: result.name || null, code: result.code });
                    else task.done.push(result.userId);
                    this.emit(task);
                },
                isCancelled: () => task.cancelRequested
            };
            task.promise = Promise.resolve()
                .then(() => spec.exec(hooks))
                .catch(error => {
                    console.error(`TaskService: ${spec.kind} failed:`, error.message || error);
                    return { ok: false, code: 'failed' };
                })
                .then(result => {
                    if (!started && !result.ok) { resolve(result); return; }
                    if (!started) begin((result.done?.length || 0) + (result.failed?.length || 0));
                    task.result = result;
                    // The service's own lists are the final word (they include members skipped up front)
                    if (Array.isArray(result.done)) task.done = [...result.done];
                    if (Array.isArray(result.failed)) task.failed = result.failed.filter(f => f.code !== 'cancelled');
                    task.processed = task.done.length + task.failed.length;
                    task.status = task.cancelRequested ? 'cancelled' : 'done';
                    task.finishedAt = new Date().toISOString();
                    this.emit(task, true);
                });
        });
    }

    get(id) {
        return this.tasks.get(id) || null;
    }

    /** Running and recently finished tasks of one person on one server. */
    list(guildId, actorId) {
        this.forgetOld();
        return [...this.tasks.values()]
            .filter(task => task.guildId === guildId && task.actorId === actorId)
            .map(task => this.publicTask(task));
    }

    own(id, guildId, actorId) {
        const task = this.get(id);
        if (!task || task.guildId !== guildId) return { ok: false, code: 'task_not_found' };
        if (task.actorId !== actorId) return { ok: false, code: 'forbidden' };
        return { ok: true, task };
    }

    /** Stop a running task: members not reached yet are left as they are. */
    cancel(id, guildId, actorId) {
        const found = this.own(id, guildId, actorId);
        if (!found.ok) return found;
        if (found.task.status === 'running') found.task.cancelRequested = true;
        return { ok: true, task: this.publicTask(found.task) };
    }

    /** «Отменить всё»: stop it if it still runs, then undo what was done. */
    async revert(id, guildId, actor) {
        const found = this.own(id, guildId, actor.id);
        if (!found.ok) return found;
        const task = found.task;
        if (!task.spec.revert || task.reverted) return { ok: false, code: 'not_revertable' };
        task.cancelRequested = true;
        await task.promise;
        const spec = task.done.length > 0 ? task.spec.revert(task, actor) : null;
        task.reverted = true;
        this.emit(task, true);
        if (!spec) return { ok: true, task: this.publicTask(task) };
        return this.start(spec);
    }

    /** «Повторить для неудачных» */
    async retry(id, guildId, actor) {
        const found = this.own(id, guildId, actor.id);
        if (!found.ok) return found;
        const task = found.task;
        if (task.status === 'running') return { ok: false, code: 'task_running' };
        const ids = task.failed.map(f => f.userId).filter(Boolean);
        const spec = task.spec.retry && ids.length ? task.spec.retry(ids, actor, task) : null;
        if (!spec) return { ok: false, code: 'nothing_to_retry' };
        task.retried = true;
        this.emit(task, true);
        return this.start(spec);
    }
}

module.exports = new TaskService();
module.exports.TaskService = TaskService;
