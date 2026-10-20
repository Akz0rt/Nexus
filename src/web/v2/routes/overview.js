const express = require('express');
const config = require('../../../config');
const AuditLogService = require('../../../services/AuditLogService');
const CosmosDBService = require('../../../services/CosmosDBService');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const VerificationService = require('../../../modules/verification/VerificationService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const ReportService = require('../../../modules/reports/ReportService');
const { startOfToday } = require('../../../utils/dateUtils');
const { describeMember, flagContext, mergeQueue, userRef } = require('../serialize');
const { canSeeChannel, canSeeEntry } = require('../visibility');
const { describeBoard } = require('./voice');
const { describeBirthdays } = require('./birthdays');
const { inviteOf, inQueue } = require('./queue');
const { describeReport } = require('./reports');

const router = express.Router({ mergeParams: true });

const QUEUE_SHOWN = 5;
const JOURNAL_SHOWN = 10;
const BIRTHDAY_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;

/** Members of this server with a birthday today or in the next 7 days, soonest first. */
function upcomingBirthdays(guild, birthdays, todayStr = CosmosDBService.getTodayDateString()) {
    return describeBirthdays(guild, birthdays, todayStr)
        .filter(item => item.inDays <= BIRTHDAY_DAYS)
        .map(item => ({ ...item.user, month: item.month, day: item.day, inDays: item.inDays, done: item.done }));
}

/** Voice channels with people in them, from Discord's cache (no database). */
function voiceBlock(guild, viewer) {
    const board = viewer ? describeBoard(guild, viewer) : [];
    const voice = board
        .flatMap(category => category.channels.map(channel => ({ ...channel, category: category.name })))
        .filter(channel => channel.members.length > 0);
    return { voice, inVoice: voice.reduce((sum, channel) => sum + channel.members.length, 0) };
}

// GET /overview — everything the start screen shows, in one request.
// ?parts=voice — only the voice block: it changes often and costs no database queries.
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const viewer = guild.members.cache.get(req.session.userId);
        if (req.query.parts === 'voice') return res.json(voiceBlock(guild, viewer));
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();

        const settings = await VerificationService.getQueueSettings(guild.id);
        const since = startOfToday(config.timezone).toISOString();
        const [pending, approvedToday, journal, birthdays, reports] = await Promise.all([
            settings ? QueueCardService.listPending(guild.id) : [],
            settings ? QueueCardService.listHandled(guild.id, ['approved'], since) : [],
            AuditLogService.query({ guildId: guild.id, excludePrefix: 'message.' }, { limit: 30 }),
            CosmosDBService.getAllBirthdays().catch(() => ({})),
            ReportService.list(guild.id, 'open').catch(() => [])
        ]);

        const context = settings ? await flagContext(guild, new Map(pending.map(card => [card.userId, card.kickCount || 0]))) : null;
        const queue = settings
            ? mergeQueue(guild.members.cache.filter(m => inQueue(m, settings)).map(m => describeMember(m, context)), pending)
            : null;
        const cards = new Map(pending.map(card => [card.userId, card]));
        const { voice, inVoice } = voiceBlock(guild, viewer);
        const now = Date.now();
        const muteEnds = guild.members.cache
            .map(m => m.communicationDisabledUntilTimestamp || 0)
            .filter(at => at > now);
        // The newest report nobody took yet, from a channel this moderator can read
        const fresh = reports.find(r => r.status === 'open' && canSeeChannel(guild, viewer, r.channelId));

        const entries = journal.items.filter(entry => canSeeEntry(guild, viewer, entry)).slice(0, JOURNAL_SHOWN);
        const users = {};
        for (const entry of entries) {
            for (const id of [entry.actorId, ...(entry.targetIds || [])]) if (id && !users[id]) users[id] = userRef(guild, id);
        }

        res.json({
            tiles: {
                waiting: queue ? queue.length : null,
                approvedToday: settings ? approvedToday.length : null,
                approvedLastHour: settings ? approvedToday.filter(card => Date.parse(card.handledAt) >= now - HOUR_MS).length : null,
                inVoice,
                activeMutes: muteEnds.length,
                nextMuteEndsAt: muteEnds.length ? new Date(Math.min(...muteEnds)).toISOString() : null
            },
            queue: queue
                ? queue.slice(0, QUEUE_SHOWN).map(item => ({ ...item, invite: inviteOf(guild, cards.get(item.member.id), item.member.id) }))
                : null,
            voice,
            journal: entries,
            users,
            report: fresh ? describeReport(guild, fresh) : null,
            birthdays: upcomingBirthdays(guild, birthdays),
            birthdayCheckTime: settings?.birthdayCheckTime || (await GuildSettingsService.get(guild.id)).birthdayCheckTime || config.checkTime
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.upcomingBirthdays = upcomingBirthdays;
