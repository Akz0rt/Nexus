const fs = require('fs/promises');
const syncFs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { WIDTH, HEIGHT } = require('./card');
const { renderCard, renderScrim, renderMask, renderFrame, imageType } = require('./render');

/**
 * The finished banner. Discord shows it as a ready picture, so the blur and the card
 * are baked into every frame: one ffmpeg pass splits the GIF, blurs the piece under
 * the panel, rounds its corners, lays it back, then the darkening and the card, and
 * makes a palette so 256 colors don't band.
 */

// Discord's limit for a server banner is 10 MB; a little room for the request around it
const MAX_BANNER_BYTES = Math.floor(9.5 * 1024 * 1024);
const FFMPEG_TIMEOUT_MS = 120 * 1000;
// Too big → step down: ordered dithering (compresses far better than error diffusion),
// fewer colors, then a share of the GIF's own frames (never more than it has)
const LADDER = [
    { share: 1, colors: 256, dither: 'sierra2_4a' },
    { share: 1, colors: 256, dither: 'bayer:bayer_scale=5' },
    { share: 1, colors: 128, dither: 'bayer:bayer_scale=5' },
    { share: 2 / 3, colors: 128, dither: 'bayer:bayer_scale=5' },
    { share: 1 / 2, colors: 128, dither: 'bayer:bayer_scale=5' },
    { share: 1 / 2, colors: 64, dither: 'bayer:bayer_scale=5' },
    { share: 1 / 3, colors: 64, dither: 'bayer:bayer_scale=5' }
];
const MIN_FPS = 4;

class ComposeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

let resolvedFfmpeg = null;

/**
 * The ffmpeg binary, made runnable: the deploy's artifact upload doesn't keep file
 * permissions, so the execute bit may be gone. Then chmod it, or (read-only package)
 * run a chmodded copy from the temp folder.
 */
function ffmpegPath() {
    if (resolvedFfmpeg) return resolvedFfmpeg;
    let binary = null;
    try {
        binary = require('ffmpeg-static');
    } catch {
        // falls through
    }
    if (!binary || !syncFs.existsSync(binary)) throw new ComposeError('ffmpeg_unavailable', 'ffmpeg binary not found');
    if (process.platform === 'win32') return (resolvedFfmpeg = binary);
    const runnable = file => {
        try {
            syncFs.accessSync(file, syncFs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    };
    if (runnable(binary)) return (resolvedFfmpeg = binary);
    try {
        syncFs.chmodSync(binary, 0o755);
        if (runnable(binary)) return (resolvedFfmpeg = binary);
    } catch {
        // read-only: copy it below
    }
    try {
        const copy = path.join(os.tmpdir(), 'nexus-ffmpeg');
        if (!runnable(copy)) {
            syncFs.copyFileSync(binary, copy);
            syncFs.chmodSync(copy, 0o755);
        }
        if (runnable(copy)) return (resolvedFfmpeg = copy);
    } catch (error) {
        throw new ComposeError('ffmpeg_unavailable', `ffmpeg is not runnable: ${error.message}`);
    }
    throw new ComposeError('ffmpeg_unavailable', 'ffmpeg is not runnable');
}

function run(args) {
    return new Promise((resolve, reject) => {
        let binary;
        try {
            binary = ffmpegPath();
        } catch (error) {
            reject(error);
            return;
        }
        execFile(binary, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ');
                reject(new ComposeError('ffmpeg_failed', `${error.killed ? 'ffmpeg timed out' : 'ffmpeg failed'}: ${tail}`));
            } else resolve();
        });
    });
}

/** Frames and seconds of a GIF (decoded once, nothing written), for its real frame rate */
function probe(file) {
    return new Promise((resolve, reject) => {
        let binary;
        try {
            binary = ffmpegPath();
        } catch (error) {
            reject(error);
            return;
        }
        const child = spawn(binary, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
        let log = '';
        const timer = setTimeout(() => child.kill(), FFMPEG_TIMEOUT_MS);
        child.stderr.on('data', chunk => { log += chunk; });
        child.on('error', reject);
        child.on('close', () => {
            clearTimeout(timer);
            const frames = [...log.matchAll(/frame=\s*(\d+)/g)].pop();
            const time = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
            if (!frames) return reject(new ComposeError('bad_background', `ffmpeg can't read the background: ${log.trim().split('\n').pop()}`));
            const seconds = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0;
            resolve({ frames: Number(frames[1]), seconds, fps: seconds > 0 ? Number(frames[1]) / seconds : null });
        });
    });
}

/** The ladder for this GIF in frames per second (null = its own); steps that change nothing are dropped */
function ladderFor(sourceFps) {
    const steps = [];
    for (const { share, colors, dither } of LADDER) {
        let fps = null;
        if (share < 1) fps = sourceFps ? Math.max(MIN_FPS, Math.round(sourceFps * share)) : Math.max(MIN_FPS, Math.round(15 * share));
        if (fps && sourceFps && fps >= sourceFps - 0.5) fps = null;
        if (!steps.some(step => step.fps === fps && step.colors === colors && step.dither === dither)) steps.push({ fps, colors, dither });
    }
    return steps;
}

/**
 * The first frame of a background, cover-cropped to 960×540, as PNG (for the still
 * banner and the panel's preview).
 */
async function firstFrame(background) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-frame-'));
    try {
        const input = path.join(dir, 'background');
        const output = path.join(dir, 'frame.png');
        await fs.writeFile(input, background);
        await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1',
            '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`, output]);
        return await fs.readFile(output);
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** A small PNG of a published banner for the panel's «История» (first frame, 320×180) */
async function thumbnail(buffer) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-thumb-'));
    try {
        const input = path.join(dir, 'banner');
        const output = path.join(dir, 'thumb.png');
        await fs.writeFile(input, buffer);
        await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', 'scale=320:180', output]);
        return await fs.readFile(output);
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * An uploaded background brought to 960×540 (cover-cropped to 16:9 around the center):
 * a GIF stays animated, a still picture becomes PNG. Done once on upload, so every
 * publish works on a small file.
 * @returns {Promise<{ buffer: Buffer, type: string, animated: boolean, frames: number }>}
 */
async function normalizeBackground(buffer) {
    const type = imageType(buffer);
    if (!type) throw new ComposeError('bad_background', 'not an image (GIF, PNG, JPG or WebP)');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-bg-'));
    try {
        const input = path.join(dir, 'upload');
        await fs.writeFile(input, buffer);
        const fit = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`;
        if (type === 'image/gif') {
            const { frames } = await probe(input);
            if (frames > 1) {
                const output = path.join(dir, 'background.gif');
                await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex',
                    `[0:v]${fit},split[a][b];[b]palettegen=stats_mode=diff[p];[a][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
                    '-loop', '0', '-f', 'gif', output]);
                return { buffer: await fs.readFile(output), type: 'image/gif', animated: true, frames };
            }
        }
        const output = path.join(dir, 'background.png');
        await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', fit, output]);
        return { buffer: await fs.readFile(output), type: 'image/png', animated: false, frames: 1 };
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * The ffmpeg filter graph. Inputs: 0 background, 1 darkening, 2 card, 3 panel mask
 * (only with glass). Pure, so tests read it without running ffmpeg.
 */
function filterGraph({ rect, blur, fps, colors, dither = 'sierra2_4a' }) {
    const parts = [];
    const fit = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1${fps ? `,fps=${fps}` : ''}`;
    if (rect) {
        const w = rect.x2 - rect.x1;
        const h = rect.y2 - rect.y1;
        parts.push(`[0:v]${fit},format=rgba,split=2[base][under]`);
        // The same blur and saturation as the preview (CSS blur radius = standard deviation)
        parts.push(`[under]crop=${w}:${h}:${rect.x1}:${rect.y1},gblur=sigma=${blur},format=yuv444p,eq=saturation=1.4,format=rgba[blurred]`);
        parts.push('[3:v]format=gray[mask]');
        parts.push('[blurred][mask]alphamerge[glass]');
        parts.push(`[base][glass]overlay=${rect.x1}:${rect.y1}:format=auto[backed]`);
    } else {
        parts.push(`[0:v]${fit},format=rgba[backed]`);
    }
    parts.push('[backed][1:v]overlay=0:0:format=auto[dimmed]');
    parts.push('[dimmed][2:v]overlay=0:0:format=auto,split=2[frames][forpalette]');
    parts.push(`[forpalette]palettegen=max_colors=${colors}:stats_mode=diff[palette]`);
    parts.push(`[frames][palette]paletteuse=dither=${dither}:diff_mode=rectangle`);
    return parts.join(';');
}

/**
 * Bakes the card into the background.
 * @param {{ spec: object, background: Buffer|null, animated?: boolean, maxBytes?: number, stillIfTooLarge?: boolean }} options
 *   spec: { mode, layout, backing, blur, dim, data }. animated: false (no 3rd boost level)
 *   or a still background → one PNG frame. stillIfTooLarge: a GIF that can't fit the limit
 *   becomes its first frame (downgraded: 'too_large') instead of an error.
 * @returns {Promise<{ buffer: Buffer, type: 'image/gif'|'image/png', bytes: number, fps: number|null, colors: number|null }>}
 */
async function composeBanner({ spec, background, animated = true, maxBytes = MAX_BANNER_BYTES, stillIfTooLarge = false }) {
    const type = background && imageType(background);
    if (!animated || type !== 'image/gif') {
        // A GIF goes in as its first frame only: the whole file inside an SVG can be huge
        const { png } = await renderFrame(spec, type === 'image/gif' ? await firstFrame(background) : background);
        if (png.length > maxBytes) throw new ComposeError('too_large', `still banner is ${png.length} bytes`);
        return { buffer: png, type: 'image/png', bytes: png.length, fps: null, colors: null };
    }

    const [card, scrim] = await Promise.all([renderCard(spec), renderScrim(spec)]);
    const blur = Math.max(0, Math.min(40, Number(spec.blur) || 0));
    const rect = spec.backing === 'glass' && blur > 0 ? card.rect : null;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-banner-'));
    try {
        const file = name => path.join(dir, name);
        await Promise.all([
            fs.writeFile(file('background.gif'), background),
            fs.writeFile(file('scrim.png'), scrim),
            fs.writeFile(file('card.png'), card.png),
            rect ? fs.writeFile(file('mask.png'), renderMask(rect.x2 - rect.x1, rect.y2 - rect.y1)) : null
        ]);

        const source = await probe(file('background.gif'));
        const steps = ladderFor(source.fps);
        let last = null;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const out = file('banner.gif');
            await run([
                '-hide_banner', '-loglevel', 'error', '-y',
                '-i', file('background.gif'),
                '-i', file('scrim.png'),
                '-i', file('card.png'),
                ...(rect ? ['-i', file('mask.png')] : []),
                '-filter_complex', filterGraph({ rect, blur, ...step }),
                '-loop', '0', '-f', 'gif', out
            ]);
            const buffer = await fs.readFile(out);
            last = buffer.length;
            if (buffer.length <= maxBytes) return { buffer, type: 'image/gif', bytes: buffer.length, fps: step.fps, colors: step.colors, sourceFps: source.fps };
            // Twice the limit or more: dithering and colors won't save that much, go to fewer frames
            if (buffer.length > 2 * maxBytes && step.fps === null) {
                const fewer = steps.findIndex((next, index) => index > i && next.fps !== null);
                if (fewer > i + 1) i = fewer - 1;
            }
        }
        if (!stillIfTooLarge) throw new ComposeError('too_large', `smallest animated banner is ${last} bytes (limit ${maxBytes})`);
        // Even the smallest step is over the limit: the first frame, and why
        const still = await composeBanner({ spec, background, animated: false, maxBytes });
        return { ...still, downgraded: 'too_large', smallestAnimatedBytes: last };
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = { composeBanner, firstFrame, thumbnail, normalizeBackground, filterGraph, ladderFor, ComposeError, MAX_BANNER_BYTES, LADDER };
