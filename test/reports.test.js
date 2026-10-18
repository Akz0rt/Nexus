// Standalone test (no test framework configured): run with `node test/reports.test.js`
// Reports: refused on self/bots, hourly limit, one per message; lifecycle
// (take → resolve, closed stays closed); DM reply; only moderators who can read
// the channel see a report in the API.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const ReportService = require('../src/modules/reports/ReportService');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const PEER = '100000000000000002';
const AUTHOR = '200000000000000001';
const REPORTER = '200000000000000002';
const OPEN = '600000000000000001';
const STAFF = '600000000000000002';

// In-memory reports container
const docs = new Map();
ReportService.initialize = async () => {};
ReportService.get = async (guildId, id) => (docs.has(id) ? { ...docs.get(id) } : null);
ReportService.save = async report => { docs.set(report.id, { ...report }); return report; };
ReportService.list = async (guildId, group) => [...docs.values()]
    .filter(r => (group === 'closed' ? ['resolved', 'rejected'] : ['open', 'taken']).includes(r.status));
ReportService.recentBy = async (guildId, reporterId, messageId) => {
    const mine = [...docs.values()].filter(r => r.reporterId === reporterId);
    const since = new Date(Date.now() - 3600000).toISOString();
    return { lastHour: mine.filter(r => r.createdAt >= since).length, duplicate: mine.some(r => r.messageId === messageId) };
};
const logged = [];
AuditLogService.log = async entry => { logged.push(entry); return entry; };

const guild = makeGuild();
guild.iconURL = () => null;
const textChannel = (id, name, readable) => guild.channels.cache.set(id, {
    id, name, guild,
    permissionsFor: member => ({ has: flag => readable(member.id) || ![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory].includes(flag) })
});
textChannel(OPEN, 'общий', () => true);
textChannel(STAFF, 'админская', id => id === MOD);
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
makeMember(guild, PEER, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
makeMember(guild, AUTHOR, {});
makeMember(guild, REPORTER, {});
guild.memberCount = guild.members.cache.size;
const dms = [];
guild.client = { users: { fetch: async id => ({ id, send: async payload => { if (id === 'closed') throw new Error('closed'); dms.push(payload.content); } }) } };

let seq = 0;
function message({ channelId = OPEN, author = AUTHOR, bot = false } = {}) {
    seq++;
    return {
        id: `90000000000000${String(seq).padStart(4, '0')}`,
        guild, channelId, content: `сообщение ${seq}`, url: `https://discord.com/x/${seq}`,
        author: { id: author, bot }, attachments: new Collection(), createdAt: new Date()
    };
}
const reporter = { id: REPORTER, tag: 'rep' };

async function creating() {
    assert.strictEqual((await ReportService.create(message({ author: REPORTER }), reporter, 'x')).code, 'self');
    assert.strictEqual((await ReportService.create(message({ bot: true }), reporter, 'x')).code, 'target_bot');
    assert.strictEqual((await ReportService.create(message(), reporter, '  ')).code, 'reason_required');

    const msg = message();
    const first = await ReportService.create(msg, reporter, 'оскорбления');
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.report.targetId, AUTHOR);
    assert.strictEqual(first.report.content, msg.content);
    assert.strictEqual(logged.at(-1).action, 'report.created');
    assert.strictEqual(logged.at(-1).details.content, undefined, 'no message text in the journal');
    assert.strictEqual((await ReportService.create(msg, reporter, 'ещё раз')).code, 'duplicate');

    for (let i = 0; i < 4; i++) assert.strictEqual((await ReportService.create(message(), reporter, 'спам')).ok, true);
    assert.strictEqual((await ReportService.create(message(), reporter, 'спам')).code, 'rate_limited', '5 an hour');
    return first.report;
}

async function lifecycle(report) {
    const mod = { id: MOD, tag: 'mod' };
    const taken = await ReportService.take(guild.id, report.id, mod, 'panel');
    assert.deepStrictEqual([taken.report.status, taken.report.takenBy], ['taken', MOD]);
    const resolved = await ReportService.close(guild.id, report.id, 'resolved', 'выдан мут', mod, 'panel');
    assert.deepStrictEqual([resolved.report.status, resolved.report.resolution], ['resolved', 'выдан мут']);
    assert.strictEqual((await ReportService.take(guild.id, report.id, mod, 'panel')).code, 'report_closed');
    assert.strictEqual((await ReportService.close(guild.id, report.id, 'rejected', '', mod, 'panel')).code, 'report_closed');

    const replied = await ReportService.reply(guild, report.id, 'Спасибо, разобрались', mod, 'panel');
    assert.strictEqual(replied.ok, true);
    assert.ok(dms[0].includes('Спасибо, разобрались'));
    assert.strictEqual((await ReportService.reply(guild, report.id, '', mod, 'panel')).code, 'reason_required');
}

async function api() {
    // One report from the staff-only channel
    const staffReport = (await ReportService.create(message({ channelId: STAFF }), { id: '200000000000000099' }, 'тут тоже')).report;
    let session = { userId: PEER, username: 'peer' };
    PanelSessionService.get = async token => (token === 'tok' ? session : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, {
            method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        const peerList = await call('GET', '/reports');
        assert.ok(!peerList.body.items.some(r => r.id === staffReport.id), 'PEER cannot read #админская');
        assert.strictEqual((await call('POST', `/reports/${staffReport.id}/take`)).status, 404);

        session = { userId: MOD, username: 'mod' };
        const modList = await call('GET', '/reports');
        assert.ok(modList.body.items.some(r => r.id === staffReport.id));
        const item = modList.body.items.find(r => r.id === staffReport.id);
        assert.strictEqual(item.channel.name, 'админская');
        const rejected = await call('POST', `/reports/${staffReport.id}/reject`, { note: 'не нарушение' });
        assert.strictEqual(rejected.body.report.status, 'rejected');
        const closed = await call('GET', '/reports?status=closed');
        assert.ok(closed.body.items.some(r => r.id === staffReport.id));
    } finally {
        server.close();
    }
}

(async () => {
    const report = await creating();
    await lifecycle(report);
    await api();
    console.log('reports tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
