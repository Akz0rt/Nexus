const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');
const { roleProblem } = require('../../services/RoleService');

const MENUS_CONTAINER = 'role_menus';
const MAX_ROLES = 25; // 5 rows × 5 buttons
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/** Roles members must never hand themselves through a button. */
const DANGEROUS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.MuteMembers
];

function isDangerous(role) {
    return DANGEROUS.some(flag => role.permissions?.has?.(flag));
}

/** The menu message: text + one button per role. */
function buildMenuMessage(menu, guild) {
    const embed = new EmbedBuilder().setColor(0x2ec4ff).setTitle(menu.title);
    const hint = menu.mode === 'single' ? 'Можно выбрать одну роль.' : 'Можно выбрать несколько.';
    embed.setDescription(`${menu.description ? `${menu.description}\n\n` : ''}*${hint} Повторное нажатие снимает роль.*`);
    const buttons = menu.roleIds
        .map(roleId => guild.roles.cache.get(roleId))
        .filter(Boolean)
        .map(role => new ButtonBuilder()
            .setCustomId(`rolemenu:${menu.id}:${role.id}`)
            .setLabel(role.name.slice(0, 80))
            .setStyle(ButtonStyle.Secondary));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/**
 * Self-service role menus ("роли по интересам"): a bot message with a button per
 * role; members give and take those roles themselves.
 */
class RoleMenuService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        this.client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({ id: MENUS_CONTAINER, partitionKey: { paths: ['/guildId'] } });
        this.container = database.container(MENUS_CONTAINER);
        this.initialized = true;
    }

    async get(guildId, menuId) {
        await this.initialize();
        try {
            const { resource } = await this.container.item(String(menuId), guildId).read();
            return resource || null;
        } catch (error) {
            if (error.code === 404) return null;
            throw error;
        }
    }

    async list(guildId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId ORDER BY c.createdAt DESC',
            parameters: [{ name: '@guildId', value: guildId }]
        }, { partitionKey: guildId }).fetchAll();
        return resources;
    }

    async save(menu) {
        await this.initialize();
        menu.updatedAt = new Date().toISOString();
        await this.container.items.upsert(menu);
        return menu;
    }

    async remove(guildId, menuId) {
        await this.initialize();
        await this.container.item(String(menuId), guildId).delete().catch(error => { if (error.code !== 404) throw error; });
    }

    async fetchActor(guild, actor) {
        const member = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
        return member?.permissions.has(PermissionFlagsBits.ManageRoles) ? member : null;
    }

    /** @returns {{ ok: true, fields } | { ok: false, code, field, roleName? }} */
    validate(guild, actorMember, body) {
        const fail = (field, code, extra = {}) => ({ ok: false, field, code, ...extra });
        const title = String(body.title || '').trim().slice(0, 100);
        if (!title) return fail('title', 'invalid_title');
        const description = String(body.description || '').trim().slice(0, 1500);
        const channel = guild.channels.cache.get(String(body.channelId || ''));
        if (!channel || !TEXT_TYPES.has(channel.type)) return fail('channelId', 'channel_not_found');
        const perms = channel.permissionsFor(guild.members.me);
        if (![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].every(f => perms?.has(f))) {
            return fail('channelId', 'bot_cannot_channel');
        }
        const roleIds = [...new Set((Array.isArray(body.roleIds) ? body.roleIds : []).map(String))];
        if (roleIds.length === 0 || roleIds.length > MAX_ROLES) return fail('roleIds', 'invalid_roles');
        for (const roleId of roleIds) {
            const role = guild.roles.cache.get(roleId);
            const problem = roleProblem(guild, actorMember, role);
            if (problem) return fail('roleIds', problem, { roleName: role?.name || null });
            if (isDangerous(role)) return fail('roleIds', 'role_dangerous', { roleName: role.name });
        }
        return { ok: true, fields: { title, description, channelId: channel.id, roleIds, mode: body.mode === 'single' ? 'single' : 'multi' } };
    }

    async log(menu, action, actor, source) {
        await AuditLogService.log({
            guildId: menu.guildId,
            action,
            actorId: actor.id,
            actorTag: actor.tag,
            source,
            details: { menuId: menu.id, menuTitle: menu.title, channelId: menu.channelId, roleCount: menu.roleIds.length }
        });
    }

    async create(guild, body, actor, source) {
        const actorMember = await this.fetchActor(guild, actor);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const check = this.validate(guild, actorMember, body);
        if (!check.ok) return check;
        const menu = { id: crypto.randomUUID(), guildId: guild.id, ...check.fields, messageId: null, createdBy: actor.id, createdAt: new Date().toISOString() };
        const message = await guild.channels.cache.get(menu.channelId).send(buildMenuMessage(menu, guild));
        menu.messageId = message.id;
        await this.save(menu);
        await this.log(menu, 'rolemenu.created', actor, source);
        return { ok: true, menu };
    }

    async update(guild, menuId, body, actor, source) {
        const actorMember = await this.fetchActor(guild, actor);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const menu = await this.get(guild.id, menuId);
        if (!menu) return { ok: false, code: 'menu_not_found' };
        const check = this.validate(guild, actorMember, body);
        if (!check.ok) return check;
        const oldChannel = guild.channels.cache.get(menu.channelId);
        const oldMessageId = menu.messageId;
        Object.assign(menu, check.fields);
        const channel = guild.channels.cache.get(menu.channelId);
        const existing = oldChannel?.id === channel.id && oldMessageId
            ? await channel.messages.fetch(oldMessageId).catch(() => null)
            : null;
        if (existing) {
            await existing.edit(buildMenuMessage(menu, guild));
        } else {
            if (oldMessageId) await oldChannel?.messages.delete(oldMessageId).catch(() => {});
            menu.messageId = (await channel.send(buildMenuMessage(menu, guild))).id;
        }
        await this.save(menu);
        await this.log(menu, 'rolemenu.updated', actor, source);
        return { ok: true, menu };
    }

    async delete(guild, menuId, actor, source) {
        const actorMember = await this.fetchActor(guild, actor);
        if (!actorMember) return { ok: false, code: 'forbidden' };
        const menu = await this.get(guild.id, menuId);
        if (!menu) return { ok: false, code: 'menu_not_found' };
        if (menu.messageId) await guild.channels.cache.get(menu.channelId)?.messages.delete(menu.messageId).catch(() => {});
        await this.remove(guild.id, menu.id);
        await this.log(menu, 'rolemenu.deleted', actor, source);
        return { ok: true };
    }

    /**
     * A member pressed a role button: give it, or take it if they have it.
     * In a single-choice menu the menu's other roles go away.
     * @returns {{ ok: true, added: boolean, roleName, removed: string[] } | { ok: false, code }}
     */
    async toggle(guild, member, menuId, roleId) {
        const menu = await this.get(guild.id, menuId);
        if (!menu || !menu.roleIds.includes(roleId)) return { ok: false, code: 'menu_not_found' };
        const role = guild.roles.cache.get(roleId);
        if (!role) return { ok: false, code: 'role_not_found' };
        if (!role.editable || role.managed) return { ok: false, code: 'bot_cannot_role' };
        if (isDangerous(role)) return { ok: false, code: 'role_dangerous' };

        const reason = `Меню ролей «${menu.title}»`;
        if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, reason);
            return { ok: true, added: false, roleName: role.name, removed: [] };
        }
        const others = menu.mode === 'single'
            ? menu.roleIds.filter(id => id !== role.id && member.roles.cache.has(id))
            : [];
        if (others.length > 0) {
            // One request: drop the other choices, add this one
            const next = [...member.roles.cache.keys()].filter(id => !others.includes(id));
            await member.roles.set([...next, role.id], reason);
        } else {
            await member.roles.add(role, reason);
        }
        return { ok: true, added: true, roleName: role.name, removed: others.map(id => guild.roles.cache.get(id)?.name).filter(Boolean) };
    }
}

module.exports = new RoleMenuService();
module.exports.buildMenuMessage = buildMenuMessage;
module.exports.isDangerous = isDangerous;
