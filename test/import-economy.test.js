// Standalone test (no test framework configured): run with `node test/import-economy.test.js`
// The old economy bot's dump: the tokenizer survives the JSON inside strings, and the
// import keeps levels, coins and history (normalizing the old bot's mixed signs).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseInserts } = require('../src/modules/economy/sqlDump');
const { buildImport, normalizeEntry } = require('../src/modules/economy/legacyImport');

const G = '900000000000000001';

function tokenizer() {
    const sql = `INSERT INTO \`economiusers\` (\`id\`, \`money\`, \`note\`) VALUES
('1', 5, 'it''s (a), \\'quoted\\' [{\\"x\\": 1}]'),
('2', -3, NULL);
INSERT INTO \`economiusers\` (\`id\`, \`money\`, \`note\`) VALUES
('3', 0, 'line\\nbreak');`;
    const rows = parseInserts(sql, 'economiusers');
    assert.deepStrictEqual(rows, [
        { id: '1', money: 5, note: `it's (a), 'quoted' [{"x": 1}]` },
        { id: '2', money: -3, note: null },
        { id: '3', money: 0, note: 'line\nbreak' }
    ]);
}

function entries() {
    const take = normalizeEntry(G, '1', { type: 'take', money: -3000, cause: 'Создание личной роли', time: '2024-04-13T16:01:19.541Z', balance: 17000 }, 0);
    const takePositive = normalizeEntry(G, '1', { type: 'take', money: 95, cause: 'Проиграл в дуэль', time: '2025-09-29T22:23:54.103Z', balance: 0 }, 1);
    const asString = normalizeEntry(G, '1', { type: 'take', money: '3000', cause: 'Покупка роли', time: '2026-07-04T10:13:10.682Z', balance: 7958 }, 2);
    const give = normalizeEntry(G, '1', { type: 'give', money: 100, cause: 'Повысил уровень', time: '2024-08-07T16:25:34.560Z', balance: 88 }, 3);
    assert.deepStrictEqual([take.amount, takePositive.amount, asString.amount, give.amount], [-3000, -95, -3000, 100]);
    assert.deepStrictEqual([give.kind, take.kind, give.source, give.id], ['level', 'legacy', 'import', 'import-1-3']);
}

function realDump() {
    const file = path.join(__dirname, '..', 'data', 'economiusers.sql');
    if (!fs.existsSync(file)) {
        console.log('  (data/economiusers.sql not present: real-dump checks skipped)');
        return;
    }
    const rows = parseInserts(fs.readFileSync(file, 'utf8'), 'economiusers');
    assert.strictEqual(rows.length, 248);
    const { accounts, transactions, skipped } = buildImport(rows, G, '2026-10-18T00:00:00.000Z');
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(accounts.reduce((sum, a) => sum + a.money, 0), 2351930, 'every coin carried over');
    const byId = new Map(accounts.map(a => [a.userId, a]));
    assert.deepStrictEqual(['level', 'exp', 'prestige'].map(k => byId.get('1018946095537193022')[k]), [1, 2971, 0]);
    assert.deepStrictEqual(['level', 'exp', 'prestige'].map(k => byId.get('232867647744770048')[k]), [26, 24427, 0]);
    const veteran = byId.get('261807429883396096');
    assert.deepStrictEqual([veteran.level, veteran.prestige, veteran.legacy.level], [50, 23, 84]);
    assert.strictEqual(byId.get('320897026407661569').prestige, 8);
    assert.ok(accounts.every(a => a.importedAt && a.guildId === G));
    // Someone not on the server is stored obfuscated, journal included
    const gone = '1004082085373427753';
    const present = new Set(rows.map(r => String(r.id)).filter(id => id !== gone));
    const partial = buildImport(rows, G, '2026-10-18T00:00:00.000Z', present, () => 'anon-x');
    const hidden = partial.accounts.find(a => a.id === 'anon-x');
    assert.ok(hidden && hidden.userId === null && hidden.leftAt && hidden.displayName === null);
    assert.ok(!partial.accounts.some(a => a.id === gone || a.userId === gone));
    assert.ok(!partial.transactions.some(t => t.userId === gone) && partial.transactions.some(t => t.userId === 'anon-x'));
    assert.ok(transactions.length > 700 && transactions.every(t => t.createdAt && t.amount !== 0));
    assert.strictEqual(new Set(transactions.map(t => t.id)).size, transactions.length, 'ids are unique, so a re-run overwrites instead of duplicating');
}

tokenizer();
entries();
realDump();
console.log('import-economy tests passed');
