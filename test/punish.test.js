// Standalone test (no test framework configured): run with `node test/punish.test.js`
// «Наказать…»: templates (checked steps, administrators edit, moderators use), the
// steps run in order and stop at a refusal, a punishment from a report closes it,
// report cards carry the target's record, tab counts.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const GuildSettingsService = require('../src/services/GuildSettingsService');
const AuditLogService = require('../src/services/AuditLogService');
const ModerationService = require('../src/modules/moderation/ModerationService');
const WarningService = require('../src/modules/moderation/WarningService');
const TempBanService = require('../src/modules/moderation/TempBanService');
const ReportService = require('../src/modules/reports/ReportService');
const { cleanSteps, describeSteps, DEFAULT_PUNISH_TEMPLATES } = require('../src/modules/moderation/templates');
const { createApp } = require('../src/server');
const { makeGuild, makeChannel, makeMember } = require('./fake-voice-guild');

const ADMIN = '100000000000000001';
const MOD = '100000000000000002';
const GRISHA = '300000000000000001';
const CHAT = '500000000000000001';

function steps() {
    assert.deepStrictEqual(cleanSteps([{ kind: 'warn' }, { kind: 'mute', duration: '10m' }]).map(s => s.kind), ['warn', 'mute'], 'run order: warn, then mute');
    assert.strictEqual(cleanSteps([{ kind: 'mute', duration: '3y' }]), null, 'unknown duration');
    assert.strictEqual(cleanSteps([{ kind: 'kick' }, { kind: 'ban', duration: 'forever' }]), null, 'kick and ban together');
    assert.strictEqual(cleanSteps([{ kind: 'warn' }, { kind: 'warn' }]), null, 'a kind twice');
    assert.strictEqual(cleanSteps([]), null);
    assert.strictEqual(describeSteps(DEFAULT_PUNISH_TEMPLATES[0].steps), 'мут 10 мин + варн');
    assert.strictEqual(describeSteps(DEFAULT_PUNISH_TEMPLATES[3].steps), 'бан навсегда, удалить за 7 дн.');
}

let doc = {};
let calls = [];
let closed = [];
let refuse = null;
GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, doc);
GuildSettingsService.update = async (guildId, patch) => { doc = { ...doc, ...patch }; return doc; };
AuditLogService.log = async entry => entry;
AuditLogService.query = async filters => ({
    items: filters.targetId === GRISHA ? [{ action: 'moderation.muted', createdAt: new Date().toISOString(), targetIds: [GRISHA] }] : []
});
WarningService.listActive = async () => [{ userId: GRISHA }, { userId: 'someone' }];
TempBanService.list = async () => [];
for (const kind of ['warn', 'kick']) {
    ModerationService[kind] = async () => { calls.push(kind); return refuse === kind ? { ok: false, code: 'target_higher' } : { ok: true }; };
}
ModerationService.mute = async (g, u, duration) => { calls.push(`mute ${duration}`); return refuse === 'mute' ? { ok: false, code: 'target_higher' } : { ok: true }; };
ModerationService.ban = async (g, u, options) => { calls.push(`ban ${options.duration} ${options.deleteMessageDays}`); return { ok: true }; };
const report = { id: 'r1', guildId: 'g', status: 'open', targetId: GRISHA, reporterId: MOD, channelId: CHAT, reason: 'оскорбляет', content: 'текст', attachments: [], createdAt: new Date().toISOString() };
ReportService.get = async (guildId, id) => (id === 'r1' ? report : null);
ReportService.list = async () => [report];
ReportService.close = async (guildId, id, status, note) => { closed.push({ id, status, note }); return { ok: true, report: { ...report, status, resolution: note } }; };

const guild = makeGuild();
guild.iconURL = () => null;
guild.bans = { fetch: async () => Object.assign(new Map([['a', {}], ['b', {}]]), { lastKey: () => 'b' }) };
makeChannel(guild, { id: CHAT, name: 'общий', type: 0 });
makeMember(guild, ADMIN, { position: 10, perms: flag => flag === PermissionFlagsBits.Administrator });
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.BanMembers || flag === PermissionFlagsBits.ViewChannel });
makeMember(guild, GRISHA);
guild.memberCount = guild.members.cache.size;

(async () => {
    steps();
    PanelSessionService.get = async token => ({ admin: { userId: ADMIN, username: 'admin' }, mod: { userId: MOD, username: 'mod' } }[token] || null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const call = async (method, path, body, token = 'mod') => {
        const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    try {
        // Templates: everyone reads, only administrators change them
        const list = await call('GET', '/moderation/templates');
        assert.strictEqual(list.body.canEdit, false);
        assert.deepStrictEqual(list.body.items.map(t => t.summary).slice(0, 2), ['мут 10 мин + варн', 'мут 1 ч + варн']);
        assert.strictEqual((await call('PUT', '/moderation/templates', { items: [] })).status, 403);
        assert.strictEqual((await call('PUT', '/moderation/templates', { items: [{ name: 'X', steps: [{ kind: 'mute', duration: 'never' }] }] }, 'admin')).body.error, 'invalid_templates');
        const saved = await call('PUT', '/moderation/templates', {
            items: [...list.body.items, { name: 'Спам', reason: 'Спам', steps: [{ kind: 'warn' }, { kind: 'kick' }] }]
        }, 'admin');
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        const spam = saved.body.items.at(-1);
        assert.strictEqual(spam.summary, 'кик + варн');

        // From a report: the template's steps in order, then the report is closed with what was done
        const flood = await call('POST', `/moderation/${GRISHA}/punish`, { templateId: 'flood', reportId: 'r1' });
        assert.strictEqual(flood.status, 200, JSON.stringify(flood.body));
        assert.deepStrictEqual(calls, ['warn', 'mute 10m']);
        assert.deepStrictEqual(closed, [{ id: 'r1', status: 'resolved', note: 'мут 10 мин + варн' }]);
        assert.strictEqual(flood.body.reportClosed, true);

        // A refusal half-way: the warn stays, the kick is reported, the report notes only the warn
        calls = []; closed = []; refuse = 'kick';
        const partial = await call('POST', `/moderation/${GRISHA}/punish`, { templateId: spam.id, reportId: 'r1' });
        assert.strictEqual(partial.status, 200);
        assert.strictEqual(partial.body.failed, 'target_higher');
        assert.deepStrictEqual(calls, ['warn', 'kick']);
        assert.strictEqual(closed[0].note, 'варн');
        // Refused at the first step: nothing done, the report stays open
        calls = []; closed = []; refuse = 'warn';
        const none = await call('POST', `/moderation/${GRISHA}/punish`, { templateId: spam.id, reportId: 'r1' });
        assert.strictEqual(none.status, 403);
        assert.deepStrictEqual(closed, []);
        refuse = null;

        // Own steps, a ban with message deletion
        calls = [];
        const own = await call('POST', `/moderation/${GRISHA}/punish`, { steps: [{ kind: 'ban', duration: '7d', deleteDays: 1 }], reason: 'Реклама' });
        assert.strictEqual(own.status, 200);
        assert.deepStrictEqual(calls, ['ban 7d 1']);
        assert.strictEqual((await call('POST', `/moderation/${GRISHA}/punish`, { steps: [{ kind: 'warn' }] })).body.error, 'reason_required');
        assert.strictEqual((await call('POST', `/moderation/${GRISHA}/punish`, { templateId: 'nope' })).status, 404);

        // A report card knows the target's record; the tabs know their counts
        const reports = await call('GET', '/reports?status=open');
        assert.deepStrictEqual(reports.body.items[0].record, { activeWarns: 1, mutes: 1, lastMuteAt: reports.body.items[0].record.lastMuteAt, kicks: 0, bans: 0 });
        assert.deepStrictEqual((await call('GET', '/moderation/summary')).body, { active: 0, bans: 2, warnings: 2 });
        console.log('punish tests passed');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
