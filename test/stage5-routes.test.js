// Standalone test (no test framework configured): run with `node test/stage5-routes.test.js`
// The stage-5 routes are mounted where the app expects them (and /events stays
// the live stream), and the role menus need Manage Roles.

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');

const config = require('../src/config');
Object.assign(config, { clientId: '111', discordClientSecret: 'shh', publicUrl: 'https://panel.example', guildId: '' });

const state = require('../src/state');
const PanelSessionService = require('../src/services/PanelSessionService');
const CosmosDBService = require('../src/services/CosmosDBService');
const ActivityService = require('../src/services/ActivityService');
const VoiceActivityService = require('../src/services/VoiceActivityService');
const ActivitySyncService = require('../src/services/ActivitySyncService');
const EventService = require('../src/modules/events/EventService');
const RoleMenuService = require('../src/modules/rolemenus/RoleMenuService');
const ReportService = require('../src/modules/reports/ReportService');
const VoiceService = require('../src/modules/voice/VoiceService');
const TaskService = require('../src/services/TaskService');
const { createApp } = require('../src/server');
const { makeGuild, makeMember } = require('./fake-voice-guild');

const MOD = '100000000000000001';
const ROLES = '100000000000000002';

EventService.list = async () => [];
RoleMenuService.list = async () => [];
ReportService.list = async () => [];
CosmosDBService.getAllBirthdays = async () => ({ [MOD]: { month: 1, day: 2 } });
CosmosDBService.getTodayDateString = () => '2026-10-18';
ActivityService.getTopUsersByPeriod = async () => [{ userId: MOD, displayName: 'mod', totalMessages: 3 }];
ActivityService.getDailyTotals = async () => [];
VoiceActivityService.getTopUsersByPeriod = async () => [];
VoiceActivityService.getDailyTotals = async () => [];
ActivitySyncService.getStatus = async () => ({ isRunning: false });

const guild = makeGuild();
guild.iconURL = () => null;
makeMember(guild, MOD, { position: 10, perms: flag => flag === PermissionFlagsBits.KickMembers });
makeMember(guild, ROLES, { position: 10, perms: flag => flag === PermissionFlagsBits.ManageRoles });
guild.memberCount = guild.members.cache.size;

(async () => {
    let session = { userId: MOD, username: 'mod' };
    PanelSessionService.get = async token => (token === 'tok' ? session : null);
    state.client = { isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } };
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v2/guilds/${guild.id}`;
    const get = async path => {
        const res = await fetch(base + path, { headers: { Authorization: 'Bearer tok' } });
        return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
    };
    try {
        const meetups = await get('/meetups');
        assert.strictEqual(meetups.status, 200);
        assert.deepStrictEqual(meetups.body.items, []);
        assert.deepStrictEqual(meetups.body.durations, [30, 60, 90, 120, 180]);

        // «Собрать в канал» with { background: true } runs as a task; without a voice channel it is refused
        const VOICE = '600000000000000001';
        guild.channels.cache.set(VOICE, { id: VOICE, name: 'Мафия', type: 2 });
        const event = { id: 'e1', guildId: guild.id, title: 'Мафия', startsAt: new Date().toISOString(), going: [MOD], voiceChannelId: VOICE, squadId: 's1' };
        EventService.get = async () => event;
        VoiceService.saveSquad = async () => ({ ok: true, squad: { id: 's1' } });
        const started = [];
        TaskService.start = spec => { started.push(spec); return { ok: true, task: { id: 't1', title: spec.title } }; };
        const post = async (path, body) => {
            const res = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return { status: res.status, body: await res.json() };
        };
        const gather = await post('/meetups/e1/gather', { background: true });
        assert.strictEqual(gather.status, 200, JSON.stringify(gather.body));
        assert.strictEqual(gather.body.task.id, 't1');
        assert.strictEqual(started[0].title, 'Сбор состава в «Мафия»');
        event.voiceChannelId = null;
        assert.strictEqual((await post('/meetups/e1/gather', { background: true })).body.error, 'channel_not_found');
        assert.strictEqual(started.length, 1);
        const birthdays = await get('/birthdays');
        assert.strictEqual(birthdays.status, 200);
        assert.deepStrictEqual(birthdays.body.items.map(i => [i.user.id, i.month, i.day]), [[MOD, 1, 2]]);
        const activity = await get('/activity');
        assert.strictEqual(activity.status, 200);
        assert.strictEqual(activity.body.top[0].messages, 3);
        assert.strictEqual(activity.body.daily.length, 7, 'the default period (week) charts 7 days');
        assert.strictEqual((await get('/activity?period=month')).body.daily.length, 30);
        assert.strictEqual((await get('/reports')).status, 200);
        // The birthday store is shared across servers: someone not on this one can't be touched
        CosmosDBService.getBirthday = async () => ({ month: 1, day: 2 });
        const stranger = await fetch(`${base}/birthdays/300000000000000009`, { method: 'DELETE', headers: { Authorization: 'Bearer tok' } });
        assert.strictEqual(stranger.status, 404);
        assert.strictEqual((await get('/roles/menus')).status, 403, 'role menus need Manage Roles');

        session = { userId: ROLES, username: 'roles' };
        assert.strictEqual((await get('/roles/menus')).status, 200);

        // /events is still the live stream, not the events list
        const controller = new AbortController();
        const stream = await fetch(`${base}/events`, { headers: { Authorization: 'Bearer tok' }, signal: controller.signal });
        assert.ok(stream.headers.get('content-type').includes('text/event-stream'));
        controller.abort();
        console.log('stage 5 route tests passed');
    } finally {
        server.close();
        server.closeAllConnections?.();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
