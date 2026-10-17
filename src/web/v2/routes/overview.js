const express = require('express');
const config = require('../../../config');
const AuditLogService = require('../../../services/AuditLogService');
const BirthdayService = require('../../../services/BirthdayService');
const VerificationService = require('../../../modules/verification/VerificationService');
const QueueCardService = require('../../../modules/verification/QueueCardService');
const { startOfToday, getDaysUntilBirthday } = require('../../../utils/dateUtils');
const { describeMember, mergeQueue, userRef } = require('../serialize');
const { canSeeEntry } = require('../visibility');
const { describeBoard } = require('./voice');

const router = express.Router({ mergeParams: true });

const QUEUE_SHOWN = 5;
const JOURNAL_SHOWN = 10;
const BIRTHDAY_DAYS = 7;

/** Members of this server with a birthday today or in the next 7 days, soonest first. */
function upcomingBirthdays(guild, birthdays) {
    return Object.entries(birthdays || {})
        .map(([userId, date]) => ({ userId, ...date, inDays: getDaysUntilBirthday(date.month, date.day) }))
        .filter(item => item.inDays <= BIRTHDAY_DAYS && guild.members.cache.has(item.userId))
        .sort((a, b) => a.inDays - b.inDays)
        .map(item => ({ ...userRef(guild, item.userId), month: item.month, day: item.day, inDays: item.inDays }));
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
        const [pending, approvedToday, journal, birthdays] = await Promise.all([
            settings ? QueueCardService.listPending(guild.id) : [],
            settings ? QueueCardService.listHandled(guild.id, ['approved'], since) : [],
            AuditLogService.query({ guildId: guild.id, excludePrefix: 'message.' }, { limit: 30 }),
            BirthdayService.getAllBirthdays().catch(() => ({}))
        ]);

        const queue = settings
            ? mergeQueue(guild.members.cache.filter(m => m.roles.cache.has(settings.unverifiedRoleId)).map(describeMember), pending)
            : null;
        const { voice, inVoice } = voiceBlock(guild, viewer);
        const now = Date.now();

        const entries = journal.items.filter(entry => canSeeEntry(guild, viewer, entry)).slice(0, JOURNAL_SHOWN);
        const users = {};
        for (const entry of entries) {
            for (const id of [entry.actorId, ...(entry.targetIds || [])]) if (id && !users[id]) users[id] = userRef(guild, id);
        }

        res.json({
            tiles: {
                waiting: queue ? queue.length : null,
                approvedToday: settings ? approvedToday.length : null,
                inVoice,
                activeMutes: guild.members.cache.filter(m => (m.communicationDisabledUntilTimestamp || 0) > now).size
            },
            queue: queue ? queue.slice(0, QUEUE_SHOWN) : null,
            voice,
            journal: entries,
            users,
            birthdays: upcomingBirthdays(guild, birthdays)
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.upcomingBirthdays = upcomingBirthdays;
