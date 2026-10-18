const { MessageFlags } = require('discord.js');
const RoleMenuService = require('./RoleMenuService');

const SNOWFLAKE_RE = /^\d{17,20}$/;
const MISSING_PERMISSIONS = 50013;

const REFUSALS = {
    menu_not_found: 'Это меню больше не работает — его удалили или изменили.',
    role_not_found: 'Этой роли больше нет.',
    bot_cannot_role: 'Бот не может выдавать эту роль — напишите модераторам.',
    role_dangerous: 'Эту роль нельзя выдать себе.'
};

// A role button: rolemenu:<menuId>:<roleId>
async function handleInteraction(interaction) {
    const [, menuId, roleId] = String(interaction.customId).split(':');
    if (!interaction.isButton() || !interaction.guild || !menuId || !SNOWFLAKE_RE.test(roleId || '')) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.member?.roles?.cache
        ? interaction.member
        : await interaction.guild.members.fetch(interaction.user.id);
    let result;
    try {
        result = await RoleMenuService.toggle(interaction.guild, member, menuId, roleId);
    } catch (error) {
        if (error.code !== MISSING_PERMISSIONS) throw error;
        result = { ok: false, code: 'bot_cannot_role' };
    }
    if (!result.ok) {
        await interaction.editReply(REFUSALS[result.code] || 'Не получилось.');
        return;
    }
    const removed = result.removed.length ? ` Снята: ${result.removed.join(', ')}.` : '';
    await interaction.editReply(result.added ? `Роль «${result.roleName}» выдана.${removed}` : `Роль «${result.roleName}» снята.`);
}

module.exports = {
    name: 'rolemenus',
    interactionPrefix: 'rolemenu',
    handleInteraction,
    register() {}
};
