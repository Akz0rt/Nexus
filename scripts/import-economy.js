// One-time import of the old economy bot's data (MySQL dump) into Cosmos.
//
//   node scripts/import-economy.js                 dry run: the report, nothing is written
//   node scripts/import-economy.js --write         write accounts and their history
//   node scripts/import-economy.js --write --force overwrite accounts the new bot already credited
//
// Options: --file <dump.sql> (default data/economiusers.sql), --guild <id> (default GUILD_ID).
// Uses DISCORD_TOKEN only for REST lookups of names; the bot does not log in, so nothing
// is announced and no rewards or roles are handed out.

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('../src/config');
const EconomyService = require('../src/modules/economy/EconomyService');
const { parseInserts } = require('../src/modules/economy/sqlDump');
const { buildImport } = require('../src/modules/economy/legacyImport');

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index > -1 ? process.argv[index + 1] : fallback;
}

const write = process.argv.includes('--write');
const force = process.argv.includes('--force');
const file = path.resolve(option('--file', path.join(__dirname, '..', 'data', 'economiusers.sql')));
const guildId = option('--guild', config.guildId);
const number = n => Number(n).toLocaleString('ru-RU');

/** Names of everyone: from the server's member list, and user profiles for those who left. */
async function fetchNames(rest, userIds) {
    const names = new Map();
    let after = '0';
    for (;;) {
        const page = await rest.get(Routes.guildMembers(guildId), { query: new URLSearchParams({ limit: '1000', after }) });
        for (const m of page) {
            names.set(m.user.id, { username: m.user.username, displayName: m.nick || m.user.global_name || m.user.username, member: true });
        }
        if (page.length < 1000) break;
        after = page[page.length - 1].user.id;
    }
    for (const userId of userIds) {
        if (names.has(userId)) continue;
        const user = await rest.get(Routes.user(userId)).catch(() => null);
        if (user) names.set(userId, { username: user.username, displayName: user.global_name || user.username, member: false });
    }
    return names;
}

async function main() {
    if (!guildId) throw new Error('No guild: set GUILD_ID or pass --guild');
    const rows = parseInserts(fs.readFileSync(file, 'utf8'), 'economiusers');
    const rest = new REST({ version: '10' }).setToken(config.token);
    const names = await fetchNames(rest, rows.map(row => String(row.id)));
    const present = new Set([...names].filter(([, name]) => name.member).map(([id]) => id));
    const { accounts, transactions, skipped, mismatches } = buildImport(rows, guildId, new Date().toISOString(), present);
    // Names only for those still here: someone who left is kept without one
    for (const account of accounts) {
        const name = names.get(account.userId);
        if (name?.member) Object.assign(account, { username: name.username, displayName: name.displayName });
    }

    const label = a => (a.prestige ? `${a.level} ★${a.prestige}` : String(a.level));
    const nameOf = a => a.displayName || names.get(a.userId)?.displayName || a.userId;
    console.log(`Dump: ${file}`);
    console.log(`Server: ${guildId}`);
    console.log(`Rows: ${rows.length}, accounts: ${accounts.length}${skipped.length ? `, skipped (bad id): ${skipped.join(', ')}` : ''}`);
    console.log(`Coins in total: ${number(accounts.reduce((sum, a) => sum + a.money, 0))}`);
    console.log(`History entries: ${transactions.length}`);
    const left = accounts.filter(a => a.leftAt);
    console.log(`Not on the server any more: ${left.length} (kept without a name, ${left.reduce((sum, a) => sum + a.money, 0).toLocaleString('ru-RU')} coins; deleted in ${EconomyService.LEFT_RETENTION_DAYS} days unless they come back)`);
    console.log('\nTop 10 by level:');
    [...accounts].sort((a, b) => b.totalExp - a.totalExp).slice(0, 10).forEach((a, i) =>
        console.log(`  ${i + 1}. ${nameOf(a)} — level ${label(a)} (was ${a.legacy.level}), ${number(a.money)} coins`));
    const moved = accounts.filter(a => a.level !== a.legacy.level);
    console.log(`\nLevel changed by the new cap (50 + prestige): ${moved.length}`);
    moved.forEach(a => console.log(`  ${nameOf(a)}: ${a.legacy.level} → ${label(a)}`));
    console.log(`\nStored progress differs from voice+messages for ${mismatches.length} accounts (information only, the stored level is kept)`);

    await EconomyService.initialize();
    const { resources: existing } = await EconomyService.accounts.items.query({
        query: 'SELECT c.id, c.importedAt, c.updatedAt FROM c WHERE c.guildId = @guildId',
        parameters: [{ name: '@guildId', value: guildId }]
    }, { partitionKey: guildId }).fetchAll();
    const touched = existing.filter(doc => !doc.importedAt || doc.updatedAt > doc.importedAt);
    console.log(`\nAccounts already in the new bot: ${existing.length}, credited by it since: ${touched.length}`);

    if (!write) {
        console.log('\nDry run: nothing written. Add --write to import.');
        return;
    }
    if (touched.length && !force) {
        console.error(`\nRefusing to write: ${touched.length} accounts were already credited by the new bot and would be overwritten. Use --force if that is intended.`);
        process.exitCode = 1;
        return;
    }
    for (const account of accounts) await EconomyService.accounts.items.upsert(account);
    console.log(`Accounts written: ${accounts.length}`);
    let done = 0;
    for (const entry of transactions) {
        await EconomyService.transactions.items.upsert(entry);
        if (++done % 200 === 0) console.log(`  history ${done}/${transactions.length}`);
    }
    console.log(`History entries written: ${transactions.length}. Done.`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
