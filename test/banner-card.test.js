// Standalone test (no test framework configured): run with `node test/banner-card.test.js`
// The card layer of every mode × layout stands on the same grid (chip row at 150 px, main band
// 224–434 px, nothing in Discord's top 130 px), and no text leaves the panel or the banner,
// even with a 32-character nick.

const assert = require('assert');
const { Resvg } = require('@resvg/resvg-js');
const satori = require('satori').default;
const { MODES, LAYOUTS, WIDTH, HEIGHT, CHIP_TOP, buildCard, formatVoice, formatNumber, formatPoints } = require('../src/banner/card');
const { renderCard, renderFrame } = require('../src/banner/render');
const { satoriFonts, fit, measure } = require('../src/banner/text');
const { sampleData, eventWhen } = require('../src/banner/data');
const { resolveBanner } = require('../src/banner/settings');

const BANNER = resolveBanner(undefined);

async function pixelsOf(spec) {
    const svg = await satori(buildCard(spec), { width: WIDTH, height: HEIGHT, fonts: satoriFonts() });
    return new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
}

/** Painted rows and columns of a card layer */
function bounds(pixels) {
    let top = HEIGHT;
    let bottom = -1;
    let left = WIDTH;
    let right = -1;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            if (pixels[(y * WIDTH + x) * 4 + 3] > 8) {
                if (y < top) top = y;
                if (y > bottom) bottom = y;
                if (x < left) left = x;
                if (x > right) right = x;
            }
        }
    }
    return { top, bottom, left, right };
}

function formatting() {
    assert.strictEqual(formatNumber(1240), '1 240');
    assert.strictEqual(formatNumber(1234567), '1 234 567');
    assert.strictEqual(formatVoice(380), '6 ч 20');
    assert.strictEqual(formatVoice(120), '2 ч');
    assert.strictEqual(formatVoice(45), '45 мин');
    assert.strictEqual(formatPoints(8420), '8 420 очков');
    assert.strictEqual(formatPoints(1), '1 очко');
    assert.strictEqual(formatPoints(23), '23 очка');

    // Fits as is; shrinks; at 70 % it is cut with an ellipsis
    assert.deepStrictEqual(fit('maks_lil', { size: 78, weight: 800, maxWidth: 600 }), { text: 'maks_lil', size: 78 });
    const shrunk = fit('maks_lil_long', { size: 78, weight: 800, maxWidth: measure('maks_lil_long', 78, 800) * 0.8 });
    assert.ok(shrunk.size < 78 && shrunk.size >= 55 && shrunk.text === 'maks_lil_long');
    const cut = fit('x'.repeat(32), { size: 78, weight: 800, maxWidth: 300 });
    assert.ok(cut.text.endsWith('…') && cut.size === 55 && measure(cut.text, cut.size, 800) <= 300);
    assert.strictEqual(fit('abcdef', { size: 30, maxWidth: 1 }).size, 26, 'never smaller than 26 px');

    const tz = 'Europe/Moscow';
    const now = Date.parse('2026-10-21T10:00:00Z');
    assert.strictEqual(eventWhen('2026-10-21T18:00:00Z', tz, now), 'СЕГОДНЯ · 21:00');
    assert.strictEqual(eventWhen('2026-10-22T18:00:00Z', tz, now), 'ЗАВТРА · 21:00');
    assert.match(eventWhen('2026-10-24T18:00:00Z', tz, now), /^24 ОКТ.* · 21:00$/);
}

async function grid() {
    for (const mode of MODES) {
        for (const layout of LAYOUTS) {
            const name = `${mode}-${layout}`;
            const data = sampleData(mode, BANNER);
            // Without a panel the painted area is the content itself
            const bare = bounds(await pixelsOf({ mode, layout, backing: 'none', data }));
            assert.strictEqual(bare.top, CHIP_TOP, `${name}: the chip starts at 150 px (got ${bare.top})`);
            assert.ok(bare.bottom <= 440, `${name}: content ends by the main band (got ${bare.bottom})`);
            assert.ok(bare.left >= 40 && bare.right <= WIDTH - 40, `${name}: inside the banner (${bare.left}–${bare.right})`);

            // With the panel: 28 px from the edges, top at 130, nothing outside it
            const { rect } = await renderCard({ mode, layout, backing: 'glass', data });
            assert.strictEqual(rect.y1, 130, `${name}: panel top`);
            assert.ok(rect.x1 >= 28 && rect.x2 <= WIDTH - 28, `${name}: panel ${rect.x1}–${rect.x2}`);
            assert.ok(rect.y2 >= 450 && rect.y2 <= 460, `${name}: panel bottom ${rect.y2}`);
            if (layout === 'left') assert.strictEqual(rect.x1, 28, `${name}: left panel at 28 px`);
            if (layout === 'right') assert.strictEqual(rect.x2, WIDTH - 28, `${name}: right panel at 28 px from the edge`);
            if (layout === 'center') assert.ok(Math.abs(rect.x1 + rect.x2 - WIDTH) <= 2, `${name}: centered`);
        }
    }
}

async function longNick() {
    const nick = 'ОченьДлинныйНикУчастника_123456';
    assert.strictEqual([...nick].length, 31);
    const long = `${nick}7`;
    const person = { id: '5', name: long, status: 'Статус, который тоже никак не помещается в одну строку баннера' };
    const variants = {
        leader: { ...sampleData('leader', BANNER), user: person, messages: 123456, minutes: 43000 },
        podium: { period: '30d', places: [{ ...person, score: 1234567 }, { ...person, id: '6', score: 123456 }, { ...person, id: '8', score: 12345 }] },
        birthday: { user: person, more: 12, channelName: 'очень-длинный-канал-для-поздравлений' },
        event: { title: long, when: 'ЗАВТРА · 21:00', host: long, place: long, count: 1234, attendees: [person, person, person, person, person] }
    };
    for (const mode of MODES) {
        for (const layout of LAYOUTS) {
            const name = `${mode}-${layout} (32 chars)`;
            const spec = { mode, layout, backing: 'glass', data: variants[mode] };
            const { rect } = await renderCard(spec);
            assert.ok(rect.x1 >= 28 && rect.x2 <= WIDTH - 28, `${name}: panel ${rect.x1}–${rect.x2}`);
            assert.ok(rect.y2 <= 460, `${name}: panel bottom ${rect.y2}`);
            // Everything painted is inside the panel
            const painted = bounds(await pixelsOf(spec));
            assert.ok(painted.left >= rect.x1 && painted.right < rect.x2 && painted.top >= rect.y1 && painted.bottom < rect.y2,
                `${name}: painted ${JSON.stringify(painted)} outside panel ${JSON.stringify(rect)}`);
            const bare = bounds(await pixelsOf({ ...spec, backing: 'none' }));
            assert.ok(bare.left >= 28 && bare.right <= WIDTH - 28 && bare.top >= 130, `${name}: without a panel ${JSON.stringify(bare)}`);
        }
    }
}

async function frame() {
    const started = Date.now();
    const { png } = await renderFrame({ mode: 'leader', layout: 'left', backing: 'glass', blur: 20, dim: 0.85, data: sampleData('leader', BANNER) }, null);
    assert.ok(png.length > 1000 && png[0] === 0x89);
    assert.ok(Date.now() - started < 1000, 'a preview frame in under a second');

    // A GIF background (one red pixel, stretched): its first frame is drawn, not skipped
    const gif = Buffer.from('R0lGODlhAQABAPAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const withGif = await renderFrame({ mode: 'leader', layout: 'left', backing: 'glass', blur: 20, dim: 0.85, data: sampleData('leader', BANNER) }, gif);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><image href="data:image/png;base64,${withGif.png.toString('base64')}" width="${WIDTH}" height="${HEIGHT}"/></svg>`;
    const pixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
    const at = (x, y) => [...pixels.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
    assert.deepStrictEqual(at(940, 520), [255, 0, 0], 'outside the darkening the background shows as is');
}

(async () => {
    formatting();
    await grid();
    await longNick();
    await frame();
    console.log('banner-card.test.js: all passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
