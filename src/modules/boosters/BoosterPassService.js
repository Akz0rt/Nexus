const { CosmosClient } = require('@azure/cosmos');
const { PermissionFlagsBits } = require('discord.js');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');
const GuildSettingsService = require('../../services/GuildSettingsService');
const VerificationService = require('../verification/VerificationService');
const QueueCardService = require('../verification/QueueCardService');
const { roleProblem } = require('../../services/RoleService');

const BOOSTER_PASSES_CONTAINER = 'booster_passes';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_TERM_MS = HOUR_MS;
const MAX_TERM_MS = 400 * DAY_MS;
const WARN_BEFORE_MS = DAY_MS;
const MAX_NOTE = 200;
const MAX_AT_ONCE = 50;
const ROLE_NAME = 'Бустер-аккаунт';
const UNKNOWN_MEMBER = 10007;
const MISSING_PERMISSIONS = 50013;

/**
 * Booster accounts: bought boosts come with accounts that only have to stay on the
 * server for a while. From the queue they get a marker role with no permissions and
 * keep @unverified (so they see nothing), drop out of the queue, and are kicked
 * when the term ends. Discord doesn't tell bots when a boost subscription ends,
 * so the term the moderator sets is what counts.
 * One document per (guildId, userId).
 */
class BoosterPassService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
        this.index = new Set(); // `${guildId}:${userId}` — boost changes of other members skip Cosmos
    }

    async initialize() {
        if (this.initialized) return;
        this.client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: BOOSTER_PASSES_CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.container = database.container(BOOSTER_PASSES_CONTAINER);
        this.initialized = true;
    }

    key(guildId, userId) {
        return `${guildId}:${userId}`;
    }

    has(guildId, userId) {
        return this.index.has(this.key(guildId, userId));
    }

    async loadIndex() {
        await this.initialize();
        const { resources } = await this.container.items.query('SELECT c.guildId, c.userId FROM c').fetchAll();
        for (const doc of resources) this.index.add(this.key(doc.guildId, doc.userId));
        this.indexLoaded = true;
        return this.index.size;
    }

    async get(guildId, userId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(userId, guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.until ASC',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    /** Passes ending within a day (or already over), across servers */
    async listDue(now = Date.now()) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.until <= @soon',
            parameters: [{ name: '@soon', value: new Date(now + WARN_BEFORE_MS).toISOString() }]
        }).fetchAll();
        return resources;
    }

    async save(pass) {
        await this.initialize();
        const doc = { ...pass, id: pass.userId };
        for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) delete doc[field];
        await this.container.items.upsert(doc);
        this.index.add(this.key(doc.guildId, doc.userId));
        return doc;
    }

    async remove(guildId, userId) {
        await this.initialize();
        this.index.delete(this.key(guildId, userId));
        await this.container.item(userId, guildId).delete().catch(error => { if (error.code !== 404) throw error; });
    }

    async log(guildId, action, actor, targetIds, details = {}, source = 'panel') {
        await AuditLogService.log({
            guildId,
            action,
            actorId: actor?.id || null,
            actorTag: actor?.tag || null,
            targetIds,
            source,
            details
        });
    }

    /** A term from the form: an ISO date between an hour and 400 days ahead */
    checkUntil(until, now = Date.now()) {
        const at = Date.parse(until);
        if (!Number.isFinite(at) || at < now + MIN_TERM_MS || at > now + MAX_TERM_MS) return null;
        return new Date(at).toISOString();
    }

    /**
     * The marker role: the one in Settings → Пропуск, or a new one with no permissions
     * (made once, then saved in the settings).
     */
    async ensureRole(guild, settings, actor) {
        const existing = settings.boosterRoleId && guild.roles.cache.get(settings.boosterRoleId);
        if (existing) return { ok: true, role: existing };
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return { ok: false, code: 'bot_cannot_role' };
        const role = await guild.roles.create({
            name: ROLE_NAME,
            permissions: [],
            color: 0x99aab5,
            hoist: false,
            mentionable: false,
            reason: 'Метка буст-аккаунтов: без прав, бот кикнет их по сроку'
        });
        await GuildSettingsService.update(guild.id, { boosterRoleId: role.id });
        await this.log(guild.id, 'booster.role_created', actor, [], { roleId: role.id, roleName: role.name });
        return { ok: true, role };
    }

    /**
     * «Бустер…» from the queue, one or several at once: the marker role, @unverified stays,
     * the card is closed as a booster pass.
     * @returns {{ ok: true, done: string[], failed: { userId, code }[], until } | { ok: false, code }}
     */
    async pass(guild, userIds, { until, note }, actor, source = 'panel') {
        const settings = await VerificationService.getQueueSettings(guild.id);
        if (!settings) return { ok: false, code: 'not_configured' };
        if (!(await VerificationService.assertPermission(guild, actor.id, PermissionFlagsBits.ManageRoles))) return { ok: false, code: 'forbidden' };
        const term = this.checkUntil(until);
        if (!term) return { ok: false, code: 'invalid_term' };
        const ids = [...new Set((userIds || []).map(String))].slice(0, MAX_AT_ONCE);
        if (ids.length === 0) return { ok: false, code: 'invalid_targets' };
        const cleanNote = String(note || '').trim().slice(0, MAX_NOTE) || null;

        const ensured = await this.ensureRole(guild, settings, actor);
        if (!ensured.ok) return ensured;
        const { role } = ensured;
        if (!role.editable) return { ok: false, code: 'bot_cannot_role' };
        const actorMember = await guild.members.fetch(actor.id).catch(() => null);
        const problem = actorMember ? roleProblem(guild, actorMember, role) : 'forbidden';
        if (problem) return { ok: false, code: problem };

        const done = [];
        const failed = [];
        const doc = userId => ({ guildId: guild.id, userId, roleId: role.id, until: term, note: cleanNote, createdBy: actor.id, createdAt: new Date().toISOString(), warnedAt: null, kickFailedAt: null });
        for (const userId of ids) {
            let result;
            const holder = guild.members.cache.get(userId);
            if (holder?.roles.cache.has(role.id) && !this.has(guild.id, userId)) {
                // The marker given by hand, no term yet: only the term is missing
                result = await this.save(doc(userId)).then(() => ({ ok: true }), () => ({ ok: false, code: 'failed' }));
            } else {
                result = await VerificationService.withQueuedMember(guild, userId, settings, async (card, member) => {
                    // The pass first: if the role can't be added it is taken back, so no member is left marked without a term
                    await this.save(doc(userId));
                    try {
                        await member.roles.add(role, `Буст-аккаунт до ${term.slice(0, 10)} · ${actor.tag || actor.id}`);
                    } catch (error) {
                        await this.remove(guild.id, userId).catch(() => {});
                        throw error;
                    }
                    const updated = await QueueCardService.upsert({
                        ...card, status: 'booster', boosterUntil: term, handledBy: actor.id, handledAt: new Date().toISOString()
                    });
                    await VerificationService.safeRender(guild, updated, member);
                    return { ok: true };
                }, { booster: true }).catch(error => ({ ok: false, code: error.code === MISSING_PERMISSIONS ? 'bot_cannot_role' : 'failed' }));
            }
            if (result.ok) done.push(userId); else failed.push({ userId, code: result.code });
        }
        if (done.length) await this.log(guild.id, 'booster.passed', actor, done, { until: term, count: done.length, ...(cleanNote ? { note: cleanNote } : {}) }, source);
        return { ok: true, done, failed, until: term };
    }

    /** «Продлить…»: a new end date; the day-before warning comes again */
    async extend(guild, userId, until, actor) {
        if (!(await VerificationService.assertPermission(guild, actor.id, PermissionFlagsBits.ManageRoles))) return { ok: false, code: 'forbidden' };
        const term = this.checkUntil(until);
        if (!term) return { ok: false, code: 'invalid_term' };
        const pass = await this.get(guild.id, userId);
        if (!pass) return { ok: false, code: 'pass_not_found' };
        const saved = await this.save({ ...pass, until: term, warnedAt: null, kickFailedAt: null });
        const card = await QueueCardService.get(guild.id, userId);
        if (card?.status === 'booster') {
            const updated = await QueueCardService.upsert({ ...card, boosterUntil: term });
            await VerificationService.safeRender(guild, updated, guild.members.cache.get(userId) || null);
        }
        await this.log(guild.id, 'booster.extended', actor, [userId], { from: pass.until, until: term });
        return { ok: true, pass: saved };
    }

    /** «Вернуть в очередь»: no term, no marker role; the card waits for a usual decision again */
    async release(guild, userId, actor) {
        const settings = await VerificationService.getQueueSettings(guild.id);
        if (!settings) return { ok: false, code: 'not_configured' };
        if (!(await VerificationService.assertPermission(guild, actor.id, PermissionFlagsBits.ManageRoles))) return { ok: false, code: 'forbidden' };
        const lock = VerificationService.lockKey(guild.id, userId);
        if (VerificationService.locks.has(lock)) return { ok: false, code: 'in_progress' };
        VerificationService.locks.add(lock);
        try {
            const pass = await this.get(guild.id, userId);
            const member = await guild.members.fetch(userId).catch(() => null);
            const markers = [...new Set([pass?.roleId, settings.boosterRoleId].filter(Boolean))].filter(id => member?.roles.cache.has(id));
            if (!pass && markers.length === 0) return { ok: false, code: 'pass_not_found' };
            if (markers.length) await member.roles.remove(markers, `Буст-аккаунт возвращён в очередь · ${actor.tag || actor.id}`);
            await this.remove(guild.id, userId);
            const card = await QueueCardService.get(guild.id, userId);
            if (card?.status === 'booster' && member?.roles.cache.has(settings.unverifiedRoleId)) {
                const reopened = await QueueCardService.upsert({ ...card, status: 'pending', boosterUntil: null, handledBy: null, handledAt: null });
                await VerificationService.safeRender(guild, reopened, member);
            }
            await this.log(guild.id, 'booster.released', actor, [userId]);
            return { ok: true };
        } finally {
            VerificationService.locks.delete(lock);
        }
    }

    /** Close the card and forget the pass once the account is gone */
    async finish(guild, userId, member) {
        await this.remove(guild.id, userId);
        const card = await QueueCardService.get(guild.id, userId).catch(() => null);
        if (card?.status === 'booster') {
            const updated = await QueueCardService.upsert({ ...card, status: 'booster_ended', handledAt: new Date().toISOString() });
            await VerificationService.safeRender(guild, updated, member);
        }
    }

    /** «Кикнуть сейчас» */
    async kickNow(guild, userId, actor) {
        if (!(await VerificationService.assertPermission(guild, actor.id, PermissionFlagsBits.KickMembers))) return { ok: false, code: 'forbidden' };
        const pass = await this.get(guild.id, userId);
        if (!pass) return { ok: false, code: 'pass_not_found' };
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
            if (!member.kickable) return { ok: false, code: 'bot_cannot' };
            // Out of the index first: our own kick must not come back as «ушёл сам»
            this.index.delete(this.key(guild.id, userId));
            try {
                await member.kick(`Буст-аккаунт: кик раньше срока · ${actor.tag || actor.id}`);
            } catch (error) {
                this.index.add(this.key(guild.id, userId));
                throw error;
            }
        }
        await this.finish(guild, userId, null);
        await this.log(guild.id, 'booster.kicked', actor, [userId], { until: pass.until, wasBoosting: Boolean(member?.premiumSince) });
        return { ok: true };
    }

    /**
     * Every few minutes: kick accounts whose term is over; a day before, tell the moderators
     * once per server («завтра истекает срок у 3 буст-аккаунтов»). Returns how many were kicked.
     */
    async processDue(client, now = Date.now()) {
        let kicked = 0;
        const warn = new Map(); // guildId -> passes
        for (const due of await this.listDue(now)) {
            const guild = client.guilds.cache.get(due.guildId);
            if (!guild) continue;
            try {
                const pass = await this.get(due.guildId, due.userId);
                if (!pass || Date.parse(pass.until) > now + WARN_BEFORE_MS) continue;
                if (Date.parse(pass.until) > now) {
                    if (!pass.warnedAt) warn.set(guild.id, [...(warn.get(guild.id) || []), pass]);
                    continue;
                }
                const member = await guild.members.fetch(pass.userId).catch(error => {
                    if (error.code === UNKNOWN_MEMBER) return null;
                    throw error;
                });
                if (member) {
                    this.index.delete(this.key(guild.id, pass.userId)); // our kick is not «ушёл сам»
                    try {
                        await member.kick('Срок буст-аккаунта истёк');
                    } catch (error) {
                        this.index.add(this.key(guild.id, pass.userId));
                        if (error.code !== MISSING_PERMISSIONS) throw error; // Discord down: next round
                        // Above the bot or no Kick Members: say so once instead of retrying forever
                        if (!pass.kickFailedAt) {
                            await this.save({ ...(await this.get(guild.id, pass.userId) || pass), kickFailedAt: new Date(now).toISOString() });
                            await this.log(guild.id, 'booster.expired', null, [pass.userId], { until: pass.until, failed: true }, 'auto');
                        }
                        continue;
                    }
                    kicked++;
                }
                await this.finish(guild, pass.userId, null);
                await this.log(guild.id, 'booster.expired', null, [pass.userId], { until: pass.until, wasBoosting: Boolean(member?.premiumSince), left: !member }, 'auto');
            } catch (error) {
                console.error(`Boosters: processing ${due.userId} failed:`, error.message || error);
            }
        }
        for (const [guildId, passes] of warn) {
            await this.log(guildId, 'booster.expiring', null, passes.map(p => p.userId), { count: passes.length, until: passes[0].until }, 'auto');
            for (const pass of passes) {
                const fresh = await this.get(guildId, pass.userId);
                if (fresh) await this.save({ ...fresh, warnedAt: new Date(now).toISOString() });
            }
        }
        return kicked;
    }

    /** Discord took the boost away before the term: the moderators should know */
    async onBoostChange(oldMember, newMember) {
        if (!oldMember.premiumSince || newMember.premiumSince) return;
        if (!this.has(newMember.guild.id, newMember.id)) return;
        const pass = await this.get(newMember.guild.id, newMember.id);
        if (!pass) return;
        await this.log(newMember.guild.id, 'booster.unboosted', null, [newMember.id], { until: pass.until }, 'discord');
    }

    /** Left on its own before the term */
    async onLeave(member) {
        if (!this.has(member.guild.id, member.id)) return;
        const pass = await this.get(member.guild.id, member.id);
        if (!pass) return;
        await this.finish(member.guild, member.id, null);
        await this.log(member.guild.id, 'booster.left', null, [member.id], { until: pass.until }, 'discord');
    }
}

module.exports = new BoosterPassService();
module.exports.ROLE_NAME = ROLE_NAME;
