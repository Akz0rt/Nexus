const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');
const PersonalRoleService = require('./PersonalRoleService');
const { number } = require('./messages');

const MAX_OPTIONS = 25;

/** The shop: roles on sale and a menu to pick one (ephemeral, for the viewer). */
async function buildShop(guild, viewerId) {
    const settings = await PersonalRoleService.settings(guild.id);
    const items = (await PersonalRoleService.forSale(guild))
        .filter(doc => doc.ownerId !== viewerId)
        .sort((a, b) => a.price - b.price);
    const embed = new EmbedBuilder().setColor(0xff7a1a).setTitle('Магазин личных ролей');
    if (!settings.enabled) return { embeds: [embed.setDescription('Личные роли на этом сервере выключены.')], components: [] };
    if (items.length === 0) {
        embed.setDescription(`Сейчас ничего не продаётся.\nСвою роль можно создать: /myrole create — ${number(settings.createPrice)} монет за ${settings.periodDays} дней.`);
        return { embeds: [embed], components: [] };
    }
    const lines = items.slice(0, MAX_OPTIONS).map(doc =>
        `<@&${doc.roleId}> — **${number(doc.price)}** · владелец <@${doc.ownerId}>`);
    embed.setDescription(`${lines.join('\n')}\n\nПокупка даёт роль на ${settings.periodDays} дней. Владельцу — 95% цены.`);
    const menu = new StringSelectMenuBuilder()
        .setCustomId('eco:shop:pick')
        .setPlaceholder('Выберите роль')
        .addOptions(items.slice(0, MAX_OPTIONS).map(doc => ({
            label: (guild.roles.cache.get(doc.roleId)?.name || doc.roleId).slice(0, 100),
            description: `${number(doc.price)} монет`,
            value: doc.roleId
        })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } };
}

/** One role picked in the shop: details and the «Купить» button. */
async function buildOffer(guild, roleId) {
    const doc = await PersonalRoleService.get(guild.id, roleId);
    const role = doc && guild.roles.cache.get(doc.roleId);
    if (!doc || !role || !doc.price) return { content: 'Эта роль больше не продаётся.', embeds: [], components: [] };
    const settings = await PersonalRoleService.settings(guild.id);
    const embed = new EmbedBuilder()
        .setColor(role.color || 0x2ec4ff)
        .setTitle(role.name)
        .setDescription(`Владелец: <@${doc.ownerId}>\nЦена: **${number(doc.price)}** монет за ${settings.periodDays} дней\nРоль существует до <t:${Math.floor(Date.parse(doc.expiresAt) / 1000)}:d>, если владелец не продлит.`);
    const button = new ButtonBuilder().setCustomId(`eco:shop:buy:${doc.roleId}`).setLabel(`Купить за ${number(doc.price)}`).setStyle(ButtonStyle.Primary);
    return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

module.exports = { buildShop, buildOffer };
