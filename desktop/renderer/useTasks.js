import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { firstFailure } from './TaskTray.jsx';

const COLLAPSE_MS = 5000;   // a finished task folds into a toast after this
const TOAST_MS = 10000;
const FRESH_MS = 30 * 1000; // a task that finished longer ago (seen at start-up, on another screen) is history

/** A mass role job (its own service) in the tray's shape; someone else's is shown read-only. */
function roleItem(job, mine) {
    return {
        key: `job:${job.id}`,
        source: 'role',
        job,
        title: `${job.add ? 'Выдаём' : 'Снимаем'} «${job.roleName}»`,
        total: job.total,
        processed: job.processed,
        failedCount: job.failedCount,
        failed: job.failed || [],
        status: job.status,
        note: mine ? null : 'запустил другой модератор',
        finishedAt: job.finishedAt,
        mine,
        canStop: false,
        canRevert: mine && (job.status === 'running' || (job.doneIds?.length > 0 && !job.reverted)),
        canRetry: mine && job.status !== 'running' && (job.failedIds?.length > 0) && !job.retried
    };
}

function taskItem(task) {
    // A running task that can't be undone (a disconnect) can at least be stopped
    return { ...task, key: `task:${task.id}`, source: 'task', mine: true, canStop: task.status === 'running' && !task.canRevert };
}

/** «Перенос в «Мафия»: 5 из 6 · Bob — не в голосе» */
function summary(item) {
    const done = item.source === 'role' ? (item.job.doneCount ?? item.processed - item.failedCount) : item.doneCount;
    const failure = firstFailure(item);
    const head = item.status === 'cancelled' ? `${item.title}: остановлено, успели ${done}` : `${item.title}: ${done} из ${item.total}`;
    return [head, failure, item.note].filter(Boolean).join(' · ');
}

/**
 * Background tasks of the person at this app: voice group actions (TaskService, 'task'
 * events) and the mass role job ('job' events, App passes it in). Gives the tray its
 * items and the three actions; a finished task leaves the tray for a toast after 5 s.
 */
export default function useTasks({ guildId, roleJob, onRoleJob, myId, toast }) {
    const [tasks, setTasks] = useState(() => new Map());
    const [hidden, setHidden] = useState(() => new Set());
    const timers = useRef(new Map());
    const gone = useRef(new Set()); // keys already out of the tray (no late toast for them)
    const seenRunning = useRef(new Set()); // keys this app watched while they ran
    const revertJobWhenDone = useRef(null); // role job stopped by «Отменить всё»: undo once it settles

    useEffect(() => {
        setTasks(new Map());
        setHidden(new Set());
        timers.current.forEach(clearTimeout);
        timers.current.clear();
        if (!guildId) return undefined;
        let cancelled = false;
        apiGet(`/guilds/${guildId}/tasks`)
            .then(data => { if (!cancelled) setTasks(new Map(data.items.map(task => [task.id, task]))); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [guildId]);

    /** An SSE 'task' frame */
    const onTask = useCallback(task => setTasks(map => new Map(map).set(task.id, task)), []);

    const hide = useCallback(key => {
        gone.current.add(key);
        setHidden(set => new Set(set).add(key));
    }, []);

    const startRoleJob = useCallback(async body => {
        const result = await apiPost(`/guilds/${guildId}/roles/jobs`, body);
        if (result.ok) onRoleJob(result.data.job);
        else toast(describeError(result), { tone: 'error' });
    }, [guildId, onRoleJob, toast]);

    const revert = useCallback(async item => {
        hide(item.key);
        if (item.source === 'task') {
            const result = await apiPost(`/guilds/${guildId}/tasks/${item.id}/revert`);
            if (!result.ok) toast(describeError(result), { tone: 'error' });
            else if (result.data.task) onTask(result.data.task);
            return;
        }
        const job = item.job;
        if (job.status === 'running') {
            revertJobWhenDone.current = job.id;
            const result = await apiPost(`/guilds/${guildId}/roles/jobs/cancel`);
            // Finished just now: the 'job' frame with the final list is on its way, the effect below undoes it
            if (!result.ok && result.error !== 'nothing_running') toast(describeError(result), { tone: 'error' });
            return;
        }
        onRoleJob({ ...job, reverted: true });
        await startRoleJob({ roleId: job.roleId, add: !job.add, filter: { type: 'users', userIds: job.doneIds } });
    }, [guildId, hide, onTask, onRoleJob, startRoleJob, toast]);

    const retry = useCallback(async item => {
        hide(item.key);
        if (item.source === 'task') {
            const result = await apiPost(`/guilds/${guildId}/tasks/${item.id}/retry`);
            if (!result.ok) toast(describeError(result), { tone: 'error' });
            else if (result.data.task) onTask(result.data.task);
            return;
        }
        onRoleJob({ ...item.job, retried: true });
        await startRoleJob({ roleId: item.job.roleId, add: item.job.add, filter: { type: 'users', userIds: item.job.failedIds } });
    }, [guildId, hide, onTask, onRoleJob, startRoleJob, toast]);

    // The role job stopped by «Отменить всё» has settled: give back / take away exactly what it changed
    useEffect(() => {
        if (!roleJob || roleJob.id !== revertJobWhenDone.current || roleJob.status === 'running') return;
        revertJobWhenDone.current = null;
        if (roleJob.doneIds?.length) {
            onRoleJob({ ...roleJob, reverted: true });
            startRoleJob({ roleId: roleJob.roleId, add: !roleJob.add, filter: { type: 'users', userIds: roleJob.doneIds } });
        }
    }, [roleJob, onRoleJob, startRoleJob]);

    const stop = useCallback(async item => {
        const result = await apiPost(`/guilds/${guildId}/tasks/${item.id}/cancel`);
        if (!result.ok) toast(describeError(result), { tone: 'error' });
    }, [guildId, toast]);

    const all = [
        ...(roleJob ? [roleItem(roleJob, roleJob.actorId === myId)] : []),
        ...[...tasks.values()].filter(task => task.actorId === myId).map(taskItem)
    ];
    for (const item of all) if (item.status === 'running') seenRunning.current.add(item.key);
    // Finished ones show only if watched here while running or just finished — never replayed later
    const items = all.filter(item => !hidden.has(item.key) && (item.status === 'running'
        || seenRunning.current.has(item.key)
        || (item.finishedAt && Date.now() - Date.parse(item.finishedAt) < FRESH_MS)));

    // Finished: fold into a toast after a moment, keeping «Отменить всё» / «Повторить» on it
    useEffect(() => {
        for (const item of items) {
            if (item.status === 'running' || timers.current.has(item.key)) continue;
            timers.current.set(item.key, setTimeout(() => {
                if (gone.current.has(item.key)) return; // closed or acted on already
                hide(item.key);
                if (!item.mine) return; // someone else's job: its card just goes
                const actions = [];
                if (item.canRevert) actions.push({ label: 'Отменить всё', onClick: () => revert(item) });
                if (item.canRetry) actions.push({ label: 'Повторить для неудачных', onClick: () => retry(item) });
                toast(summary(item), { tone: item.failedCount ? 'error' : null, ttl: actions.length ? TOAST_MS : 5000, actions });
            }, COLLAPSE_MS));
        }
    });

    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    return { items, onTask, revert, retry, stop, hide };
}
