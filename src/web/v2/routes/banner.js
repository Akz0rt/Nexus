const express = require('express');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const { actorOf } = require('../result');
const { userRef } = require('../serialize');
const { getLeaders } = require('../../../banner/leaders');
const { collect, sampleData } = require('../../../banner/data');
const { renderFrame, RendererUnavailable } = require('../../../banner/render');
const {
    MODES, LAYOUT_MODES, LAYOUTS, PERIODS, CALCS, BACKINGS, INTERVALS, MAX_BLUR, sanitizeBanner
} = require('../../../banner/settings');

// Mounted behind the administrators-only gate («старшая администрация»)
const router = express.Router({ mergeParams: true });

const RACE_SIZE = 3;

function describeOptions() {
    return { modes: MODES, layoutModes: LAYOUT_MODES, layouts: LAYOUTS, periods: PERIODS, calcs: CALCS, backings: BACKINGS, intervals: INTERVALS, maxBlur: MAX_BLUR };
}

// GET /banner/settings
router.get('/settings', async (req, res, next) => {
    try {
        const { banner } = await GuildSettingsService.get(req.guild.id);
        res.json({ values: banner, options: describeOptions() });
    } catch (error) {
        next(error);
    }
});

// PUT /banner/settings — any subset of the fields; nested groups merge with what's saved
router.put('/settings', async (req, res, next) => {
    try {
        const guild = req.guild;
        const { banner } = await GuildSettingsService.get(guild.id);
        const result = sanitizeBanner(req.body || {}, banner);
        if (!result.ok) return res.status(400).json({ error: result.code, field: result.field });

        await GuildSettingsService.update(guild.id, { banner: result.banner });
        const actor = actorOf(req);
        await AuditLogService.log({
            guildId: guild.id,
            action: 'banner.settings_updated',
            actorId: actor.id,
            actorTag: actor.tag,
            source: 'panel',
            details: { fields: result.fields }
        });
        res.json({ ok: true, values: (await GuildSettingsService.get(guild.id)).banner });
    } catch (error) {
        next(error);
    }
});

// GET /banner/race — the top 3 for «Гонка за баннер» (saved period and counting)
router.get('/race', async (req, res, next) => {
    try {
        const { banner } = await GuildSettingsService.get(req.guild.id);
        const top = await getLeaders(req.guild, { period: banner.period, calc: banner.calc, exclude: banner.exclude, limit: RACE_SIZE });
        res.json({
            period: banner.period,
            calc: banner.calc,
            top: top.map((row, index) => ({
                ...userRef(req.guild, row.userId),
                messages: row.messages,
                minutes: row.minutes,
                score: row.score,
                behind: index === 0 ? 0 : top[0].score - row.score
            }))
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /banner/preview?mode&layout&backing&blur&dim&period&calc — the first frame as PNG,
 * with the panel's unsaved values. When the server has nothing for the mode yet, the
 * mockup's data is drawn and X-Banner-Sample: 1 says so.
 */
router.get('/preview', async (req, res, next) => {
    try {
        const settings = await GuildSettingsService.get(req.guild.id);
        const q = req.query;
        const mode = LAYOUT_MODES.includes(q.mode) ? q.mode : (settings.banner.mode === 'podium' ? 'podium' : 'leader');
        const banner = {
            ...settings.banner,
            period: PERIODS.includes(q.period) ? q.period : settings.banner.period,
            calc: CALCS.includes(q.calc) ? q.calc : settings.banner.calc
        };
        const blur = Number(q.blur);
        const dim = Number(q.dim);
        const spec = {
            mode,
            layout: LAYOUTS.includes(q.layout) ? q.layout : banner.layouts[mode],
            backing: BACKINGS.includes(q.backing) ? q.backing : banner.backing,
            blur: q.blur !== undefined && blur >= 0 && blur <= MAX_BLUR ? blur : banner.blur,
            dim: q.dim !== undefined && dim >= 0 && dim <= 1 ? dim : banner.dim
        };

        let data = await collect(req.guild, { ...settings, banner }, mode);
        const sample = !data;
        if (sample) data = sampleData(mode, banner);

        // The uploaded background comes with the «Баннер» screen; until then the brand's dark color
        const { png } = await renderFrame({ ...spec, data }, null);
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Banner-Sample': sample ? '1' : '0' });
        res.send(png);
    } catch (error) {
        if (error instanceof RendererUnavailable) {
            console.error('Banner preview:', error.message);
            return res.status(503).json({ error: 'renderer_unavailable' });
        }
        next(error);
    }
});

module.exports = router;
