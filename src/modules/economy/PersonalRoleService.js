const { CosmosClient } = require('@azure/cosmos');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');
const GuildSettingsService = require('../../services/GuildSettingsService');
const EconomyService = require('./EconomyService');

const CONTAINER = 'personal_roles';
const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_BEFORE_MS = 3 * DAY_MS;
const OWNER_RETURN_MS = EconomyService.RETURN_GRACE_DAYS * DAY_MS;
const SELLER_SHARE = 0.95;
const MAX_PREPAID_DAYS = 365;
const MAX_PRICE = 1_000_000;
const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COLOR_RE = /^#?([0-9a-f]{6})$/i;

const number = n => Number(n || 0).toLocaleString('ru-RU');
const stamp = (iso, style = 'f') => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

/** "#ff7a1a" / "ff7a1a" → 0xff7a1a; empty → 0 (no colour); anything else → null. */
function parseColor(value) {
    const text = String(value ?? '').trim();
    if (!text) return 0;
    const match = COLOR_RE.exec(text);
    return match ? parseInt(match[1], 16) : null;
}

/** An emoji typed as the icon: a short string without letters or digits. */
function isUnicodeEmoji(value) {
    const text = String(value || '').trim();
    return text.length > 0 && text.length <= 16 && !/[\p{L}\p{N}\s<>:]/u.test(text);
}

/**
 * Personal roles: a member rents a role of their own (name, colour, icon), extends
 * it before it runs out, and may sell it — buyers wear it for their own term, the
 * owner gets 95% of the price. A role nobody extends is deleted from Discord.
 * Stored in `personal_roles` (partition /guildId, id = Discord role id).
 *
 * Leaving follows the economy's rule: a buyer who leaves drops off the role at once;
 * an owner's id is replaced by the anonymous return key, the role comes off sale, and
 * unless they are back within 3 days the role is deleted.
 */
class PersonalRoleService {
    constructor() {
        this.container = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        const client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.container = database.container(CONTAINER);
        this.initialized = true;
    }

    // ---- storage (replaced by fakes in tests) ----

    async get(guildId, roleId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(String(roleId), guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.expiresAt',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async listAll() {
        await this.initialize();
        const { resources } = await this.container.items.query('SELECT * FROM c').fetchAll();
        return resources;
    }

    async save(doc) {
        await this.initialize();
        doc.updatedAt = new Date().toISOString();
        await this.container.items.upsert(doc);
        return doc;
    }

    async remove(guildId, roleId) {
        await this.initialize();
        await this.container.item(String(roleId), guildId).delete().catch(error => { if (error.code !== 404) throw error; });
    }

    // ---- helpers ----

    async settings(guildId) {
        return (await GuildSettingsService.get(guildId)).economy.personalRoles;
    }

    periodMs(settings) {
        return settings.periodDays * DAY_MS;
    }

    async log(guild, action, actor, targetIds, details) {
        await AuditLogService.log({
            guildId: guild.id, action, actorId: actor?.id || null, actorTag: actor?.tag || actor?.user?.username || null,
            targetIds, source: actor?.source || 'discord', details
        }).catch(error => console.error('PersonalRoles: audit log failed:', error.message || error));
    }

    /** Take a price (a free one when the administrator set it to 0). */
    async charge(guildId, member, price, cause) {
        if (price <= 0) {
            const account = await EconomyService.get(guildId, member.id);
            return { ok: true, account: { money: account?.money || 0 } };
        }
        return EconomyService.move(guildId, member, -price, { kind: 'personal_role', cause });
    }

    /** The owner's role, or a refusal. */
    async owned(guild, member, roleId) {
        const doc = await this.get(guild.id, roleId);
        if (!doc) return { ok: false, code: 'not_personal' };
        if (doc.ownerId !== member.id) return { ok: false, code: 'not_owner' };
        const role = guild.roles.cache.get(doc.roleId);
        if (!role) return { ok: false, code: 'role_gone' };
        return { ok: true, doc, role };
    }

    /** Check the look of a role: name, colour, icon (attachment or emoji). */
    validateLook(guild, { name, color, icon, emoji }, partial = false) {
        const look = {};
        if (name !== undefined && name !== null) {
            const text = String(name).trim().replace(/\s+/g, ' ');
            if (!text || text.length > 50) return { ok: false, code: 'invalid_name' };
            if (/@(everyone|here)|discord\.gg/i.test(text)) return { ok: false, code: 'invalid_name' };
            look.name = text;
        } else if (!partial) {
            return { ok: false, code: 'invalid_name' };
        }
        if (color !== undefined && color !== null) {
            const parsed = parseColor(color);
            if (parsed === null) return { ok: false, code: 'invalid_color' };
            look.color = parsed;
        }
        if (icon || emoji) {
            if (!guild.features?.includes('ROLE_ICONS')) return { ok: false, code: 'icons_unavailable' };
            if (icon) {
                if (!ICON_TYPES.has(icon.contentType) || icon.size > MAX_ICON_BYTES) return { ok: false, code: 'invalid_icon' };
                look.icon = icon.url;
                look.unicodeEmoji = null;
            } else {
                if (!isUnicodeEmoji(emoji)) return { ok: false, code: 'invalid_emoji' };
                look.unicodeEmoji = String(emoji).trim();
                look.icon = null;
            }
        }
        return { ok: true, look };
    }

    // ---- owner actions ----

    /** Rent a new role: pay, create it right above the anchor, wear it. */
    async create(guild, member, input) {
        const settings = await this.settings(guild.id);
        if (!settings.enabled) return { ok: false, code: 'roles_disabled' };
        const anchor = guild.roles.cache.get(settings.anchorRoleId);
        const botTop = guild.members.me?.roles.highest.position ?? 0;
        if (!anchor || anchor.position + 1 >= botTop) return { ok: false, code: 'anchor_invalid' };
        const checked = this.validateLook(guild, input);
        if (!checked.ok) return checked;
        const active = (await this.list(guild.id)).filter(doc => doc.ownerId === member.id);
        if (active.length >= settings.maxActive) return { ok: false, code: 'too_many_roles', limit: settings.maxActive };

        const paid = await this.charge(guild.id, member, settings.createPrice, `Создание личной роли «${checked.look.name}»`);
        if (!paid.ok) return { ...paid, price: settings.createPrice };
        let role;
        try {
            role = await guild.roles.create({
                name: checked.look.name,
                color: checked.look.color ?? 0,
                icon: checked.look.icon || undefined,
                unicodeEmoji: checked.look.unicodeEmoji || undefined,
                permissions: [],
                mentionable: false,
                hoist: false,
                position: anchor.position + 1,
                reason: `Личная роль ${member.user?.username || member.id}`
            });
            await member.roles.add(role, 'Личная роль');
        } catch (error) {
            if (role) await role.delete('Не удалось выдать личную роль').catch(() => {});
            if (settings.createPrice > 0) await EconomyService.move(guild.id, member, settings.createPrice, { kind: 'refund', cause: 'Возврат: личная роль не создана' });
            console.error('PersonalRoles: create failed:', error.message || error);
            return { ok: false, code: 'discord_error' };
        }
        const now = Date.now();
        const doc = await this.save({
            id: role.id, guildId: guild.id, roleId: role.id, ownerId: member.id,
            ownerWears: true, price: null, buyers: [],
            expiresAt: new Date(now + this.periodMs(settings)).toISOString(),
            remindedAt: null, createdAt: new Date(now).toISOString()
        });
        await this.log(guild, 'personal_role.created', member, [member.id], { roleName: role.name, price: settings.createPrice });
        return { ok: true, doc, role, balance: paid.account.money };
    }

    /** Pay for more time, `periods` × the period, up to a year ahead. */
    async extend(guild, member, roleId, periods = 1) {
        const settings = await this.settings(guild.id);
        const found = await this.owned(guild, member, roleId);
        if (!found.ok) return found;
        if (!Number.isInteger(periods) || periods < 1 || periods > 12) return { ok: false, code: 'invalid_periods' };
        const from = Math.max(Date.now(), Date.parse(found.doc.expiresAt));
        const until = from + periods * this.periodMs(settings);
        if (until - Date.now() > MAX_PREPAID_DAYS * DAY_MS) return { ok: false, code: 'too_far' };
        const cost = periods * settings.rentPrice;
        const paid = await this.charge(guild.id, member, cost, `Продление личной роли «${found.role.name}»`);
        if (!paid.ok) return { ...paid, price: cost };
        found.doc.expiresAt = new Date(until).toISOString();
        found.doc.remindedAt = null;
        await this.save(found.doc);
        await this.log(guild, 'personal_role.extended', member, [member.id], { roleName: found.role.name, price: cost });
        return { ok: true, doc: found.doc, role: found.role, cost, balance: paid.account.money };
    }

    async edit(guild, member, roleId, input) {
        const found = await this.owned(guild, member, roleId);
        if (!found.ok) return found;
        const checked = this.validateLook(guild, input, true);
        if (!checked.ok) return checked;
        if (Object.keys(checked.look).length === 0) return { ok: false, code: 'nothing_to_change' };
        try {
            await found.role.edit({ ...checked.look, reason: 'Личная роль: изменение владельцем' });
        } catch (error) {
            console.error('PersonalRoles: edit failed:', error.message || error);
            return { ok: false, code: 'discord_error' };
        }
        return { ok: true, role: found.role };
    }

    /** Put on sale for `price`, or take off sale (price null / 0). */
    async setPrice(guild, member, roleId, price) {
        const found = await this.owned(guild, member, roleId);
        if (!found.ok) return found;
        if (price && (!Number.isInteger(price) || price < 1 || price > MAX_PRICE)) return { ok: false, code: 'invalid_price' };
        found.doc.price = price || null;
        await this.save(found.doc);
        return { ok: true, doc: found.doc, role: found.role };
    }

    /** The owner puts their role on or takes it off (it stays theirs either way). */
    async wear(guild, member, roleId, on) {
        const found = await this.owned(guild, member, roleId);
        if (!found.ok) return found;
        try {
            if (on) await member.roles.add(found.role, 'Личная роль: владелец надел');
            else await member.roles.remove(found.role, 'Личная роль: владелец снял');
        } catch {
            return { ok: false, code: 'discord_error' };
        }
        found.doc.ownerWears = Boolean(on);
        await this.save(found.doc);
        return { ok: true, doc: found.doc, role: found.role };
    }

    /** Delete for good (the owner, or an administrator from the app). No refund. */
    async destroy(guild, roleId, actor, reason) {
        const doc = await this.get(guild.id, roleId);
        if (!doc) return { ok: false, code: 'not_personal' };
        if (actor.source !== 'panel' && doc.ownerId !== actor.id) return { ok: false, code: 'not_owner' };
        const role = guild.roles.cache.get(doc.roleId);
        if (role) {
            try {
                await role.delete(reason || 'Личная роль удалена');
            } catch (error) {
                console.error('PersonalRoles: delete failed:', error.message || error);
                return { ok: false, code: 'discord_error' };
            }
        }
        await this.remove(guild.id, roleId);
        await this.log(guild, 'personal_role.deleted', actor, [doc.ownerId], { roleName: role?.name || null });
        return { ok: true, roleName: role?.name || null, doc };
    }

    /** Free extra time from the app (a compensation, say). */
    async grant(guild, roleId, days, actor) {
        const doc = await this.get(guild.id, roleId);
        if (!doc) return { ok: false, code: 'not_personal' };
        if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, code: 'invalid_days' };
        doc.expiresAt = new Date(Math.max(Date.now(), Date.parse(doc.expiresAt)) + days * DAY_MS).toISOString();
        doc.remindedAt = null;
        await this.save(doc);
        await this.log(guild, 'personal_role.granted', actor, [doc.ownerId], { roleName: guild.roles.cache.get(doc.roleId)?.name || null, days });
        return { ok: true, doc };
    }

    // ---- buying ----

    async forSale(guild) {
        return (await this.list(guild.id)).filter(doc => doc.price && guild.roles.cache.has(doc.roleId));
    }

    /** Buy (or buy more time on) someone's role: the price to the owner minus 5%. */
    async buy(guild, member, roleId) {
        const settings = await this.settings(guild.id);
        if (!settings.enabled) return { ok: false, code: 'roles_disabled' };
        const doc = await this.get(guild.id, roleId);
        const role = doc && guild.roles.cache.get(doc.roleId);
        if (!doc || !role) return { ok: false, code: 'not_personal' };
        if (!doc.price) return { ok: false, code: 'not_for_sale' };
        if (doc.ownerId === member.id) return { ok: false, code: 'own_role' };
        const owner = guild.members.cache.get(doc.ownerId) || await guild.members.fetch(doc.ownerId).catch(() => null);
        if (!owner) return { ok: false, code: 'owner_gone' };

        const price = doc.price;
        const paid = await EconomyService.transfer(guild.id, member, owner, price, {
            fee: price - Math.floor(price * SELLER_SHARE),
            kind: 'personal_role_sale',
            outCause: `Покупка роли «${role.name}»`,
            inCause: `Продажа личной роли «${role.name}»`
        });
        if (!paid.ok) return { ...paid, price };
        try {
            await member.roles.add(role, 'Личная роль куплена');
        } catch (error) {
            // The buyer gets the whole price back; the owner returns their share
            await EconomyService.move(guild.id, owner, -Math.floor(price * SELLER_SHARE), { kind: 'refund', cause: `Возврат за роль «${role.name}»` }).catch(() => {});
            await EconomyService.move(guild.id, member, price, { kind: 'refund', cause: `Возврат за роль «${role.name}»` }).catch(() => {});
            console.error('PersonalRoles: giving a bought role failed:', error.message || error);
            return { ok: false, code: 'discord_error' };
        }
        const current = (doc.buyers || []).find(b => b.userId === member.id);
        const from = Math.max(Date.now(), current ? Date.parse(current.expiresAt) : 0);
        const expiresAt = new Date(from + this.periodMs(settings)).toISOString();
        doc.buyers = [...(doc.buyers || []).filter(b => b.userId !== member.id), { userId: member.id, expiresAt }];
        await this.save(doc);
        await this.log(guild, 'personal_role.bought', member, [member.id, doc.ownerId], { roleName: role.name, price });
        return { ok: true, doc, role, price, expiresAt, balance: paid.from.money };
    }

    // ---- time ----

    async notify(guild, userId, content) {
        const member = guild.members.cache.get(userId);
        await member?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
    }

    /**
     * Every minute: buyers whose term ended lose the role, owners get a reminder 3
     * days before the end, and expired roles are deleted.
     */
    async processDue(client, now = Date.now()) {
        let changed = 0;
        for (const doc of await this.listAll()) {
            const guild = client.guilds.cache.get(doc.guildId);
            if (!guild) continue;
            try {
                const role = guild.roles.cache.get(doc.roleId);
                if (!role) {
                    // Deleted in Discord by hand: forget it
                    await this.remove(doc.guildId, doc.id);
                    changed++;
                    continue;
                }
                if (doc.ownerLeftAt && now - Date.parse(doc.ownerLeftAt) > OWNER_RETURN_MS) {
                    // The owner left and did not come back in time
                    await role.delete('Владелец личной роли покинул сервер').catch(error => { if (error.code !== 10011) throw error; });
                    await this.remove(doc.guildId, doc.id);
                    await this.log(guild, 'personal_role.deleted', null, [], { roleName: role.name, reason: 'owner_left' });
                    changed++;
                    continue;
                }
                if (Date.parse(doc.expiresAt) <= now) {
                    await role.delete('Аренда личной роли закончилась').catch(error => { if (error.code !== 10011) throw error; });
                    await this.remove(doc.guildId, doc.id);
                    await this.log(guild, 'personal_role.expired', null, [doc.ownerId], { roleName: role.name });
                    await this.notify(guild, doc.ownerId, `Аренда вашей личной роли «${role.name}» на сервере ${guild.name} закончилась, роль удалена.`);
                    changed++;
                    continue;
                }
                let dirty = false;
                const keep = [];
                for (const buyer of doc.buyers || []) {
                    if (Date.parse(buyer.expiresAt) > now) { keep.push(buyer); continue; }
                    const member = guild.members.cache.get(buyer.userId);
                    if (member?.roles.cache.has(role.id)) await member.roles.remove(role, 'Срок купленной роли закончился').catch(() => {});
                    await this.notify(guild, buyer.userId, `Срок роли «${role.name}» на сервере ${guild.name} закончился. Купить снова: /shop.`);
                    dirty = true;
                }
                if (dirty) doc.buyers = keep;
                if (!doc.remindedAt && Date.parse(doc.expiresAt) - now <= REMIND_BEFORE_MS) {
                    doc.remindedAt = new Date(now).toISOString();
                    dirty = true;
                    const settings = await this.settings(guild.id);
                    await this.notify(guild, doc.ownerId,
                        `Аренда вашей личной роли «${role.name}» на сервере ${guild.name} закончится ${stamp(doc.expiresAt, 'R')}. `
                        + `Продлить на ${settings.periodDays} дней за ${number(settings.rentPrice)} монет: /myrole extend.`);
                }
                if (dirty) {
                    await this.save(doc);
                    changed++;
                }
            } catch (error) {
                console.error(`PersonalRoles: due check for ${doc.id} failed:`, error.message || error);
            }
        }
        return changed;
    }

    /**
     * Someone left: as a buyer they drop off every role at once; as an owner their id
     * gives way to the anonymous return key and the role comes off sale.
     */
    async memberLeft(guildId, userId, now = Date.now()) {
        for (const doc of await this.list(guildId)) {
            const buyers = (doc.buyers || []).filter(b => b.userId !== userId);
            const owns = doc.ownerId === userId;
            if (!owns && buyers.length === (doc.buyers || []).length) continue;
            doc.buyers = buyers;
            if (owns) Object.assign(doc, { ownerId: EconomyService.returnKey(guildId, userId), price: null, ownerLeftAt: new Date(now).toISOString() });
            await this.save(doc);
        }
    }

    /** The owner is back within 3 days: the roles are theirs again (and worn, if they wore them). */
    async memberReturned(guild, member, now = Date.now()) {
        const key = EconomyService.returnKey(guild.id, member.id);
        for (const doc of (await this.list(guild.id)).filter(d => d.ownerId === key)) {
            if (now - Date.parse(doc.ownerLeftAt) > OWNER_RETURN_MS) continue;
            Object.assign(doc, { ownerId: member.id, ownerLeftAt: null });
            await this.save(doc);
            const role = guild.roles.cache.get(doc.roleId);
            if (role && doc.ownerWears !== false) await member.roles.add(role, 'Личная роль: владелец вернулся').catch(() => {});
        }
    }
}

module.exports = new PersonalRoleService();
module.exports.parseColor = parseColor;
module.exports.isUnicodeEmoji = isUnicodeEmoji;
module.exports.SELLER_SHARE = SELLER_SHARE;
