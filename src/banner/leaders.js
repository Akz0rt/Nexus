const ActivityService = require('../services/ActivityService');
const VoiceActivityService = require('../services/VoiceActivityService');
const { mergeTop } = require('../services/activityRanking');
const { panelRoleFromPermissions } = require('../web/v2/access');

const HOUR_MS = 60 * 60 * 1000;
// Rolling windows to the minute; a week and a month by days, like the Activity screen
const WINDOWS = { '1h': HOUR_MS, '2h': 2 * HOUR_MS, '24h': 24 * HOUR_MS };
const DAY_PERIODS = { '7d': 'week', '30d': 'month' };
const RANKING_MODES = { messages: 'text', voice: 'voice', combined: 'both' };

/** Counted messages and voice time of a server for a banner period */
async function fetchRows(guildId, period, calc) {
    const windowMs = WINDOWS[period];
    const days = DAY_PERIODS[period] || 'week';
    const [text, voice] = await Promise.all([
        calc === 'voice' ? [] : (windowMs
            ? ActivityService.getTopUsersByRecentWindow(guildId, windowMs)
            : ActivityService.getTopUsersByPeriod(guildId, days)),
        calc === 'messages' ? [] : (windowMs
            ? VoiceActivityService.getTopUsersByRecentWindow(guildId, windowMs)
            : VoiceActivityService.getTopUsersByPeriod(guildId, days))
    ]);
    return { text, voice };
}

/**
 * Who leads a server for the period, by messages, voice or both (a message and a
 * voice minute count alike), without the excluded: bots, the administration (anyone
 * with panel access), yesterday's leader, a hand-picked list. Members who left are skipped.
 * @param {import('discord.js').Guild} guild
 * @param {{ period: string, calc: string, exclude?: object, yesterdayLeaderId?: string|null, limit?: number }} options
 * @returns {Promise<Array<{ userId, member, displayName, avatarURL, messages, minutes, score }>>}
 */
async function getLeaders(guild, { period = '24h', calc = 'combined', exclude = {}, yesterdayLeaderId = null, limit = 3 } = {}) {
    const { text, voice } = await fetchRows(guild.id, period, calc);
    const ranked = mergeTop(text, voice, RANKING_MODES[calc] || 'both');
    const skipped = new Set(exclude.users || []);
    if (exclude.yesterdayLeader && yesterdayLeaderId) skipped.add(yesterdayLeaderId);

    const leaders = [];
    for (const row of ranked) {
        if (leaders.length >= limit) break;
        if (skipped.has(row.userId)) continue;
        const member = guild.members.cache.get(row.userId)
            || await guild.members.fetch(row.userId).catch(() => null);
        if (!member) continue;
        if (exclude.bots !== false && member.user.bot) continue;
        if (exclude.admins && panelRoleFromPermissions(member.permissions) !== 'none') continue;
        leaders.push({
            userId: row.userId,
            member,
            displayName: member.displayName,
            avatarURL: member.user.displayAvatarURL({ size: 256, extension: 'png' }),
            messages: row.messages,
            minutes: row.minutes,
            score: row.score
        });
    }
    return leaders;
}

module.exports = { getLeaders, fetchRows, WINDOWS };
