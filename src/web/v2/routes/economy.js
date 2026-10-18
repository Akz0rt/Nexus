const express = require('express');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const { roleProblem, assignableRoles } = require('../../../services/RoleService');
const EconomyService = require('../../../modules/economy/EconomyService');
const economy = require('../../../modules/economy');
const { isDangerous } = require('../../../modules/rolemenus/RoleMenuService');
const curve = require('../../../modules/economy/curve');
const { actorOf, sendResult } = require('../result');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const MAX_LEVEL_ROLES = 20;
const TOP_LIMIT = 50;

const STATUS = {
    invalid_amount: 400,
    invalid_reason: 400,
    member_not_found: 404,
    insufficient_funds: 409
};

const seniorOnly = (req, res, next) => (req.panelRole === 'senior' ? next() : res.status(403).json({ error: 'forbidden' }));

/** An account for the app: who (live name if still here, the saved one otherwise) and progress. */
function serializeAccount(guild, account) {
    const member = guild.members.cache.get(account.userId);
    return {
        user: {
            id: account.userId,
            displayName: member?.displayName || account.displayName || account.username || null,
            avatarURL: member ? member.user.displayAvatarURL({ size: 64, extension: 'png' }) : null,
            member: Boolean(member)
        },
        level: account.level,
        prestige: account.prestige || 0,
        exp: account.exp,
        cost: curve.levelCost(account.level),
        money: account.money,
        leftAt: account.leftAt || null,
        voiceSeconds: account.voiceSeconds || 0,
        messages: account.messages || 0
    };
}

function describeSettings(guild, settings) {
    return {
        enabled: settings.enabled,
        channelId: settings.channelId,
        levelRoles: settings.levelRoles.map(entry => ({
            level: entry.level,
            roleId: entry.roleId,
            name: guild.roles.cache.get(entry.roleId)?.name || null
        }))
    };
}

// GET /economy?by=level|money&q= — the top (or a search), totals and settings
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const by = req.query.by === 'money' ? 'money' : 'level';
        const q = String(req.query.q || '').trim().toLowerCase().slice(0, 50);
        let accounts;
        if (q) {
            await EconomyService.initialize();
            const field = by === 'money' ? 'money' : 'totalExp';
            const { resources } = await EconomyService.accounts.items.query({
                query: `SELECT TOP @limit * FROM c WHERE c.guildId = @guildId AND NOT IS_STRING(c.leftAt) AND (c.userId = @q
                    OR CONTAINS(LOWER(c.displayName), @q) OR CONTAINS(LOWER(c.username), @q)) ORDER BY c.${field} DESC`,
                parameters: [{ name: '@guildId', value: guild.id }, { name: '@q', value: q }, { name: '@limit', value: TOP_LIMIT }]
            }, { partitionKey: guild.id }).fetchAll();
            accounts = resources;
        } else {
            accounts = await EconomyService.top(guild.id, by, TOP_LIMIT);
        }
        const [totals, settings] = await Promise.all([
            EconomyService.totals(guild.id),
            GuildSettingsService.get(guild.id)
        ]);
        const canManage = req.panelRole === 'senior';
        const viewer = canManage ? guild.members.cache.get(req.session.userId) : null;
        res.json({
            items: accounts.map(account => serializeAccount(guild, account)),
            totals,
            settings: describeSettings(guild, settings.economy),
            canManage,
            // For the settings form (administrators): channels for announcements, roles for levels
            channels: canManage ? [...guild.channels.cache.values()]
                .filter(c => TEXT_TYPES.has(c.type))
                .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
                .map(c => ({ id: c.id, name: c.name, category: c.parent?.name || null })) : [],
            roles: viewer ? assignableRoles(guild, viewer).filter(role => !isDangerous(guild.roles.cache.get(role.id))) : [],
            curve: { maxLevel: curve.MAX_LEVEL, prestigeExp: curve.PRESTIGE_EXP, prestigeReward: curve.PRESTIGE_REWARD }
        });
    } catch (error) {
        next(error);
    }
});

// GET /economy/members/:userId — one account with its places and recent operations
router.get('/members/:userId', async (req, res, next) => {
    try {
        const { userId } = req.params;
        if (!SNOWFLAKE_RE.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });
        const account = await EconomyService.get(req.guild.id, userId);
        const canManage = req.panelRole === 'senior';
        if (!account) return res.json({ account: null, transactions: [], canManage });
        const [levelRank, moneyRank, transactions] = await Promise.all([
            EconomyService.rank(req.guild.id, account, 'level'),
            EconomyService.rank(req.guild.id, account, 'money'),
            EconomyService.listTransactions(req.guild.id, userId, 30)
        ]);
        res.json({
            account: { ...serializeAccount(req.guild, account), levelRank, moneyRank },
            canManage,
            transactions: transactions.map(tx => ({
                id: tx.id, amount: tx.amount, balance: tx.balance, kind: tx.kind, cause: tx.cause,
                actorId: tx.actorId, source: tx.source, createdAt: tx.createdAt
            }))
        });
    } catch (error) {
        next(error);
    }
});

// POST /economy/members/:userId/adjust — { amount, reason }: give (+) or take (−) coins
router.post('/members/:userId/adjust', seniorOnly, async (req, res, next) => {
    try {
        const { userId } = req.params;
        if (!SNOWFLAKE_RE.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });
        const result = await EconomyService.adjust(req.guild, userId, Number(req.body?.amount), req.body?.reason, actorOf(req));
        if (result.ok) return res.json({ ok: true, account: serializeAccount(req.guild, result.account) });
        sendResult(res, result, STATUS);
    } catch (error) {
        next(error);
    }
});

/** Check a settings save. @returns {{ ok: true, value } | { ok: false, field, code, roleName? }} */
function sanitizeSettings(guild, actor, body, current) {
    const fail = (field, code, extra = {}) => ({ ok: false, field, code, ...extra });
    const value = { ...current };
    if ('enabled' in body) value.enabled = body.enabled === true;
    if ('channelId' in body) {
        const id = String(body.channelId || '');
        if (id) {
            const channel = guild.channels.cache.get(id);
            if (!channel || !TEXT_TYPES.has(channel.type)) return fail('channelId', 'channel_not_found');
            const perms = channel.permissionsFor(guild.members.me);
            if (![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].every(f => perms?.has(f))) {
                return fail('channelId', 'bot_cannot_channel');
            }
        }
        value.channelId = id || null;
    }
    if ('levelRoles' in body) {
        if (!Array.isArray(body.levelRoles) || body.levelRoles.length > MAX_LEVEL_ROLES) return fail('levelRoles', 'invalid_level_roles');
        const seen = new Set();
        const levelRoles = [];
        for (const entry of body.levelRoles) {
            const level = Number(entry?.level);
            if (!Number.isInteger(level) || level < 2 || level > curve.MAX_LEVEL) return fail('levelRoles', 'invalid_level');
            const role = guild.roles.cache.get(String(entry?.roleId || ''));
            const problem = roleProblem(guild, actor, role);
            if (problem) return fail('levelRoles', problem, { roleName: role?.name || null });
            if (isDangerous(role)) return fail('levelRoles', 'role_dangerous', { roleName: role.name });
            if (seen.has(role.id)) return fail('levelRoles', 'duplicate_role', { roleName: role.name });
            seen.add(role.id);
            levelRoles.push({ level, roleId: role.id });
        }
        value.levelRoles = levelRoles.sort((a, b) => a.level - b.level);
    }
    return { ok: true, value };
}

// PUT /economy/settings — { enabled?, channelId?, levelRoles? }
router.put('/settings', seniorOnly, async (req, res, next) => {
    try {
        const guild = req.guild;
        const actor = guild.members.cache.get(req.session.userId) || await guild.members.fetch(req.session.userId);
        const current = (await GuildSettingsService.get(guild.id)).economy;
        const result = sanitizeSettings(guild, actor, req.body || {}, current);
        if (!result.ok) return res.status(400).json({ error: result.code, field: result.field, roleName: result.roleName || null });
        await GuildSettingsService.update(guild.id, { economy: result.value });
        const who = actorOf(req);
        await AuditLogService.log({
            guildId: guild.id, action: 'economy.settings', actorId: who.id, actorTag: who.tag, targetIds: [], source: 'panel',
            details: { enabled: result.value.enabled, changed: Object.keys(req.body || {}) }
        });
        res.json({ ok: true, settings: describeSettings(guild, result.value) });
    } catch (error) {
        next(error);
    }
});

// POST /economy/sync-roles — give everyone the level roles they have reached
router.post('/sync-roles', seniorOnly, async (req, res, next) => {
    try {
        const settings = (await GuildSettingsService.get(req.guild.id)).economy;
        const result = await economy.syncLevelRoles(req.guild, settings.levelRoles);
        res.json({ ok: true, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.sanitizeSettings = sanitizeSettings;
module.exports.serializeAccount = serializeAccount;
