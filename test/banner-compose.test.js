// Standalone test (no test framework configured): run with `node test/banner-compose.test.js`
// The ffmpeg pass: every frame of the GIF keeps moving, only the piece under the glass panel
// is blurred, the file fits the limit (fewer fps, then fewer colors), a still background or a
// server without the 3rd boost level gets one PNG.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { composeBanner, firstFrame, filterGraph, ladderFor, ComposeError } = require('../src/banner/compose');
const { renderCard } = require('../src/banner/render');
const { sampleData } = require('../src/banner/data');
const { resolveBanner } = require('../src/banner/settings');

const BANNER = resolveBanner(undefined);
const W = 960;
const H = 540;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-compose-test-'));

/** A busy GIF of ffmpeg's test pattern, 10 fps (with noise: one that compresses badly) */
function testGif(size = `${W}x${H}`, seconds = 2, noise = false) {
    const out = path.join(dir, `src-${size}-${seconds}-${noise}.gif`);
    const source = `testsrc2=size=${size}:rate=10${noise ? ',noise=alls=40:allf=t' : ''}`;
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-t', String(seconds), out]);
    return fs.readFileSync(out);
}

/** Frame n as raw RGB */
function frame(buffer, n = 0) {
    const file = path.join(dir, `frame-${Math.random()}.gif`);
    fs.writeFileSync(file, buffer);
    return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=${W}:${H}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
}

function countFrames(buffer) {
    const file = path.join(dir, `c-${Math.random()}.gif`);
    fs.writeFileSync(file, buffer);
    const log = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const matches = [...log.matchAll(/frame=\s*(\d+)/g)];
    return Number(matches[matches.length - 1][1]);
}

/** Mean difference of a region between two RGB frames */
function diff(a, b, x1, y1, x2, y2) {
    let sum = 0;
    let n = 0;
    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
            for (let c = 0; c < 3; c++) {
                const i = (y * W + x) * 3 + c;
                sum += Math.abs(a[i] - b[i]);
                n++;
            }
        }
    }
    return sum / n;
}

function graph() {
    const rect = { x1: 28, y1: 130, x2: 752, y2: 454 };
    const glass = filterGraph({ rect, blur: 20, fps: null, colors: 256 });
    assert.ok(glass.includes('crop=724:324:28:130,gblur=sigma=20'), glass);
    assert.ok(glass.includes('[blurred][mask]alphamerge') && glass.includes('overlay=28:130'));
    assert.ok(glass.includes('palettegen=max_colors=256') && glass.includes('paletteuse'));
    assert.ok(!glass.includes('fps='));
    // Shares of the GIF's own frame rate; a 10 fps GIF is never sped up
    assert.deepStrictEqual(ladderFor(10).map(step => [step.fps, step.colors]), [[null, 256], [null, 256], [null, 128], [7, 128], [5, 128], [5, 64], [4, 64]]);
    assert.deepStrictEqual(ladderFor(4).map(step => step.fps), [null, null, null, null], 'already at the floor: only colors and dithering change');
    assert.ok(filterGraph({ rect: null, blur: 0, fps: null, colors: 64, dither: 'bayer:bayer_scale=5' }).includes('dither=bayer:bayer_scale=5'));
    const bare = filterGraph({ rect: null, blur: 20, fps: 12, colors: 128 });
    assert.ok(!bare.includes('gblur') && !bare.includes('[3:v]') && bare.includes('fps=12') && bare.includes('max_colors=128'));
}

async function animated() {
    const gif = testGif();
    const spec = { mode: 'leader', layout: 'left', backing: 'glass', blur: 20, dim: 0.85, data: sampleData('leader', BANNER) };
    const result = await composeBanner({ spec, background: gif });
    assert.strictEqual(result.type, 'image/gif');
    assert.strictEqual(result.buffer.slice(0, 3).toString('latin1'), 'GIF');
    assert.deepStrictEqual([result.fps, result.colors], [null, 256], 'fits without cutting');
    assert.strictEqual(countFrames(result.buffer), countFrames(gif), 'every frame is kept');

    const source = frame(gif, 5);
    const out = frame(result.buffer, 5);
    const { rect } = await renderCard(spec);
    // Bottom right: no darkening, no card → the background as is (palette rounding aside)
    assert.ok(diff(source, out, 820, 470, 950, 535) < 12, `outside the panel the GIF is sharp (${diff(source, out, 820, 470, 950, 535)})`);
    // The panel's top strip: blurred, darker, tinted — far from the source
    assert.ok(diff(source, out, rect.x1 + 40, rect.y1 + 6, rect.x2 - 40, rect.y1 + 16) > 25, 'under the panel the GIF is blurred');
    // Still moving: two frames differ outside the panel
    assert.ok(diff(frame(result.buffer, 0), frame(result.buffer, 15), 760, 0, 950, 540) > 3, 'the animation keeps playing');

    // A GIF that isn't 16:9 is cropped to fill 960×540
    const square = await composeBanner({ spec: { ...spec, backing: 'none' }, background: testGif('600x600', 1) });
    assert.strictEqual(frame(square.buffer, 0).length, W * H * 3);
}

async function sizeLimit() {
    const gif = testGif();
    const spec = { mode: 'podium', layout: 'center', backing: 'solid', blur: 0, dim: 0.85, data: sampleData('podium', BANNER) };
    const full = await composeBanner({ spec, background: gif });
    // A limit just under the full file: fewer fps / colors until it fits
    const cut = await composeBanner({ spec, background: gif, maxBytes: full.bytes - 1 });
    assert.ok(cut.bytes < full.bytes, `cut to ${cut.fps} fps / ${cut.colors} colors`);
    assert.ok(cut.fps !== null || cut.colors < 256 || cut.bytes < full.bytes);
    // A limit only the still frame fits: an error, or for publishing the first frame and the reason
    const noisy = testGif(`${W}x${H}`, 1, true);
    const { bytes: stillBytes } = await composeBanner({ spec, background: noisy, animated: false });
    await assert.rejects(composeBanner({ spec, background: noisy, maxBytes: stillBytes }), error => error instanceof ComposeError && error.code === 'too_large');
    const still = await composeBanner({ spec, background: noisy, maxBytes: stillBytes, stillIfTooLarge: true });
    assert.deepStrictEqual([still.type, still.downgraded], ['image/png', 'too_large']);
    assert.ok(still.smallestAnimatedBytes > stillBytes);
}

async function still() {
    const gif = testGif();
    const spec = { mode: 'event', layout: 'right', backing: 'glass', blur: 20, dim: 0.85, data: sampleData('event', BANNER) };
    // No 3rd boost level: the first frame as PNG
    const first = await composeBanner({ spec, background: gif, animated: false });
    assert.strictEqual(first.type, 'image/png');
    assert.strictEqual(first.buffer[0], 0x89);
    // The first frame, cover-cropped: a square GIF still fills 960×540
    const frameOf = await firstFrame(testGif('600x600', 1));
    assert.deepStrictEqual([frameOf.readUInt32BE(16), frameOf.readUInt32BE(20)], [W, H]);
    // No background yet: the dark brand color, still a PNG
    const empty = await composeBanner({ spec, background: null });
    assert.strictEqual(empty.type, 'image/png');
}

(async () => {
    graph();
    await animated();
    await sizeLimit();
    await still();
    console.log('banner-compose.test.js: all passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
