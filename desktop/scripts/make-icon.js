// Generates the 256×256 app icon: a violet entry pass with a punched
// notch and a check mark. Pure Node (zlib) so no image tooling is needed.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const VIOLET = [124, 108, 242];
const WHITE = [255, 255, 255];

// Signed distance helpers (negative = inside)
function roundedRect(x, y, cx, cy, hw, hh, r) {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function circle(x, y, cx, cy, r) {
    return Math.hypot(x - cx, y - cy) - r;
}
function segment(x, y, ax, ay, bx, by, w) {
    const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - dx * t, py - dy * t) - w;
}
const coverage = d => Math.max(0, Math.min(1, 0.5 - d));

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        const px = x + 0.5, py = y + 0.5;
        // Pass body minus two side notches (a ticket)
        let body = roundedRect(px, py, 128, 128, 112, 84, 22);
        body = Math.max(body, -circle(px, py, 16, 128, 22), -circle(px, py, 240, 128, 22));
        const check = Math.min(
            segment(px, py, 84, 130, 114, 160, 13),
            segment(px, py, 114, 160, 174, 98, 13)
        );
        const a = coverage(body);
        const c = coverage(check) * a;
        const i = (y * SIZE + x) * 4;
        for (let k = 0; k < 3; k++) pixels[i + k] = Math.round(VIOLET[k] * (1 - c) + WHITE[k] * c);
        pixels[i + 3] = Math.round(a * 255);
    }
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;  // bit depth
header[9] = 6;  // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);

// App/installer icon + the copy the UI shows (Vite serves renderer/public as-is)
for (const out of [
    path.join(__dirname, '..', 'electron', 'assets', 'icon.png'),
    path.join(__dirname, '..', 'renderer', 'public', 'icon.png')
]) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    console.log(`Wrote ${out} (${png.length} bytes)`);
}
