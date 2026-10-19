const crypto = require('node:crypto');
const EventBus = require('../../services/EventBus');
const RoleService = require('../../services/RoleService');

const MAX_JOB_TARGETS = 5000;
const PROGRESS_EVERY_MS = 1000;
const FAILURES_SHOWN = 100;

/**
 * Mass role changes ("снять у всех", "выдать всем в голосовом") that are too big
 * for one HTTP request. One job per guild at a time, run in the background;
 * progress goes to open apps over SSE ('job' events). Jobs live in memory only:
 * a restart drops the running one, and Discord keeps whatever was already done.
 */
class RoleJobService {
    constructor() {
        this.jobs = new Map(); // guildId -> job (running or the last finished one)
    }

    current(guildId) {
        return this.jobs.get(guildId) || null;
    }

    publicJob(job) {
        const { results, ...rest } = job;
        return rest;
    }

    emit(job) {
        try {
            EventBus.emit('job', this.publicJob(job));
        } catch (error) {
            console.error('RoleJobService: event listener failed:', error.message || error);
        }
    }

    /** How many members a change would touch, for the confirmation dialog. */
    async preview(guild, { roleId, add, filter }, actor) {
        const auth = await RoleService.authorizeRole(guild, roleId, actor);
        if (!auth.ok) return auth;
        await this.ensureMembers(guild);
        const targets = RoleService.resolveTargets(guild, filter, auth.role, add);
        if (!targets.ok) return targets;
        const sample = targets.userIds.slice(0, 5).map(id => guild.members.cache.get(id)?.displayName || id);
        return { ok: true, count: targets.userIds.length, sample, limit: MAX_JOB_TARGETS };
    }

    // The member cache is complete after one full fetch; the GuildMembers intent keeps it current
    async ensureMembers(guild) {
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();
    }

    /**
     * Start a job and return at once; the work continues in the background.
     * @param {{ roleId: string, add: boolean, filter: object, duration?: string|null }} request
     */
    async start(guild, { roleId, add, filter, duration = null }, actor, source) {
        if (this.current(guild.id)?.status === 'running') return { ok: false, code: 'job_running' };
        const expiry = RoleService.expiryOf(add ? duration : null);
        if (!expiry.ok) return expiry;
        const auth = await RoleService.authorizeRole(guild, roleId, actor);
        if (!auth.ok) return auth;
        await this.ensureMembers(guild);
        const targets = RoleService.resolveTargets(guild, filter, auth.role, add);
        if (!targets.ok) return targets;
        if (targets.userIds.length === 0) return { ok: false, code: 'nobody' };
        if (targets.userIds.length > MAX_JOB_TARGETS) return { ok: false, code: 'too_many_targets' };
        // Checked again after the awaits: two clicks at once must not start two jobs
        if (this.current(guild.id)?.status === 'running') return { ok: false, code: 'job_running' };

        const job = {
            id: crypto.randomUUID(),
            guildId: guild.id,
            roleId: auth.role.id,
            roleName: auth.role.name,
            add: Boolean(add),
            durationMs: expiry.durationMs,
            actorId: actor.id,
            total: targets.userIds.length,
            processed: 0,
            failedCount: 0,
            failed: [],
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null
        };
        this.jobs.set(guild.id, job);
        this.emit(job);

        this.run(guild, job, targets.userIds, auth.role, actor, source, expiry).catch(error => {
            console.error('RoleJobService: job failed:', error.message || error);
            job.status = 'done';
            job.error = 'failed';
            job.finishedAt = new Date().toISOString();
            this.emit(job);
        });
        return { ok: true, job: this.publicJob(job) };
    }

    /** Stop the running job of a guild (only the person who started it). */
    cancel(guildId, actorId) {
        const job = this.current(guildId);
        if (!job || job.status !== 'running') return { ok: false, code: 'nothing_running' };
        if (job.actorId !== actorId) return { ok: false, code: 'forbidden' };
        job.cancelRequested = true;
        return { ok: true, job: this.publicJob(job) };
    }

    async run(guild, job, userIds, role, actor, source, expiry) {
        const reason = RoleService.roleReason(job.add, actor, expiry.durationMs);
        let lastEmit = Date.now();
        const all = await RoleService.mapLimit(userIds, userId => (job.cancelRequested
            ? { userId, code: 'cancelled' }
            : RoleService.changeMemberRole(guild, userId, role, job.add, { reason, actor, expiresAt: expiry.expiresAt })),
        done => {
            job.processed = done.length;
            job.failedCount = done.filter(r => r.code).length;
            if (Date.now() - lastEmit >= PROGRESS_EVERY_MS) {
                lastEmit = Date.now();
                this.emit(job);
            }
        });

        // Stopped from the app: members not reached yet are simply left out
        const results = all.filter(r => r.code !== 'cancelled');
        const summary = await RoleService.finishBulk(guild, results, role, job.add, actor, source, { ...expiry, total: job.total });
        job.processed = results.length;
        job.failedCount = summary.failed.length;
        job.failed = summary.failed.slice(0, FAILURES_SHOWN);
        job.failedIds = summary.failed.map(f => f.userId);
        job.doneCount = summary.done.length;
        job.doneIds = summary.done; // «Отменить всё» runs the opposite change for exactly these
        job.status = job.cancelRequested ? 'cancelled' : 'done';
        job.finishedAt = new Date().toISOString();
        this.emit(job);
    }
}

module.exports = new RoleJobService();
module.exports.MAX_JOB_TARGETS = MAX_JOB_TARGETS;
