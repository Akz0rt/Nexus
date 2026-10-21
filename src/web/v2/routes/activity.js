const express = require('express');
const ActivityService = require('../../../services/ActivityService');
const VoiceActivityService = require('../../../services/VoiceActivityService');
const ActivitySyncService = require('../../../services/ActivitySyncService');
const { userRef } = require('../serialize');
const { mergeTop } = require('../../../services/activityRanking');

const router = express.Router({ mergeParams: true });

const PERIODS = new Set(['day', 'week', 'month']);
const MODES = new Set(['text', 'voice', 'both']);
const TOP = 50;
// Bars on the charts per period; data is kept per day, so «day» shows the last week with today marked
const CHART_DAYS = { day: 7, week: 7, month: 30 };

/** The last `days` days, every day present (zeros where nothing happened). */
function dailySeries(textDays, voiceDays, days = 30, today = new Date()) {
    const messages = new Map(textDays.map(d => [d.date, d.messages]));
    const minutes = new Map(voiceDays.map(d => [d.date, d.minutes]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        series.push({ date, messages: messages.get(date) || 0, voiceMinutes: minutes.get(date) || 0 });
    }
    return series;
}

// GET /activity?period=day|week|month&mode=text|voice|both
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const period = PERIODS.has(req.query.period) ? req.query.period : 'week';
        const mode = MODES.has(req.query.mode) ? req.query.mode : 'both';
        const days = CHART_DAYS[period];
        const [textRows, voiceRows, textDays, voiceDays, sync] = await Promise.all([
            // Every server's own counts only
            mode === 'voice' ? [] : ActivityService.getTopUsersByPeriod(guild.id, period),
            mode === 'text' ? [] : VoiceActivityService.getTopUsersByPeriod(guild.id, period),
            ActivityService.getDailyTotals(guild.id, days),
            VoiceActivityService.getDailyTotals(guild.id, days),
            ActivitySyncService.getStatus(guild.id).catch(() => null)
        ]);
        const top = mergeTop(textRows, voiceRows, mode).slice(0, TOP).map(r => {
            const ref = userRef(guild, r.userId);
            return { ...r, displayName: ref.displayName || r.displayName, avatarURL: ref.avatarURL || r.avatarURL, member: guild.members.cache.has(r.userId) };
        });
        res.json({ supported: true, period, mode, top, days, daily: dailySeries(textDays, voiceDays, days), sync });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
module.exports.mergeTop = mergeTop;
module.exports.dailySeries = dailySeries;
module.exports.CHART_DAYS = CHART_DAYS;
