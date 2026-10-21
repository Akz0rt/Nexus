const { satoriFonts } = require('./text');
const { WIDTH, HEIGHT, SAFE_ZONE, CHIP_TOP, buildCard, buildScrim } = require('./card');

// Loaded on first use: if the native resvg binary can't load on this host, only the
// banner fails (RendererUnavailable), never the rest of the panel API
let satoriFn = null;
let ResvgClass = null;
class RendererUnavailable extends Error {}

function satori() {
    if (!satoriFn) satoriFn = require('satori').default;
    return satoriFn;
}

function resvg(svg) {
    if (!ResvgClass) {
        try {
            ResvgClass = require('@resvg/resvg-js').Resvg;
        } catch (error) {
            throw new RendererUnavailable(`resvg failed to load: ${error.message}`);
        }
    }
    return new ResvgClass(svg, RESVG).render();
}

// No background uploaded yet: the dark brand color
const DEFAULT_BACKGROUND = '#0a1628';
const PANEL_RADIUS = 30;
// Text arrives from satori as paths: scanning the system's fonts would only cost ~130 ms a render
const RESVG = { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } };

async function toPng(tree) {
    const svg = await satori()(tree, { width: WIDTH, height: HEIGHT, fonts: satoriFonts() });
    const image = resvg(svg);
    return { png: image.asPng(), pixels: image.pixels };
}

/**
 * Where the panel ended up (its width follows the content): the row between the
 * panel's top edge and the chip holds nothing but the panel, so its first and last
 * painted pixels are the panel's sides.
 */
function panelRect(pixels, backing) {
    if (backing === 'none') return null;
    // Below the rounded corners, between the chip and the main band: only the panel there
    const y = CHIP_TOP + 50 + 12;
    const alphaAt = x => pixels[(y * WIDTH + x) * 4 + 3];
    let x1 = 0;
    while (x1 < WIDTH && alphaAt(x1) === 0) x1++;
    let x2 = WIDTH - 1;
    while (x2 > x1 && alphaAt(x2) === 0) x2--;
    if (x1 >= WIDTH) return null;
    // Bottom: the first empty row going down that column's middle
    const mid = Math.round((x1 + x2) / 2);
    let y2 = HEIGHT - 1;
    for (let row = y; row < HEIGHT; row++) {
        if (pixels[(row * WIDTH + mid) * 4 + 3] === 0) { y2 = row - 1; break; }
    }
    return { x1, y1: SAFE_ZONE, x2: x2 + 1, y2: y2 + 1 };
}

/**
 * The transparent card layer and the panel's rectangle (null without a panel).
 * @returns {Promise<{ png: Buffer, rect: { x1, y1, x2, y2 } | null }>}
 */
async function renderCard(spec) {
    const { png, pixels } = await toPng(buildCard(spec));
    return { png, rect: panelRect(pixels, spec.backing) };
}

async function renderScrim(spec) {
    return (await toPng(buildScrim(spec))).png;
}

function dataUri(buffer, type) {
    return `data:${type};base64,${buffer.toString('base64')}`;
}

function imageType(buffer) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
    if (buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

/**
 * One finished frame (the panel preview, or the static banner): background, the
 * blurred piece of it under a glass panel, the darkening, the card.
 * @param {object} spec - { mode, layout, backing, blur, dim, data }
 * @param {Buffer|null} background - PNG/JPEG/GIF (first frame), cover-cropped to 960×540
 * @returns {Promise<{ png: Buffer, rect: object|null }>}
 */
async function renderFrame(spec, background = null) {
    const [card, scrim] = await Promise.all([renderCard(spec), renderScrim(spec)]);
    const type = background && imageType(background);
    const bg = type
        ? `<image href="${dataUri(background, type)}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect width="${WIDTH}" height="${HEIGHT}" fill="${DEFAULT_BACKGROUND}"/>`;
    const blur = Math.max(0, Math.min(40, Number(spec.blur) || 0));
    const glass = spec.backing === 'glass' && card.rect && blur > 0;
    const { x1, y1, x2, y2 } = card.rect || {};
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>${glass ? `<clipPath id="panel"><rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="${PANEL_RADIUS}"/></clipPath>
<filter id="blur" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${blur}" edgeMode="duplicate"/><feColorMatrix type="saturate" values="1.4"/></filter>` : ''}</defs>
${bg}
${glass ? `<g clip-path="url(#panel)"><g filter="url(#blur)">${bg}</g></g>` : ''}
<image href="${dataUri(scrim, 'image/png')}" width="${WIDTH}" height="${HEIGHT}"/>
<image href="${dataUri(card.png, 'image/png')}" width="${WIDTH}" height="${HEIGHT}"/>
</svg>`;
    const png = resvg(svg).asPng();
    return { png, rect: card.rect };
}

module.exports = { RendererUnavailable, renderCard, renderScrim, renderFrame, panelRect, imageType, DEFAULT_BACKGROUND };
