const express = require('express');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const { roleProblem, assignableRoles } = require('../../../services/RoleService');
const EconomyService = require('../../../modules/economy/EconomyService');
const PersonalRoleService = require('../../../modules/economy/PersonalRoleService');
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
        payEnabled: settings.payEnabled,
        gamesEnabled: settings.gamesEnabled,
        personalRoles: {
            ...settings.personalRoles,
            anchorName: guild.roles.cache.get(settings.personalRoles.anchorRoleId)?.name || null
        },
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
            // Where personal roles may go: any role below the bot's own, highest first
            anchorRoles: canManage ? [...guild.roles.cache.values()]
                .filter(role => role.id !== guild.id && role.position + 1 < (guild.members.me?.roles.highest.position ?? 0))
                .sort((a, b) => b.position - a.position)
                .map(role => ({ id: role.id, name: role.name, position: role.position })) : [],
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
    if ('payEnabled' in body) value.payEnabled = body.payEnabled === true;
    if ('gamesEnabled' in body) value.gamesEnabled = body.gamesEnabled === true;
    if ('personalRoles' in body) {
        const input = body.personalRoles || {};
        const next = { ...current.personalRoles };
        if ('enabled' in input) next.enabled = input.enabled === true;
        if ('anchorRoleId' in input) {
            const anchor = guild.roles.cache.get(String(input.anchorRoleId || ''));
            if (input.anchorRoleId && (!anchor || anchor.id === guild.id)) return fail('personalRoles', 'role_not_found');
            // New roles go right above the anchor, so the bot's own role must be higher still
            if (anchor && anchor.position + 1 >= (guild.members.me?.roles.highest.position ?? 0)) return fail('personalRoles', 'anchor_too_high', { roleName: anchor.name });
            next.anchorRoleId = anchor ? anchor.id : null;
        }
        const ranges = { createPrice: [0, 1_000_000], rentPrice: [0, 1_000_000], periodDays: [1, 365], maxActive: [1, 10] };
        for (const [key, [min, max]] of Object.entries(ranges)) {
            if (!(key in input)) continue;
            const n = Number(input[key]);
            if (!Number.isInteger(n) || n < min || n > max) return fail('personalRoles', `invalid_${key}`);
            next[key] = n;
        }
        if (next.enabled && !next.anchorRoleId) return fail('personalRoles', 'anchor_required');
        value.personalRoles = next;
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

// GET /economy/personal-roles — every personal role: owner, term, price, buyers
router.get('/personal-roles', async (req, res, next) => {
    try {
        const guild = req.guild;
        const docs = await PersonalRoleService.list(guild.id);
        const person = id => {
            const member = guild.members.cache.get(id);
            return { id, displayName: member?.displayName || null, avatarURL: member ? member.user.displayAvatarURL({ size: 64, extension: 'png' }) : null, member: Boolean(member) };
        };
        res.json({
            items: docs.map(doc => {
                const role = guild.roles.cache.get(doc.roleId);
                return {
                    roleId: doc.roleId,
                    name: role?.name || null,
                    color: role?.hexColor || null,
                    iconURL: role?.iconURL?.() || null,
                    emoji: role?.unicodeEmoji || null,
                    owner: person(doc.ownerId),
                    ownerWears: doc.ownerWears !== false,
                    price: doc.price || null,
                    expiresAt: doc.expiresAt,
                    buyers: (doc.buyers || []).map(b => ({ ...person(b.userId), expiresAt: b.expiresAt })),
                    createdAt: doc.createdAt
                };
            }),
            canManage: req.panelRole === 'senior'
        });
    } catch (error) {
        next(error);
    }
});

// POST /economy/personal-roles/:roleId/grant — { days }: free extra time
router.post('/personal-roles/:roleId/grant', seniorOnly, async (req, res, next) => {
    try {
        const who = actorOf(req);
        const result = await PersonalRoleService.grant(req.guild, req.params.roleId, Number(req.body?.days), { ...who, source: 'panel' });
        sendResult(res, result, { not_personal: 404, invalid_days: 400 });
    } catch (error) {
        next(error);
    }
});

// DELETE /economy/personal-roles/:roleId — delete the role for good
router.delete('/personal-roles/:roleId', seniorOnly, async (req, res, next) => {
    try {
        const who = actorOf(req);
        const result = await PersonalRoleService.destroy(req.guild, req.params.roleId, { ...who, source: 'panel' }, `Личная роль удалена из приложения · ${who.tag}`);
        sendResult(res, result, { not_personal: 404, discord_error: 502 });
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
