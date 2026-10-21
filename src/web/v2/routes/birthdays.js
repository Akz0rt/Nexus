const express = require('express');
const CosmosDBService = require('../../../services/CosmosDBService');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const NotificationService = require('../../../services/NotificationService');
const AuditLogService = require('../../../services/AuditLogService');
const { isValidDate } = require('../../../utils/dateUtils');
const { actorOf } = require('../result');
const { userRef } = require('../serialize');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS = {
    invalid_date: 400,
    invalid_user_id: 400,
    member_not_found: 404,
    birthday_not_found: 404,
    not_today: 409,
    already_congratulated: 409,
    no_channel: 409
};

/**
 * The next birthday on or after today ("YYYY-MM-DD" in the bot's timezone):
 * its date and how many days away. 29 February falls on the 28th in other years.
 */
function nextBirthday(month, day, todayStr) {
    const [year, todayMonth, todayDay] = todayStr.split('-').map(Number);
    const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const dateIn = y => new Date(Date.UTC(y, month - 1, month === 2 && day === 29 && !isLeap(y) ? 28 : day));
    const today = new Date(Date.UTC(year, todayMonth - 1, todayDay));
    let next = dateIn(year);
    if (next < today) next = dateIn(year + 1);
    return { date: next.toISOString().slice(0, 10), inDays: Math.round((next - today) / DAY_MS) };
}

/** Members of this server with a birthday on its own list, soonest first (anyone who left is hidden). */
function describeBirthdays(guild, birthdays, todayStr) {
    return Object.entries(birthdays || {})
        .filter(([userId]) => guild.members.cache.has(userId))
        .map(([userId, data]) => {
            const next = nextBirthday(data.month, data.day, todayStr);
            return {
                user: userRef(guild, userId),
                month: data.month,
                day: data.day,
                nextDate: next.date,
                inDays: next.inDays,
                // Congratulated (or skipped) for the coming birthday already
                done: data.lastCongratulatedOn === next.date
            };
        })
        .sort((a, b) => a.inDays - b.inDays || String(a.user.displayName).localeCompare(String(b.user.displayName), 'ru'));
}

function channelName(guild, id) {
    return id ? (guild.channels.cache.get(id)?.name || null) : null;
}

async function log(req, action, userId, details = {}) {
    const actor = actorOf(req);
    await AuditLogService.log({
        guildId: req.guild.id, action, actorId: actor.id, actorTag: actor.tag, targetIds: [userId], source: 'panel', details
    });
}

function validUser(req, res, next) {
    if (!SNOWFLAKE_RE.test(req.params.userId)) return res.status(400).json({ error: 'invalid_user_id' });
    next();
}

const fail = (res, code) => res.status(STATUS[code] || 400).json({ error: code });

// Each server keeps its own list; a moderator also only adds dates for this server's members
function memberOfGuild(req, res, next) {
    if (!req.guild.members.cache.has(req.params.userId)) return fail(res, 'member_not_found');
    next();
}

// GET /birthdays — everyone's birthdays here, plus the (read-only) announcement settings
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();
        const settings = await GuildSettingsService.get(guild.id);
        const todayStr = CosmosDBService.getTodayDateString(settings.timezone);
        const birthdays = await CosmosDBService.getAllBirthdays(guild.id);
        res.json({
            today: todayStr,
            items: describeBirthdays(guild, birthdays, todayStr),
            // From Settings → «Дни рождения» (Azure variables on the main server until saved there)
            settings: {
                checkTime: settings.birthdayCheckTime,
                timezone: settings.timezone,
                congratsChannel: channelName(guild, settings.birthdayCongratsChannelId || settings.birthdayAnnounceChannelId),
                announceChannel: channelName(guild, settings.birthdayAnnounceChannelId),
                canEdit: req.panelRole === 'senior'
            }
        });
    } catch (error) {
        next(error);
    }
});

// PUT /birthdays/:userId — { month, day }: set or change someone's birthday
router.put('/:userId', validUser, memberOfGuild, async (req, res, next) => {
    try {
        const month = Number(req.body?.month);
        const day = Number(req.body?.day);
        if (!Number.isInteger(month) || !Number.isInteger(day) || !isValidDate(month, day)) return fail(res, 'invalid_date');
        // setBirthday keeps the "congratulated" mark, so today isn't congratulated twice
        await CosmosDBService.setBirthday(req.guild.id, req.params.userId, month, day);
        await log(req, 'birthday.set', req.params.userId, { month, day });
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

router.delete('/:userId', validUser, memberOfGuild, async (req, res, next) => {
    try {
        const existing = await CosmosDBService.getBirthday(req.guild.id, req.params.userId);
        if (!existing) return fail(res, 'birthday_not_found');
        await CosmosDBService.deleteBirthday(req.guild.id, req.params.userId);
        await log(req, 'birthday.deleted', req.params.userId);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

// POST /birthdays/:userId/congratulate — «Поздравить сейчас», for today's birthdays only
router.post('/:userId/congratulate', validUser, memberOfGuild, async (req, res, next) => {
    try {
        const birthday = await CosmosDBService.getBirthday(req.guild.id, req.params.userId);
        if (!birthday) return fail(res, 'birthday_not_found');
        const { timezone } = await GuildSettingsService.get(req.guild.id);
        if (nextBirthday(birthday.month, birthday.day, CosmosDBService.getTodayDateString(timezone)).inDays !== 0) return fail(res, 'not_today');
        // Posted in this server's own congratulations channel
        const result = await NotificationService.congratulate(req.guild, req.params.userId);
        if (!result.ok) return fail(res, result.code);
        await log(req, 'birthday.congratulated', req.params.userId);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

// POST /birthdays/:userId/skip — «Пропустить в этом году»: the daily run won't congratulate them
router.post('/:userId/skip', validUser, memberOfGuild, async (req, res, next) => {
    try {
        const birthday = await CosmosDBService.getBirthday(req.guild.id, req.params.userId);
        if (!birthday) return fail(res, 'birthday_not_found');
        const { timezone } = await GuildSettingsService.get(req.guild.id);
        const next = nextBirthday(birthday.month, birthday.day, CosmosDBService.getTodayDateString(timezone));
        if (await CosmosDBService.wasCongratulatedOn(req.guild.id, req.params.userId, next.date)) return fail(res, 'already_congratulated');
        await CosmosDBService.markCongratulated(req.guild.id, req.params.userId, next.date);
        await log(req, 'birthday.skipped', req.params.userId, { date: next.date });
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.nextBirthday = nextBirthday;
module.exports.describeBirthdays = describeBirthdays;
