const express = require('express');
const GuildSettingsService = require('../../../services/GuildSettingsService');
const AuditLogService = require('../../../services/AuditLogService');
const { actorOf } = require('../result');
const { userRef } = require('../serialize');
const { getLeaders } = require('../../../banner/leaders');
const { collect, sampleData } = require('../../../banner/data');
const { renderFrame, RendererUnavailable } = require('../../../banner/render');
const { firstFrame, thumbnail, normalizeBackground, ComposeError } = require('../../../banner/compose');
const { imageType } = require('../../../banner/render');
const BannerStore = require('../../../banner/store');
const TaskService = require('../../../services/TaskService');
const { publisher, REASONS, MANUAL_EVERY_MS } = require('../../../banner/publisher');
const {
    MODES, LAYOUT_MODES, LAYOUTS, PERIODS, CALCS, BACKINGS, INTERVALS, MAX_BLUR, sanitizeBanner
} = require('../../../banner/settings');

// Mounted behind the administrators-only gate («старшая администрация»)
const router = express.Router({ mergeParams: true });

const RACE_SIZE = 3;
// An upload bigger than this is refused before it is decoded (it becomes 960×540 anyway)
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// The background's first frame and small picture, made once per background (ffmpeg on
// every slider move would be slow): backgroundId -> { still, thumb }
const backgroundCache = new Map();
const BACKGROUND_CACHE_SIZE = 20;

async function backgroundPictures(guildId) {
    const background = await BannerStore.getBackground(guildId);
    if (!background) return null;
    const key = `${guildId}:${background.meta.backgroundId}`;
    let entry = backgroundCache.get(key);
    if (!entry) {
        const gif = background.meta.type === 'image/gif';
        entry = { still: gif ? await firstFrame(background.buffer) : background.buffer, thumb: await thumbnail(background.buffer) };
        if (backgroundCache.size >= BACKGROUND_CACHE_SIZE) backgroundCache.delete(backgroundCache.keys().next().value);
        backgroundCache.set(key, entry);
    }
    return entry;
}

/** ffmpeg missing or not runnable on this host: a clear code for the panel instead of a 500 */
function rendererFailure(error, res) {
    const ffmpeg = error instanceof ComposeError && ['ffmpeg_unavailable', 'ffmpeg_failed'].includes(error.code);
    if (!(error instanceof RendererUnavailable) && !ffmpeg) return false;
    console.error('Banner:', error.message);
    res.status(503).json({ error: ffmpeg ? 'ffmpeg_unavailable' : 'renderer_unavailable' });
    return true;
}

function describeOptions() {
    return { modes: MODES, layoutModes: LAYOUT_MODES, layouts: LAYOUTS, periods: PERIODS, calcs: CALCS, backings: BACKINGS, intervals: INTERVALS, maxBlur: MAX_BLUR };
}

// GET /banner/settings
router.get('/settings', async (req, res, next) => {
    try {
        const { banner } = await GuildSettingsService.get(req.guild.id);
        res.json({ values: banner, options: describeOptions(), users: banner.exclude.users.map(id => userRef(req.guild, id)) });
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
        // Turned on only with a background: without one the bot has nothing to draw on
        if (result.banner.enabled && !banner.enabled && !(await BannerStore.readDoc(guild.id, 'background'))) {
            return res.status(400).json({ error: 'no_background', field: 'enabled' });
        }

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
        const mode = LAYOUT_MODES.includes(q.mode) || q.mode === 'background' ? q.mode : (settings.banner.mode === 'podium' ? 'podium' : 'leader');
        const banner = {
            ...settings.banner,
            period: PERIODS.includes(q.period) ? q.period : settings.banner.period,
            calc: CALCS.includes(q.calc) ? q.calc : settings.banner.calc
        };
        const blur = Number(q.blur);
        const dim = Number(q.dim);
        const spec = {
            mode,
            layout: LAYOUTS.includes(q.layout) ? q.layout : (banner.layouts[mode] || 'left'),
            backing: BACKINGS.includes(q.backing) ? q.backing : banner.backing,
            blur: q.blur !== undefined && blur >= 0 && blur <= MAX_BLUR ? blur : banner.blur,
            dim: q.dim !== undefined && dim >= 0 && dim <= 1 ? dim : banner.dim
        };

        let data = mode === 'background' ? {} : await collect(req.guild, { ...settings, banner }, mode);
        const sample = !data;
        if (sample) data = sampleData(mode, banner);

        // The uploaded background (its first frame), or the brand's dark color without one
        const pictures = await backgroundPictures(req.guild.id);
        const { png } = await renderFrame({ ...spec, data }, pictures?.still || null);
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Banner-Sample': sample ? '1' : '0' });
        res.send(png);
    } catch (error) {
        if (rendererFailure(error, res)) return;
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
                    : { ok: true, done: [], failed: [{ userId: 'banner', name: 'Баннер', code: result.code }] };
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

// POST /banner/background — the new background as the raw file (GIF, PNG, JPG or WebP, up to 15 MB);
// brought to 960×540 around the center once, here. X-File-Name: its name (URI-encoded)
router.post('/background', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res, next) => {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : null;
        if (!buffer || !buffer.length) return res.status(400).json({ error: 'empty_file' });
        if (!imageType(buffer)) return res.status(400).json({ error: 'bad_background' });
        let normalized;
        try {
            normalized = await normalizeBackground(buffer);
        } catch (error) {
            if (error.code === 'bad_background') return res.status(400).json({ error: 'bad_background' });
            if (rendererFailure(error, res)) return;
            throw error;
        }
        let name = 'background';
        try {
            name = decodeURIComponent(String(req.get('X-File-Name') || 'background')).replace(/[\\/\x00-\x1f]/g, '').slice(0, 120) || 'background';
        } catch {
            // keep the default name
        }
        const actor = actorOf(req);
        const meta = await BannerStore.saveBackground(req.guild.id, { ...normalized, name, actorId: actor.id });
        // The settings name the background in use (the file itself is described in the store)
        const { banner } = await GuildSettingsService.get(req.guild.id);
        await GuildSettingsService.update(req.guild.id, { banner: { ...banner, backgroundBlobId: meta.backgroundId } });
        await AuditLogService.log({
            guildId: req.guild.id, action: 'banner.background_changed', actorId: actor.id, actorTag: actor.tag,
            source: 'panel', details: { name: meta.name, bytes: meta.bytes, animated: meta.animated, originalBytes: buffer.length }
        });
        res.json({ ok: true, background: { name: meta.name, bytes: meta.bytes, type: meta.type, animated: meta.animated, uploadedAt: meta.uploadedAt } });
    } catch (error) {
        next(error);
    }
});

// GET /banner/background/image — the background's small picture (first frame)
router.get('/background/image', async (req, res, next) => {
    try {
        const pictures = await backgroundPictures(req.guild.id);
        if (!pictures) return res.status(404).json({ error: 'not_found' });
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.send(pictures.thumb);
    } catch (error) {
        if (rendererFailure(error, res)) return;
        next(error);
    }
});

// The upload's size limit is checked while the body is read, before the route runs
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'file_too_large' });
    next(error);
});

module.exports = router;
