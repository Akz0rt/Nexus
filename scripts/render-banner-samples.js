// Renders every banner variant with the mockup's data onto the mockup's background,
// for a side-by-side check against docs/banner/mockups/png:
//   node scripts/render-banner-samples.js   → docs/banner/renders/*.png + compare.html
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { MODES, LAYOUTS } = require('../src/banner/card');
const { renderFrame } = require('../src/banner/render');

const OUT = path.join(__dirname, '..', 'docs', 'banner', 'renders');
const FONTS = ['Regular', 'Bold', 'ExtraBold'].map(w => path.join(__dirname, '..', 'assets', 'fonts', `GolosText-${w}.ttf`));

// The stand-in «GIF» of the mockups (docs/banner/source/Banner.dc.html), as one frame
function mockBackground(artX = 0) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<rect width="960" height="540" fill="#0a1628"/>
<defs><pattern id="hexbg" width="84" height="96" patternUnits="userSpaceOnUse"><polygon points="42,4 78,25 78,67 42,88 6,67 6,25" fill="none" stroke="#1c4a7a" stroke-width="3"/></pattern></defs>
<rect width="960" height="540" fill="url(#hexbg)" opacity="0.7"/>
<g opacity="0.55"><circle cx="150" cy="300" r="90" fill="#2ec4ff"/><circle cx="420" cy="260" r="70" fill="#e84393"/><circle cx="300" cy="440" r="60" fill="#ff7a1a"/><circle cx="620" cy="380" r="80" fill="#5865f2"/><circle cx="860" cy="420" r="70" fill="#2ec4ff"/></g>
<g transform="translate(${artX} 0)">
<g fill="none" stroke="#163a63" stroke-width="3"><polygon points="760,40 860,98 860,214 760,272 660,214 660,98"/><polygon points="880,250 960,296 960,388 880,434 800,388 800,296"/><polygon points="620,300 690,340 690,420 620,460 550,420 550,340"/></g>
<g stroke="#08111f" stroke-width="6" stroke-linejoin="round"><polygon points="760,120 820,155 760,190 700,155" fill="#1f6fb8"/><polygon points="820,155 820,225 760,260 760,190" fill="#1a5c9c"/><polygon points="700,155 760,190 760,260 700,225" fill="#103e70"/></g>
<circle cx="760" cy="190" r="9" fill="#ffb020" opacity="0.8"/>
</g>
<g fill="none" stroke="#163a63" stroke-width="3"><polygon points="430,-40 510,6 510,98 430,144 350,98 350,6"/></g>
<g fill="#2ec4ff" opacity="0.18"><circle cx="600" cy="90" r="4"/><circle cx="900" cy="140" r="3"/><circle cx="700" cy="480" r="5"/><circle cx="120" cy="80" r="3"/></g>
<text x="936" y="520" text-anchor="end" font-size="18" font-family="Golos Text" fill="#3d5a80">[ваш GIF-фон]</text>
</svg>`;
    return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Golos Text' } }).render().asPng();
}

// Ids picked so the initials get the mockup's colors (pink, amber, green, blurple)
const MAKS = { id: '7', name: 'maks_lil', status: 'Заколдую' };
const VIKA = { id: '1', name: 'Вика' };
const GRISHA = { id: '2', name: 'Гриша' };
const SAMPLE = {
    leader: { user: MAKS, messages: 1240, minutes: 380, calc: 'combined', period: '24h' },
    podium: { period: '7d', places: [{ ...MAKS, score: 8420 }, { ...VIKA, score: 7910 }, { ...GRISHA, score: 6340 }] },
    birthday: { user: VIKA, channelName: 'поздравления' },
    event: {
        title: 'Мафия', when: 'СЕГОДНЯ · 21:00', host: 'Kira', place: 'Мафия — лобби', count: 6,
        attendees: [{ id: '2', name: 'a' }, { id: '1', name: 'b' }, { id: '7', name: 'c' }, { id: '3', name: 'd' }]
    }
};

function compareHtml(names) {
    const rows = names.map(name => `<section><h2>${name}</h2><div class="pair">
<figure><img src="../mockups/png/${name}.png"><figcaption>макет</figcaption></figure>
<figure class="stack"><img src="../mockups/png/${name}.png"><img class="over" src="${name}.png"><figcaption>наложение (ползунок)</figcaption></figure>
<figure><img src="${name}.png"><figcaption>рендер</figcaption></figure></div></section>`).join('\n');
    return `<!doctype html><meta charset="utf-8"><title>Баннер: макет и рендер</title>
<style>body{background:#0f1218;color:#c7d1dd;font:14px system-ui;margin:24px}h2{font-size:15px;margin:24px 0 8px}
.pair{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{width:100%;display:block}
.stack{position:relative}.stack .over{position:absolute;inset:0;opacity:var(--o,.5)}
.guides{position:fixed;top:12px;right:12px;background:#1a2230;padding:8px 12px;border-radius:8px}</style>
<div class="guides">наложение <input type="range" min="0" max="1" step="0.05" value="0.5" oninput="document.body.style.setProperty('--o',this.value)"></div>
<h1>Баннер — макет и рендер</h1>${rows}`;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const backgrounds = { left: mockBackground(0), center: mockBackground(0), right: mockBackground(-560) };
    const jobs = [];
    for (const mode of MODES) {
        for (const layout of LAYOUTS) jobs.push({ name: `banner-${mode}-${layout}`, spec: { mode, layout, backing: 'glass' } });
    }
    jobs.push({ name: 'banner-leader-left-solid', spec: { mode: 'leader', layout: 'left', backing: 'solid' } });
    jobs.push({ name: 'banner-leader-left-none', spec: { mode: 'leader', layout: 'left', backing: 'none' } });

    const started = Date.now();
    for (const { name, spec } of jobs) {
        const t0 = Date.now();
        const { png, rect } = await renderFrame({ blur: 20, dim: 0.85, ...spec, data: SAMPLE[spec.mode] }, backgrounds[spec.layout]);
        fs.writeFileSync(path.join(OUT, `${name}.png`), png);
        console.log(`${name}: ${Date.now() - t0} ms, panel ${rect ? `${rect.x1}–${rect.x2} × ${rect.y1}–${rect.y2}` : 'none'}`);
    }

    // Stress: a 32-character nick and a long status, all modes, left and center
    const longName = { id: '5', name: 'ОченьДлинныйНикУчастника_123456', status: 'Статус, который тоже никак не помещается в одну строку баннера' };
    for (const layout of LAYOUTS) {
        const { png } = await renderFrame({ mode: 'leader', layout, backing: 'glass', blur: 20, dim: 0.85, data: { ...SAMPLE.leader, user: longName, messages: 123456, minutes: 99999 } }, backgrounds[layout]);
        fs.writeFileSync(path.join(OUT, `stress-leader-${layout}.png`), png);
    }

    fs.writeFileSync(path.join(OUT, 'compare.html'), compareHtml(jobs.map(job => job.name)));
    console.log(`done in ${Date.now() - started} ms → ${OUT}`);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
