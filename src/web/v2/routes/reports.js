const express = require('express');
const ReportService = require('../../../modules/reports/ReportService');
const AuditLogService = require('../../../services/AuditLogService');
const WarningService = require('../../../modules/moderation/WarningService');

const RECORD_DAYS = 30;
const { actorOf, sendResult } = require('../result');
const { userRef } = require('../serialize');
const { canSeeChannel } = require('../visibility');

const router = express.Router({ mergeParams: true });

const STATUS = {
    reason_required: 400,
    report_not_found: 404,
    user_not_found: 404,
    report_closed: 409,
    dm_closed: 409
};

/**
 * The target's record for each report: active warns and punishments of the last 30 days
 * («у него 1 варн и мут сегодня» / «нарушений раньше не было»).
 */
async function recordsOf(guild, targetIds) {
    const since = new Date(Date.now() - RECORD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const [warns, entries] = await Promise.all([
        WarningService.listActive(guild.id).catch(() => []),
        Promise.all([...new Set(targetIds)].map(async targetId => [targetId,
            (await AuditLogService.query({ guildId: guild.id, targetId, action: 'moderation.*', since }, { limit: 50 }).catch(() => ({ items: [] }))).items]))
    ]);
    const records = new Map();
    for (const [targetId, items] of entries) {
        const count = action => items.filter(e => e.action === action);
        const mutes = count('moderation.muted');
        records.set(targetId, {
            activeWarns: warns.filter(w => w.userId === targetId).length,
            mutes: mutes.length,
            lastMuteAt: mutes[0]?.createdAt || null,
            kicks: count('moderation.kicked').length,
            bans: count('moderation.banned').length
        });
    }
    return records;
}

function describeReport(guild, report, record = null) {
    return {
        record,
        id: report.id,
        status: report.status,
        target: userRef(guild, report.targetId),
        reporter: userRef(guild, report.reporterId),
        channel: { id: report.channelId, name: guild.channels.cache.get(report.channelId)?.name || null },
        messageUrl: report.messageUrl,
        content: report.content,
        attachments: report.attachments || [],
        sentAt: report.sentAt,
        reason: report.reason,
        takenBy: userRef(guild, report.takenBy),
        resolvedBy: userRef(guild, report.resolvedBy),
        resolution: report.resolution,
        resolvedAt: report.resolvedAt || null,
        repliedAt: report.repliedAt,
        createdAt: report.createdAt
    };
}

/** A report carries message text: only for moderators who can read that channel. */
async function visibleReport(req, res, next) {
    try {
        const report = await ReportService.get(req.guild.id, req.params.reportId);
        const viewer = req.guild.members.cache.get(req.session.userId);
        if (!report || !canSeeChannel(req.guild, viewer, report.channelId)) {
            return res.status(404).json({ error: 'report_not_found' });
        }
        next();
    } catch (error) {
        next(error);
    }
}

const handle = run => async (req, res, next) => {
    try {
        const result = await run(req, actorOf(req));
        if (result.ok) return res.json({ ok: true, report: describeReport(req.guild, result.report) });
        sendResult(res, result, STATUS);
    } catch (error) {
        next(error);
    }
};

// GET /reports?status=open|closed
router.get('/', async (req, res, next) => {
    try {
        const guild = req.guild;
        const viewer = guild.members.cache.get(req.session.userId);
        const group = req.query.status === 'closed' ? 'closed' : 'open';
        const reports = await ReportService.list(guild.id, group);
        const visible = reports.filter(r => canSeeChannel(guild, viewer, r.channelId));
        const records = group === 'open' ? await recordsOf(guild, visible.map(r => r.targetId)) : new Map();
        res.json({
            status: group,
            items: visible.map(r => describeReport(guild, r, records.get(r.targetId) || null))
        });
    } catch (error) {
        next(error);
    }
});

router.post('/:reportId/take', visibleReport, handle((req, actor) =>
    ReportService.take(req.guild.id, req.params.reportId, actor, 'panel')));

// POST /reports/:id/resolve|reject — { note? }
router.post('/:reportId/resolve', visibleReport, handle((req, actor) =>
    ReportService.close(req.guild.id, req.params.reportId, 'resolved', req.body?.note, actor, 'panel')));

router.post('/:reportId/reject', visibleReport, handle((req, actor) =>
    ReportService.close(req.guild.id, req.params.reportId, 'rejected', req.body?.note, actor, 'panel')));

// POST /reports/:id/reply — { text }: the bot DMs the reporter
router.post('/:reportId/reply', visibleReport, handle((req, actor) =>
    ReportService.reply(req.guild, req.params.reportId, req.body?.text, actor, 'panel')));

module.exports = router;
module.exports.describeReport = describeReport;
