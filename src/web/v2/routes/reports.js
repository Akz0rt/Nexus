const express = require('express');
const ReportService = require('../../../modules/reports/ReportService');
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

function describeReport(guild, report) {
    return {
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
        res.json({
            status: group,
            items: reports.filter(r => canSeeChannel(guild, viewer, r.channelId)).map(r => describeReport(guild, r))
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
