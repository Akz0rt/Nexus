const { FAMILY, MIN_FONT_SIZE, fit, measure } = require('./text');

/**
 * The card layer of the server banner (docs/banner/README.md): one 960×540 picture,
 * the same grid for every mode and layout. Built as an element tree for satori;
 * no Discord here, only the data to show.
 */

const WIDTH = 960;
const HEIGHT = 540;
// Discord writes the server name over the top 130 px
const SAFE_ZONE = 130;
// The chip row and the main band: every mode and layout stands on these two lines
const CHIP_TOP = 150;
const CHIP_HEIGHT = 50;
const BAND_TOP = 224;
const BAND_HEIGHT = 210;
// The panel keeps 20 px above and below its content and 28 px at the sides (2 px of that is its outline)
const PANEL_BORDER = 2;
const PANEL_PAD_Y = 20 - PANEL_BORDER;
const PANEL_PAD_X = 28 - PANEL_BORDER;
const PANEL_MARGIN = 28;
const BARE_MARGIN = 56;
// The widest content can be and still leave the panel 28 px from the banner's edges
const CONTENT_MAX = WIDTH - 2 * (PANEL_MARGIN + PANEL_PAD_X + PANEL_BORDER);

const MODES = ['leader', 'podium', 'birthday', 'event'];
const LAYOUTS = ['left', 'center', 'right'];
const BACKINGS = ['glass', 'solid', 'none'];

const COLORS = {
    blue: '#2ec4ff',
    lightBlue: '#8ae6ff',
    orange: '#ff7a1a',
    amber: '#ffb020',
    pink: '#ff8cc6',
    text: '#ffffff',
    muted: '#c7d1dd',
    dim: '#aeb9c7',
    ink: '#0a1628'
};
// Initials when there is no avatar: a color picked by the member's ID
const AVATAR_COLORS = ['#e84393', '#ffb020', '#3ccf8e', '#5865f2', '#2ec4ff', '#ff7a1a', '#a55eea'];
const HEXAGON = 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)';
const PERIOD_LABELS = { '1h': '1 Ч', '2h': '2 Ч', '24h': '24 Ч', '7d': '7 ДН.', '30d': '30 ДН.' };

const ICONS = {
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>'
};

// ---- formatting ----

/** 1240 → «1 240» */
function formatNumber(value) {
    return String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Voice minutes: «6 ч 20», «6 ч», «45 мин» */
function formatVoice(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    if (total < 60) return `${total} мин`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${formatNumber(hours)} ч ${rest}` : `${formatNumber(hours)} ч`;
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

function formatPoints(score) {
    const n = Math.max(0, Math.round(Number(score) || 0));
    return `${formatNumber(n)} ${plural(n, 'очко', 'очка', 'очков')}`;
}

function chipText(mode, data) {
    if (mode === 'leader') return `САМЫЙ АКТИВНЫЙ · ${PERIOD_LABELS[data.period] || PERIOD_LABELS['24h']}`;
    if (mode === 'podium') return data.period === '7d' ? 'ТОП НЕДЕЛИ' : `ТОП ЗА ${PERIOD_LABELS[data.period] || PERIOD_LABELS['7d']}`;
    if (mode === 'birthday') return 'С ДНЁМ РОЖДЕНИЯ';
    return String(data.when || 'СКОРО').toUpperCase();
}

function avatarColor(id, name) {
    let hash = 0n;
    if (/^\d+$/.test(String(id || ''))) hash = BigInt(id);
    else for (const ch of String(name || '?')) hash = hash * 31n + BigInt(ch.codePointAt(0));
    return AVATAR_COLORS[Number(hash % BigInt(AVATAR_COLORS.length))];
}

function initial(name) {
    const letter = [...String(name || '?').replace(/^[^\p{L}\p{N}]+/u, '')][0] || '?';
    return letter.toUpperCase();
}

// ---- elements ----

function h(type, style, ...children) {
    const props = { style };
    const kids = children.flat().filter(child => child !== null && child !== undefined && child !== false);
    if (kids.length === 1) props.children = kids[0];
    else if (kids.length > 1) props.children = kids;
    return { type, props };
}

/** One line of text: fitted to its width, never wrapped */
function line(value, { size, weight = 400, color = COLORS.text, maxWidth = CONTENT_MAX, lineHeight = 1.2, letterSpacing = 0, align } = {}) {
    const fitted = fit(value, { size, weight, maxWidth, letterSpacing });
    return h('div', {
        display: 'flex',
        fontSize: fitted.size,
        fontWeight: weight,
        color,
        lineHeight,
        whiteSpace: 'nowrap',
        ...(letterSpacing ? { letterSpacing: `${letterSpacing}em` } : {}),
        ...(align ? { textAlign: align } : {})
    }, fitted.text);
}

function hexagon(label, { width, height, background, color = COLORS.ink, size }) {
    return h('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width, height, background, clipPath: HEXAGON,
        ...(label === undefined ? {} : { color, fontSize: size, fontWeight: 800 })
    }, label === undefined ? null : String(label));
}

function icon(name) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="${COLORS.lightBlue}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return { type: 'img', props: { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: 34, height: 34 } };
}

/** A round avatar (the Discord picture as a data URI, or initials) with an optional ring */
function avatar(person, size, { ring = 0, ringColor = COLORS.blue } = {}) {
    const style = {
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width: size, height: size, borderRadius: '50%', overflow: 'hidden',
        ...(ring ? { boxShadow: `0 0 0 ${ring}px ${ringColor}` } : {})
    };
    if (person?.avatar) {
        return h('div', style, { type: 'img', props: { src: person.avatar, width: size, height: size, style: { width: size, height: size, borderRadius: '50%', objectFit: 'cover' } } });
    }
    // Initials only where they stay readable (26 px and up); small ones are a plain color
    const letterSize = Math.round(size * 0.45);
    if (letterSize < MIN_FONT_SIZE) return h('div', { ...style, background: avatarColor(person?.id, person?.name) });
    return h('div', {
        ...style, background: avatarColor(person?.id, person?.name), color: COLORS.ink,
        fontSize: letterSize, fontWeight: 800, lineHeight: 1
    }, initial(person?.name));
}

/** Avatar with a badge pinned to it (the «1» hexagon, confetti) */
function pinned(base, size, badges) {
    return h('div', { display: 'flex', position: 'relative', width: size, height: size, flex: 'none' },
        base,
        badges.map(({ node, ...at }) => h('div', { display: 'flex', position: 'absolute', ...at }, node)));
}

function chip(mode, data, layout) {
    const tones = {
        leader: { color: COLORS.amber, border: COLORS.amber, background: 'rgba(255,176,32,0.12)' },
        podium: { color: COLORS.amber, border: COLORS.amber, background: 'rgba(255,176,32,0.12)' },
        birthday: { color: COLORS.pink, border: COLORS.pink, background: 'rgba(255,140,198,0.14)' },
        event: { color: COLORS.lightBlue, border: COLORS.blue, background: 'rgba(46,196,255,0.14)' }
    }[mode];
    const text = fit(chipText(mode, data), { size: 28, weight: 800, maxWidth: CONTENT_MAX - 44, letterSpacing: 0.08 });
    return h('div', {
        display: 'flex', alignItems: 'center', height: CHIP_HEIGHT, flex: 'none',
        padding: '0 20px', borderRadius: 999, border: `2px solid ${tones.border}`, background: tones.background,
        color: tones.color, fontSize: text.size, fontWeight: 800, letterSpacing: '0.08em', whiteSpace: 'nowrap',
        alignSelf: { left: 'flex-start', center: 'center', right: 'flex-end' }[layout]
    }, text.text);
}

function statBox(kind, value) {
    return h('div', {
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px', borderRadius: 16,
        background: 'rgba(46,196,255,0.14)', border: '2px solid rgba(46,196,255,0.5)'
    }, icon(kind), line(value, { size: 44, weight: 800, lineHeight: 1.2, maxWidth: 300 }));
}

/** Which numbers to show: «Сообщения» → messages, «Голос» → voice, «Вместе» → both */
function stats(data) {
    const calc = data.calc || 'combined';
    const list = [];
    if (calc !== 'voice') list.push({ kind: 'message', value: formatNumber(data.messages), label: 'сообщ.' });
    if (calc !== 'messages') list.push({ kind: 'mic', value: formatVoice(data.minutes), label: 'в голосе' });
    return list;
}

// ---- modes ----

function leader(data, layout) {
    const user = data.user || {};
    if (layout === 'center') {
        const badge = { node: hexagon('1', { width: 64, height: 56, background: COLORS.orange, size: 32 }), left: 66, bottom: -12 };
        return h('div', { display: 'flex', alignItems: 'center', gap: 36 },
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: 280, gap: 8 },
                line(user.name, { size: 64, weight: 800, lineHeight: 1, maxWidth: 280 }),
                user.status ? line(user.status, { size: 30, color: COLORS.muted, maxWidth: 280 }) : null),
            pinned(avatar(user, 196, { ring: 8 }), 196, [badge]),
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: 280, gap: 12 },
                stats(data).map(stat => h('div', { display: 'flex', alignItems: 'baseline', gap: 12 },
                    line(stat.value, { size: 52, weight: 800, maxWidth: 280 - 12 - Math.ceil(measure(stat.label, 26)) }),
                    line(stat.label, { size: 26, color: COLORS.lightBlue, maxWidth: 110 })))));
    }
    const reverse = layout === 'right';
    const align = reverse ? 'flex-end' : 'flex-start';
    const textWidth = CONTENT_MAX - 196 - 34;
    const badge = { node: hexagon('1', { width: 64, height: 56, background: COLORS.orange, size: 32 }), right: -6, bottom: -2 };
    return h('div', { display: 'flex', flexDirection: reverse ? 'row-reverse' : 'row', alignItems: 'center', gap: 34 },
        pinned(avatar(user, 196, { ring: 8 }), 196, [badge]),
        h('div', { display: 'flex', flexDirection: 'column', alignItems: align, gap: 6 },
            line(user.name, { size: 78, weight: 800, lineHeight: 1, maxWidth: textWidth }),
            user.status ? line(user.status, { size: 32, color: COLORS.muted, maxWidth: textWidth }) : null,
            h('div', { display: 'flex', flexDirection: reverse ? 'row-reverse' : 'row', gap: 14, marginTop: 14 },
                stats(data).map(stat => statBox(stat.kind, stat.value)))));
}

function podium(data, layout) {
    const [first, second, third] = data.places || [];
    if (layout === 'center') {
        const side = (place, rank) => h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 190, gap: 8 },
            avatar(place, 92, { ring: 5, ringColor: 'rgba(138,230,255,0.35)' }),
            line(place.name, { size: 36, weight: 700, lineHeight: 1.05, maxWidth: 190 }),
            h('div', { display: 'flex', alignItems: 'center', gap: 8 },
                hexagon(rank, { width: 30, height: 26, background: 'rgba(46,196,255,0.18)', color: COLORS.lightBlue, size: 16 }),
                line(formatNumber(place.score), { size: 26, color: COLORS.dim, maxWidth: 150 })));
        return h('div', { display: 'flex', alignItems: 'flex-end', height: BAND_HEIGHT, gap: 44 },
            second ? side(second, 2) : h('div', { display: 'flex', width: 190 }),
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 250, gap: 8 },
                avatar(first, 124, { ring: 7 }),
                line(first?.name, { size: 48, weight: 800, lineHeight: 1.05, maxWidth: 250 }),
                h('div', { display: 'flex', alignItems: 'center', gap: 8 },
                    hexagon(1, { width: 34, height: 30, background: COLORS.orange, size: 18 }),
                    line(formatNumber(first?.score), { size: 28, weight: 700, color: COLORS.lightBlue, maxWidth: 200 }))),
            third ? side(third, 3) : h('div', { display: 'flex', width: 190 }));
    }
    const reverse = layout === 'right';
    const direction = reverse ? 'row-reverse' : 'row';
    const align = reverse ? 'flex-end' : 'flex-start';
    const badge = { node: hexagon('1', { width: 56, height: 48, background: COLORS.orange, size: 28 }), right: -8, bottom: -4 };
    const row = (place, rank) => h('div', { display: 'flex', flexDirection: direction, alignItems: 'center', gap: 16 },
        hexagon(rank, { width: 40, height: 34, background: 'rgba(46,196,255,0.18)', color: COLORS.lightBlue, size: 22 }),
        avatar(place, 64),
        h('div', { display: 'flex', flexDirection: 'column', alignItems: align },
            line(place.name, { size: 36, weight: 700, lineHeight: 1.05, maxWidth: 170 }),
            line(formatNumber(place.score), { size: 26, color: COLORS.dim, maxWidth: 170 })));
    const rest = [second && row(second, 2), third && row(third, 3)].filter(Boolean);
    return h('div', { display: 'flex', flexDirection: direction, alignItems: 'center', gap: 40 },
        h('div', { display: 'flex', flexDirection: direction, alignItems: 'center', gap: 28 },
            pinned(avatar(first, 156, { ring: 7 }), 156, [badge]),
            h('div', { display: 'flex', flexDirection: 'column', alignItems: align, gap: 6 },
                line(first?.name, { size: 62, weight: 800, lineHeight: 1, maxWidth: 270 }),
                line(formatPoints(first?.score), { size: 32, weight: 700, color: COLORS.lightBlue, maxWidth: 270 }))),
        rest.length ? h('div', { display: 'flex', width: 3, height: 150, background: 'rgba(138,230,255,0.25)', borderRadius: 2 }) : null,
        rest.length ? h('div', { display: 'flex', flexDirection: 'column', alignItems: align, gap: 18 }, rest) : null);
}

function birthday(data, layout) {
    const user = data.user || {};
    const more = Number(data.more) || 0;
    const celebrates = more > 0 ? `сегодня празднует · и ещё ${more}` : 'сегодня празднует';
    const channel = data.channelName ? `#${data.channelName}` : null;
    if (layout === 'center') {
        const confetti = [
            { node: hexagon(undefined, { width: 22, height: 22, background: COLORS.pink }), left: -26, top: 6 },
            { node: hexagon(undefined, { width: 16, height: 16, background: COLORS.amber }), right: -30, top: 40 },
            { node: hexagon(undefined, { width: 26, height: 26, background: COLORS.blue }), right: -14, bottom: 4 }
        ];
        return h('div', { display: 'flex', alignItems: 'center', gap: 36 },
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: 280, gap: 6 },
                line(user.name, { size: 80, weight: 800, lineHeight: 1, maxWidth: 280 }),
                line(celebrates, { size: 30, color: COLORS.muted, maxWidth: 280 })),
            pinned(avatar(user, 196, { ring: 8, ringColor: COLORS.pink }), 196, confetti),
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: 280, gap: 6 },
                channel ? line('поздравь в', { size: 30, color: COLORS.muted, maxWidth: 280 }) : null,
                channel ? line(channel, { size: 34, weight: 800, color: COLORS.pink, maxWidth: 280 }) : null));
    }
    const reverse = layout === 'right';
    const textWidth = CONTENT_MAX - 196 - 34;
    return h('div', { display: 'flex', flexDirection: reverse ? 'row-reverse' : 'row', alignItems: 'center', gap: 34 },
        avatar(user, 196, { ring: 8, ringColor: COLORS.pink }),
        h('div', { display: 'flex', flexDirection: 'column', alignItems: reverse ? 'flex-end' : 'flex-start', gap: 10 },
            line(user.name, { size: 82, weight: 800, lineHeight: 1, maxWidth: textWidth }),
            line(celebrates, { size: 34, color: COLORS.muted, maxWidth: textWidth }),
            channel ? line(`поздравь в ${channel}`, { size: 34, weight: 700, color: COLORS.pink, maxWidth: textWidth }) : null));
}

function event(data, layout) {
    const align = { left: 'flex-start', center: 'center', right: 'flex-end' }[layout];
    const details = [data.host ? `ведущий ${data.host}` : null, data.place ? `сбор в «${data.place}»` : null].filter(Boolean).join(' · ');
    const shown = (data.attendees || []).slice(0, 4);
    const count = Math.max(Number(data.count) || 0, shown.length);
    const signed = count ? `${formatNumber(count)} ${plural(count, 'записался', 'записались', 'записались')}` : 'запись открыта';
    return h('div', { display: 'flex', flexDirection: 'column', alignItems: align, gap: 12 },
        line(data.title, { size: 86, weight: 800, lineHeight: 1 }),
        details ? line(details, { size: 30, color: COLORS.muted }) : null,
        h('div', { display: 'flex', flexDirection: layout === 'right' ? 'row-reverse' : 'row', alignItems: 'center', gap: 18, marginTop: 4 },
            shown.length ? h('div', { display: 'flex', paddingLeft: 16 },
                shown.map(person => h('div', { display: 'flex', marginLeft: -16 }, avatar(person, 52, { ring: 5, ringColor: COLORS.ink })))) : null,
            line(signed, { size: 36, weight: 700, maxWidth: 400 })));
}

const BODIES = { leader, podium, birthday, event };

/**
 * The card: chip + main band inside the panel (glass/solid) or on its own (none).
 * @param {{ mode: string, layout: string, backing: string, data: object }} spec
 */
function buildCard({ mode, layout, backing, data = {} }) {
    // «Только фон»: nothing over the background
    if (mode === 'background') return h('div', { display: 'flex', width: WIDTH, height: HEIGHT });
    const panel = backing !== 'none';
    const tone = backing === 'solid' ? 'rgba(10,18,32,0.86)' : 'rgba(10,18,32,0.42)';
    const margin = panel ? PANEL_MARGIN : BARE_MARGIN;
    const content = h('div', {
        display: 'flex', flexDirection: 'column', gap: BAND_TOP - CHIP_TOP - CHIP_HEIGHT,
        alignItems: { left: 'flex-start', center: 'center', right: 'flex-end' }[layout],
        ...(panel ? {
            padding: `${PANEL_PAD_Y}px ${PANEL_PAD_X}px`, borderRadius: 30,
            background: tone, border: `${PANEL_BORDER}px solid rgba(138,230,255,0.22)`
        } : {})
    },
        chip(mode, data, layout),
        h('div', { display: 'flex', alignItems: 'center', height: BAND_HEIGHT }, BODIES[mode](data, layout)));

    return h('div', {
        display: 'flex', position: 'relative', width: WIDTH, height: HEIGHT,
        fontFamily: FAMILY, color: COLORS.text
    },
        h('div', {
            display: 'flex', position: 'absolute', left: 0, top: panel ? SAFE_ZONE : CHIP_TOP, width: WIDTH,
            padding: `0 ${margin}px`,
            justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[layout]
        }, content));
}

/** The darkening behind the card; with a panel it is lighter (×0.45) */
function buildScrim({ mode, layout, backing, dim = 0.85 }) {
    if (mode === 'background') return h('div', { display: 'flex', width: WIDTH, height: HEIGHT });
    const d = Math.max(0, Math.min(1, Number(dim))) * (backing !== 'none' ? 0.45 : 1);
    const m = Math.round(d * 65) / 100;
    const c = alpha => `rgba(5,8,14,${alpha})`;
    const background = layout === 'center'
        ? `radial-gradient(ellipse 60% 62% at 50% 58%, ${c(d)} 0%, ${c(m)} 60%, ${c(Math.round(m * 40) / 100)} 100%)`
        : `linear-gradient(${layout === 'right' ? 270 : 90}deg, ${c(d)} 0%, ${c(m)} 48%, ${c(0)} 78%)`;
    return h('div', { display: 'flex', width: WIDTH, height: HEIGHT, background });
}

module.exports = {
    WIDTH, HEIGHT, SAFE_ZONE, CHIP_TOP, CHIP_HEIGHT, BAND_TOP, BAND_HEIGHT, PANEL_MARGIN, BARE_MARGIN,
    MODES, LAYOUTS, BACKINGS, PERIOD_LABELS,
    buildCard, buildScrim, chipText, formatNumber, formatVoice, formatPoints, avatarColor, initial
};
