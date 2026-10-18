// One-time import of the old economy bot's personal roles that still exist in Discord.
//
//   node scripts/import-personal-roles.js           dry run: what would be imported
//   node scripts/import-personal-roles.js --write   save them and set the anchor role
//
// The owner is whoever created the role in the old bot's history ("Создание личной роли <@&id>").
// Every imported role gets a full rental period from today; whoever wears it besides the
// owner keeps it for as long as the role exists. New personal roles will be created right
// above the role just below the lowest imported one (the anchor), keeping them in one block.
// Options: --file <dump.sql> (default data/economiusers.sql), --guild <id> (default GUILD_ID).

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('../src/config');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const PersonalRoleService = require('../src/modules/economy/PersonalRoleService');
const { parseInserts } = require('../src/modules/economy/sqlDump');
const { legacyPersonalRoles } = require('../src/modules/economy/legacyImport');

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index > -1 ? process.argv[index + 1] : fallback;
}

const write = process.argv.includes('--write');
const file = path.resolve(option('--file', path.join(__dirname, '..', 'data', 'economiusers.sql')));
const guildId = option('--guild', config.guildId);

async function main() {
    if (!guildId) throw new Error('No guild: set GUILD_ID or pass --guild');
    const rest = new REST({ version: '10' }).setToken(config.token);
    const guild = await rest.get(Routes.guild(guildId));
    const roles = new Map(guild.roles.map(role => [role.id, role]));
    const members = [];
    let after = '0';
    for (;;) {
        const page = await rest.get(Routes.guildMembers(guildId), { query: new URLSearchParams({ limit: '1000', after }) });
        members.push(...page);
        if (page.length < 1000) break;
        after = page[page.length - 1].user.id;
    }
    const memberIds = new Set(members.map(m => m.user.id));
    const holdersOf = roleId => members.filter(m => m.roles.includes(roleId)).map(m => m.user.id);

    const settings = (await GuildSettingsService.get(guildId)).economy.personalRoles;
    const rows = parseInserts(fs.readFileSync(file, 'utf8'), 'economiusers');
    const docs = legacyPersonalRoles(rows, guildId, { roles, holdersOf, memberIds, periodDays: settings.periodDays });

    const name = id => members.find(m => m.user.id === id)?.nick || members.find(m => m.user.id === id)?.user.global_name || id;
    console.log(`Personal roles to import: ${docs.length}`);
    for (const doc of docs) {
        console.log(`  ${roles.get(doc.roleId).name} — owner ${name(doc.ownerId)}${doc.ownerWears ? '' : ' (not wearing)'}, holders (kept while the role exists): ${doc.buyers.map(b => name(b.userId)).join(', ') || 'none'}, until ${doc.expiresAt.slice(0, 10)}`);
    }
    const lowest = Math.min(...docs.map(doc => roles.get(doc.roleId).position));
    const anchor = [...roles.values()].find(role => role.position === lowest - 1);
    console.log(`Anchor (new roles go right above it): ${anchor ? `${anchor.name} (${anchor.id})` : 'none found'}`);

    if (!write) {
        console.log('\nDry run: nothing written. Add --write to import.');
        return;
    }
    for (const doc of docs) await PersonalRoleService.save(doc);
    if (anchor) {
        const raw = (await GuildSettingsService.readDoc(guildId)) || {};
        const economy = raw.economy || {};
        await GuildSettingsService.update(guildId, { economy: { ...economy, personalRoles: { ...(economy.personalRoles || {}), anchorRoleId: anchor.id } } });
    }
    console.log(`Saved ${docs.length} personal roles${anchor ? ' and the anchor' : ''}. Turn personal roles on in the app: Экономика → Настройки.`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
