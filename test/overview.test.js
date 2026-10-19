// Standalone test (no test framework configured): run with `node test/overview.test.js`
// The start screen's context lines: passes in the last hour, the nearest mute to end,
// the invite of each queue row, the freshest report nobody took (only from channels the
// moderator reads), today's birthday with its status and the bot's check time.

const assert = require('assert');
const { Collection, PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '', checkTime: '09:00' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const AuditLogService = require('../src/services/AuditLogService');
const CosmosDBService = require('../src/services/CosmosDBService');
const VerificationService = require('../src/modules/verification/VerificationService');
const QueueCardService = require('../src/modules/verification/QueueCardService');
const ReportService = require('../src/modules/reports/ReportService');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const NEWBIE = '300000000000000001';
const LEV = '300000000000000002';
const TARGET = '300000000000000003';
const OPEN_CHAT = '500000000000000001';
const STAFF_CHAT = '500000000000000002';
const UNVERIFIED = '700000000000000001';
const MIN = 60 * 1000;
const now = Date.now();

const guild = makeGuild();
guild.iconURL = () => null;
const textChannel = (id, readable) => ({ id, name: id, type: 0, permissionsFor: () => ({ has: () => readable }) });
guild.channels.cache.set(OPEN_CHAT, textChannel(OPEN_CHAT, true));
guild.channels.cache.set(STAFF_CHAT, textChannel(STAFF_CHAT, false));
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.ModerateMembers });
const newbie = makeMember(guild, NEWBIE);
newbie.roles.cache = new Collection([[UNVERIFIED, { id: UNVERIFIED }]]);
makeMember(guild, LEV);
makeMember(guild, TARGET).communicationDisabledUntilTimestamp = now + 42 * MIN;
guild.members.cache.get(LEV).communicationDisabledUntilTimestamp = now + 3 * 60 * MIN;
guild.memberCount = guild.members.cache.size;

VerificationService.getQueueSettings = async () => ({ unverifiedRoleId: UNVERIFIED });
QueueCardService.listPending = async () => [{ userId: NEWBIE, status: 'pending', invite: { code: 'abc', inviterId: LEV } }];
QueueCardService.listHandled = async () => [
    { userId: 'a', status: 'approved', handledAt: new Date(now - 10 * MIN).toISOString() },
    { userId: 'b', status: 'approved', handledAt: new Date(now - 50 * MIN).toISOString() },
    { userId: 'c', status: 'approved', handledAt: new Date(now - 3 * 60 * MIN).toISOString() }
];
AuditLogService.query = async () => ({ items: [] });
const today = CosmosDBService.getTodayDateString();
const [, month, day] = today.split('-').map(Number);
CosmosDBService.getAllBirthdays = async () => ({ [LEV]: { month, day, lastCongratulatedOn: today } });
// Newest first, as the service returns them
ReportService.list = async () => [
    { id: 'staff', status: 'open', targetId: TARGET, reporterId: LEV, channelId: STAFF_CHAT, reason: 'в закрытом канале', createdAt: new Date(now - MIN).toISOString() },
    { id: 'taken', status: 'taken', targetId: TARGET, reporterId: LEV, channelId: OPEN_CHAT, reason: 'уже взяли', createdAt: new Date(now - 2 * MIN).toISOString() },
    { id: 'fresh', status: 'open', targetId: TARGET, reporterId: LEV, channelId: OPEN_CHAT, reason: 'оскорбляет', createdAt: new Date(now - 12 * MIN).toISOString() }
];

(async () => {
    PanelSessionService.get = async token => (token === 'mod' ? { userId: MOD, username: 'mod' } : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}/overview`, { headers: { Authorization: 'Bearer mod' } });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));
        assert.strictEqual(body.tiles.approvedToday, 3);
        assert.strictEqual(body.tiles.approvedLastHour, 2);
        assert.strictEqual(body.tiles.activeMutes, 2);
        assert.strictEqual(Date.parse(body.tiles.nextMuteEndsAt), now + 42 * MIN, 'the nearest one');
        assert.strictEqual(body.queue.length, 1);
        assert.strictEqual(body.queue[0].invite.inviter.id, LEV);
        assert.strictEqual(body.report.id, 'fresh', 'not taken, from a channel the moderator reads');
        assert.strictEqual(body.report.reason, 'оскорбляет');
        assert.strictEqual(body.birthdays[0].done, true);
        assert.strictEqual(body.birthdayCheckTime, '09:00');
        console.log('overview tests passed');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
