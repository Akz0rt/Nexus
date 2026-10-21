const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

// Golos Text (OFL), shipped with the bot: the server has no Segoe UI
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = { 400: 'GolosText-Regular.ttf', 700: 'GolosText-Bold.ttf', 800: 'GolosText-ExtraBold.ttf' };
const FAMILY = 'Golos Text';
// A nick that doesn't fit shrinks down to this share of its size, then gets an ellipsis
const MIN_SCALE = 0.7;
// Nothing on the banner is smaller: Discord shows it four times smaller in the sidebar
const MIN_FONT_SIZE = 26;
const ELLIPSIS = '…';

let fonts = null;

function load() {
    if (fonts) return fonts;
    fonts = {};
    for (const [weight, file] of Object.entries(FONT_FILES)) {
        const data = fs.readFileSync(path.join(FONT_DIR, file));
        fonts[weight] = { data, font: opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
    }
    return fonts;
}

/** The fonts in the shape satori takes */
function satoriFonts() {
    return Object.entries(load()).map(([weight, { data }]) => ({ name: FAMILY, data, weight: Number(weight), style: 'normal' }));
}

/** Width in px of one line, the way satori lays it out (kerning on, letterSpacing in em) */
function measure(text, size, weight = 400, letterSpacing = 0) {
    const { font } = load()[weight] || load()[400];
    const chars = [...String(text)];
    return font.getAdvanceWidth(String(text), size, { kerning: true }) + chars.length * letterSpacing * size;
}

/**
 * One line that never wraps: the size it fits at, down to 70 % (never under 26 px),
 * and past that cut with an ellipsis.
 * @returns {{ text: string, size: number }}
 */
function fit(text, { size, weight = 400, maxWidth, letterSpacing = 0, minScale = MIN_SCALE }) {
    const value = String(text ?? '');
    const width = measure(value, size, weight, letterSpacing);
    if (width <= maxWidth) return { text: value, size };

    const floor = Math.min(size, Math.max(MIN_FONT_SIZE, Math.ceil(size * minScale)));
    const scaled = Math.floor(size * maxWidth / width);
    if (scaled >= floor) return { text: value, size: scaled };

    const chars = [...value];
    let low = 0;
    let high = chars.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = chars.slice(0, mid).join('').trimEnd() + ELLIPSIS;
        if (measure(candidate, floor, weight, letterSpacing) <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return { text: chars.slice(0, low).join('').trimEnd() + ELLIPSIS, size: floor };
}

module.exports = { FAMILY, MIN_FONT_SIZE, satoriFonts, measure, fit };
