// Standalone test (no test framework configured): run with `node test/multiguild-queries.test.js`
// Where isolation really lives: every query and write of birthdays, message activity and voice
// activity names the server (a guildId filter or partition), and old records are assigned
// only to the server they came from.

const assert = require('assert');

const CosmosDBService = require('../src/services/CosmosDBService');
const ActivityService = require('../src/services/ActivityService');
const VoiceActivityService = require('../src/services/VoiceActivityService');

/** A container that records every query, read, write and patch */
function fakeContainer(rows = []) {
    const log = [];
    const container = {
        log,
        items: {
            query: (spec, options = {}) => {
                log.push({ op: 'query', spec: typeof spec === 'string' ? { query: spec, parameters: [] } : spec, options });
                return { fetchAll: async () => ({ resources: rows }) };
            },
            upsert: async doc => { log.push({ op: 'upsert', doc }); return { resource: doc }; },
            create: async doc => { log.push({ op: 'create', doc }); return { resource: doc }; },
            readAll: () => ({ fetchAll: async () => ({ resources: rows }) })
        },
        item: (id, partition) => ({
            read: async () => { log.push({ op: 'read', id, partition }); return { resource: null }; },
            patch: async ops => { log.push({ op: 'patch', id, partition, ops }); },
            delete: async () => { log.push({ op: 'delete', id, partition }); }
        })
    };
    return container;
}

const guildParam = entry => entry.spec.parameters.find(p => p.name === '@guildId')?.value;

async function birthdays() {
    const container = fakeContainer([]);
    Object.assign(CosmosDBService, { initialized: true, container });
    await CosmosDBService.getAllBirthdays('g1');
    await CosmosDBService.getBirthdaysByDate('g1', 10, 20);
    await CosmosDBService.getBirthday('g1', 'u1');
    await CosmosDBService.setBirthday('g1', 'u1', 10, 20);
    await CosmosDBService.markCongratulated('g1', 'u1', '2026-10-20');
    await CosmosDBService.deleteBirthday('g1', 'u1');

    for (const entry of container.log.filter(e => e.op === 'query')) {
        assert.strictEqual(guildParam(entry), 'g1', entry.spec.query);
        assert.ok(entry.spec.query.includes('c.guildId = @guildId'));
        assert.strictEqual(entry.options.partitionKey, 'g1');
    }
    for (const entry of container.log.filter(e => ['read', 'patch', 'delete'].includes(e.op))) {
        assert.strictEqual(entry.partition, 'g1', `${entry.op} must stay in the server's partition`);
    }
    const written = container.log.find(e => e.op === 'upsert').doc;
    assert.deepStrictEqual([written.guildId, written.id], ['g1', 'u1']);
}

async function birthdayMigration() {
    // The old shared list: copied once to the main server, never over a date already set there
    const target = fakeContainer([]);
    const old = fakeContainer([
        { id: 'u1', userId: 'u1', month: 3, day: 4, lastCongratulatedOn: '2026-03-04' },
        { id: 'u2', userId: 'u2', month: 5, day: 6 }
    ]);
    target.items.create = async doc => {
        if (doc.userId === 'u2') throw Object.assign(new Error('exists'), { code: 409 });
        target.log.push({ op: 'create', doc });
    };
    let marker = null;
    target.item = (id, partition) => ({ read: async () => ({ resource: id === 'legacy-birthdays-migrated' ? marker : null }) });
    target.items.upsert = async doc => { marker = doc; };
    Object.assign(CosmosDBService, { initialized: true, container: target, database: { container: () => old } });

    assert.deepStrictEqual(await CosmosDBService.migrateLegacy('g1'), { copied: 1, existing: 1 });
    assert.deepStrictEqual(target.log.find(e => e.op === 'create').doc,
        { id: 'u1', guildId: 'g1', userId: 'u1', month: 3, day: 4, createdAt: target.log[0].doc.createdAt, lastCongratulatedOn: '2026-03-04' });
    assert.strictEqual(marker.targetGuildId, 'g1');
    assert.deepStrictEqual(await CosmosDBService.migrateLegacy('g1'), { skipped: true }, 'once only');
}

async function messageActivity() {
    const container = fakeContainer([]);
    const messagesContainer = fakeContainer([]);
    Object.assign(ActivityService, { initialized: true, container, messagesContainer });
    await ActivityService.getTopUsersByPeriod('g1', 'week');
    await ActivityService.getDailyTotals('g1', 7);
    await ActivityService.lastMessageAt('g1', 'u1');
    await ActivityService.getTopUsersByRecentWindow('g1', 3600000);
    await ActivityService.getPeriodDebugStats('g1', 'week');
    const queries = [...container.log, ...messagesContainer.log].filter(e => e.op === 'query');
    assert.ok(queries.length >= 6);
    for (const entry of queries) {
        assert.strictEqual(guildParam(entry), 'g1', entry.spec.query);
        assert.ok(entry.spec.query.includes('c.guildId = @guildId'), entry.spec.query);
    }

    // A message is counted for its server, in a document of its own per server
    await ActivityService.recordMessageById({ guildId: 'g1', userId: 'u1', displayName: 'U', avatarURL: null, messageId: 'm1', channelId: 'c1', timestamp: Date.parse('2026-10-20T10:00:00Z') });
    const dedup = messagesContainer.log.find(e => e.op === 'create').doc;
    assert.strictEqual(dedup.guildId, 'g1');
    const counted = container.log.filter(e => e.op === 'upsert' || e.op === 'create').at(-1).doc;
    assert.deepStrictEqual([counted.guildId, counted.id], ['g1', 'g1-u1-2026-10-20']);
    await assert.rejects(() => ActivityService.recordMessageById({ userId: 'u1', displayName: 'U' }), /guildId is required/);

    // Old counts (no server): assigned to the chosen server, or left alone when it's unclear
    const legacy = fakeContainer([{ id: 'u1-2026-10-19', userId: 'u1' }]);
    Object.assign(ActivityService, { container: legacy });
    assert.deepStrictEqual(await ActivityService.migrateLegacy(null), { migrated: 0, skipped: 1 });
    assert.ok(!legacy.log.some(e => e.op === 'patch'), 'nothing guessed');
    assert.deepStrictEqual(await ActivityService.migrateLegacy('g1'), { migrated: 1 });
    assert.deepStrictEqual(legacy.log.find(e => e.op === 'patch').ops, [{ op: 'add', path: '/guildId', value: 'g1' }]);
}

async function voiceActivity() {
    const container = fakeContainer([]);
    Object.assign(VoiceActivityService, { initialized: true, container });
    await VoiceActivityService.getTopUsersByPeriod('g1', 'week');
    await VoiceActivityService.getTopUsersByRecentWindow('g1', 3600000);
    await VoiceActivityService.getDailyTotals('g1', 7);
    await VoiceActivityService.getPeriodDebugStats('g1', 'week');
    const queries = container.log.filter(e => e.op === 'query');
    assert.strictEqual(queries.length, 4);
    for (const entry of queries) {
        assert.strictEqual(guildParam(entry), 'g1', entry.spec.query);
        assert.strictEqual(entry.options.partitionKey, 'g1');
    }
}

async function legacyTargetChoice() {
    const config = require('../src/config');
    const SyncMetadataService = require('../src/services/SyncMetadataService');
    const { legacyTarget } = require('../src/modules/activity');
    let marker = null;
    let sources = [];
    SyncMetadataService.getMarker = async () => marker;
    SyncMetadataService.setMarker = async (id, data) => { marker = data; };
    SyncMetadataService.listSyncedGuildIds = async () => sources;

    // Synced from one server that is GUILD_ID: it, and remembered for later starts
    config.guildId = 'g1';
    sources = ['g1'];
    assert.strictEqual(await legacyTarget(), 'g1');
    sources = ['g1', 'g2']; // every server synced since
    assert.strictEqual(await legacyTarget(), 'g1', 'the first answer is kept');

    // Synced from another server than GUILD_ID, or from several: nothing
    marker = null;
    sources = ['g2'];
    assert.strictEqual(await legacyTarget(), null);
    marker = null;
    config.guildId = '';
    sources = ['g1', 'g2'];
    assert.strictEqual(await legacyTarget(), null);
    marker = null;
    sources = ['g2'];
    assert.strictEqual(await legacyTarget(), 'g2', 'no GUILD_ID: the one server synced so far');
}

(async () => {
    await birthdays();
    await birthdayMigration();
    await messageActivity();
    await voiceActivity();
    await legacyTargetChoice();
    console.log('multi-server query isolation tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
