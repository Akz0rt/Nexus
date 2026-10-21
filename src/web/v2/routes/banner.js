const express = require('express');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const { actorOf } = require('../result');
const { userRef } = require('../serialize');
const { getLeaders } = require('../../../banner/leaders');
const { collect, sampleData } = require('../../../banner/data');
const { renderFrame, RendererUnavailable } = require('../../../banner/render');
const { firstFrame } = require('../../../banner/compose');
const BannerStore = require('../../../banner/store');
const TaskService = require('../../../services/TaskService');
const { publisher, REASONS, MANUAL_EVERY_MS } = require('../../../banner/publisher');
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

        // The uploaded background (its first frame), or the brand's dark color without one
        const background = await BannerStore.getBackground(req.guild.id).catch(() => null);
        const still = background && (background.meta.type === 'image/gif' ? await firstFrame(background.buffer) : background.buffer);
        const { png } = await renderFrame({ ...spec, data }, still || null);
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

function describeEntry(entry) {
    return {
        id: entry.historyId,
        createdAt: entry.createdAt,
        mode: entry.mode,
        layout: entry.layout,
        caption: entry.caption || null,
        type: entry.type,
        bytes: entry.bytes,
        manual: Boolean(entry.manual),
        downgraded: entry.downgraded || null
    };
}

// GET /banner/status — what is on the server, when it changes next, what stops it
router.get('/status', async (req, res, next) => {
    try {
        const guild = req.guild;
        const [{ banner }, state, background] = await Promise.all([
            GuildSettingsService.get(guild.id),
            BannerStore.getState(guild.id),
            BannerStore.readDoc(guild.id, 'background')
        ]);
        const lastPublishedAt = state.lastPublishedAt || null;
        const last = Math.max(Date.parse(lastPublishedAt || 0) || 0, Date.parse(state.lastAttemptAt || 0) || 0);
        res.json({
            enabled: banner.enabled,
            lastPublishedAt,
            nextAt: banner.enabled && last ? new Date(last + banner.intervalMin * 60 * 1000).toISOString() : null,
            lastError: state.lastError || null,
            lastSkip: state.lastSkip ? { code: state.lastSkip, message: REASONS[state.lastSkip] || null } : null,
            current: state.current || null,
            boost: {
                tier: guild.premiumTier,
                banner: guild.features.includes('BANNER'),
                animated: guild.features.includes('ANIMATED_BANNER')
            },
            background: background ? {
                name: background.name, bytes: background.bytes, type: background.type, animated: background.animated, uploadedAt: background.uploadedAt
            } : null
        });
    } catch (error) {
        next(error);
    }
});

// POST /banner/publish — «Обновить сейчас»: built and uploaded in the background (TaskTray)
router.post('/publish', async (req, res, next) => {
    try {
        const guild = req.guild;
        const state = await BannerStore.getState(guild.id);
        if (state.lastManualAt && Date.now() - Date.parse(state.lastManualAt) < MANUAL_EVERY_MS) {
            return res.status(429).json({ error: 'too_soon' });
        }
        const actor = actorOf(req);
        const started = await TaskService.start({
            guildId: guild.id,
            kind: 'banner.publish',
            title: 'Баннер сервера',
            actorId: actor.id,
            exec: async hooks => {
                hooks.onStart(1);
                const result = await publisher.publish(guild, { manual: true, actor });
                return result.ok
                    ? { ok: true, done: ['banner'], failed: [], historyId: result.entry.historyId }
                    : { ok: true, done: [], failed: [{ userId: 'banner', code: result.code }] };
            }
        });
        if (!started.ok) return res.status(400).json({ error: started.code });
        res.status(202).json({ ok: true, task: started.task });
    } catch (error) {
        next(error);
    }
});

// GET /banner/history — the last banners, newest first
router.get('/history', async (req, res, next) => {
    try {
        const [entries, state] = await Promise.all([BannerStore.listHistory(req.guild.id), BannerStore.getState(req.guild.id)]);
        res.json({ items: entries.map(describeEntry), currentId: state.current?.historyId || null });
    } catch (error) {
        next(error);
    }
});

// GET /banner/history/:id/image[?thumb=1] — the banner itself or its small picture
router.get('/history/:id/image', async (req, res, next) => {
    try {
        const entry = await BannerStore.getHistory(req.guild.id, req.params.id);
        if (!entry) return res.status(404).json({ error: 'not_found' });
        const thumb = req.query.thumb === '1' && entry.thumb;
        const buffer = await BannerStore.readFile(req.guild.id, thumb ? entry.thumb : entry.file);
        if (!buffer) return res.status(404).json({ error: 'not_found' });
        res.set({ 'Content-Type': thumb ? 'image/png' : entry.type, 'Cache-Control': 'private, max-age=86400' });
        res.send(buffer);
    } catch (error) {
        next(error);
    }
});

// POST /banner/history/:id/restore — put that banner back on the server
router.post('/history/:id/restore', async (req, res, next) => {
    try {
        const result = await publisher.restore(req.guild, req.params.id, { actor: actorOf(req) });
        if (!result.ok) return res.status(result.code === 'not_found' ? 404 : 400).json({ error: result.code, message: result.message || null });
        res.json({ ok: true, item: describeEntry(result.entry) });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
