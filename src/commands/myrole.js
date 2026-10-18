const { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const PersonalRoleService = require('../modules/economy/PersonalRoleService');
const { describe, number } = require('../modules/economy/messages');

const roleOption = option => option.setName('роль').setDescription('Ваша личная роль').setRequired(true);
const lookOptions = (sub, required) => sub
    .addStringOption(option => option.setName('название').setDescription('До 50 символов').setMaxLength(50).setRequired(required))
    .addStringOption(option => option.setName('цвет').setDescription('Например #ff7a1a'))
    .addAttachmentOption(option => option.setName('иконка').setDescription('Картинка PNG/JPG/WEBP до 256 КБ'))
    .addStringOption(option => option.setName('эмодзи').setDescription('Эмодзи вместо картинки'));

const until = iso => `<t:${Math.floor(Date.parse(iso) / 1000)}:D>`;

function lookInput(options) {
    const icon = options.getAttachment('иконка');
    return {
        name: options.getString('название') ?? undefined,
        color: options.getString('цвет') ?? undefined,
        icon: icon ? { url: icon.url, contentType: icon.contentType, size: icon.size } : undefined,
        emoji: options.getString('эмодзи') ?? undefined
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('myrole')
        .setDescription('Личная роль: создать, продлить, изменить, продать')
        .setContexts(InteractionContextType.Guild)
        .addSubcommand(sub => lookOptions(sub.setName('create').setDescription('Создать личную роль (аренда)'), true))
        .addSubcommand(sub => sub.setName('list').setDescription('Мои личные роли и сроки'))
        .addSubcommand(sub => sub.setName('extend').setDescription('Продлить аренду')
            .addRoleOption(roleOption)
            .addIntegerOption(option => option.setName('сроки').setDescription('На сколько сроков вперёд (по умолчанию 1)').setMinValue(1).setMaxValue(12)))
        .addSubcommand(sub => lookOptions(sub.setName('edit').setDescription('Изменить название, цвет или иконку').addRoleOption(roleOption), false))
        .addSubcommand(sub => sub.setName('sell').setDescription('Выставить на продажу (цена 0 — снять с продажи)')
            .addRoleOption(roleOption)
            .addIntegerOption(option => option.setName('цена').setDescription('Монет за срок').setRequired(true).setMinValue(0).setMaxValue(1_000_000)))
        .addSubcommand(sub => sub.setName('wear').setDescription('Надеть или снять свою роль (она остаётся вашей)')
            .addRoleOption(roleOption)
            .addBooleanOption(option => option.setName('носить').setDescription('Носить роль').setRequired(true)))
        .addSubcommand(sub => sub.setName('delete').setDescription('Удалить роль насовсем (без возврата монет)').addRoleOption(roleOption)),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;
        const member = interaction.member;
        const sub = interaction.options.getSubcommand();
        const roleId = interaction.options.getRole('роль')?.id;
        const settings = await PersonalRoleService.settings(guild.id);
        let result;
        let text;

        if (sub === 'list') {
            const mine = (await PersonalRoleService.list(guild.id)).filter(doc => doc.ownerId === member.id);
            const embed = new EmbedBuilder().setColor(0x2ec4ff).setTitle('Мои личные роли');
            embed.setDescription(mine.length === 0
                ? `Личных ролей нет. Создать: /myrole create — ${number(settings.createPrice)} монет за ${settings.periodDays} дней.`
                : mine.map(doc => `<@&${doc.roleId}> — до ${until(doc.expiresAt)}`
                    + `${doc.price ? ` · продаётся за ${number(doc.price)}` : ''}`
                    + `${doc.buyers?.length ? ` · купили: ${doc.buyers.length}` : ''}`
                    + `${doc.ownerWears ? '' : ' · не надета'}`).join('\n')
                    + `\n\nПродление: ${number(settings.rentPrice)} монет за ${settings.periodDays} дней — /myrole extend.`);
            await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
            return;
        }
        if (sub === 'create') {
            result = await PersonalRoleService.create(guild, member, lookInput(interaction.options));
            if (result.ok) text = `Роль <@&${result.role.id}> создана и надета. Действует до ${until(result.doc.expiresAt)}. Баланс: ${number(result.balance)}.`;
        } else if (sub === 'extend') {
            result = await PersonalRoleService.extend(guild, member, roleId, interaction.options.getInteger('сроки') || 1);
            if (result.ok) text = `Продлено за ${number(result.cost)} монет: <@&${result.role.id}> действует до ${until(result.doc.expiresAt)}. Баланс: ${number(result.balance)}.`;
        } else if (sub === 'edit') {
            result = await PersonalRoleService.edit(guild, member, roleId, lookInput(interaction.options));
            if (result.ok) text = `Готово: <@&${result.role.id}> изменена.`;
        } else if (sub === 'sell') {
            const price = interaction.options.getInteger('цена');
            result = await PersonalRoleService.setPrice(guild, member, roleId, price);
            if (result.ok) text = price
                ? `<@&${result.role.id}> продаётся за ${number(price)} монет (вам — ${number(Math.floor(price * PersonalRoleService.SELLER_SHARE))}). Её видно в /shop.`
                : `<@&${result.role.id}> снята с продажи.`;
        } else if (sub === 'wear') {
            const on = interaction.options.getBoolean('носить');
            result = await PersonalRoleService.wear(guild, member, roleId, on);
            if (result.ok) text = on ? `<@&${result.role.id}> надета.` : `<@&${result.role.id}> снята с вас, но остаётся вашей до ${until(result.doc.expiresAt)}.`;
        } else if (sub === 'delete') {
            result = await PersonalRoleService.destroy(guild, roleId, { id: member.id, tag: member.user.username, source: 'discord' });
            if (result.ok) text = `Роль «${result.roleName}» удалена.`;
        }
        await interaction.editReply({ content: result.ok ? text : describe(result), allowedMentions: { parse: [] } });
    }
};
