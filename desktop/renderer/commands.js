// The command bar's language: «мут @ник 1ч флуд», «пропустить @ник девушка», «перенести Болталка в Мафия».
// Pure functions, no React — test/command-parser.test.js imports this file as is.

const MINUTE_MS = 60 * 1000;
const UNITS = [
    [/^(м|мин|минут[аы]?|m|min)$/, MINUTE_MS],
    [/^(ч|час|часа|часов|h|hr)$/, 60 * MINUTE_MS],
    [/^(д|дн|день|дня|дней|d)$/, 24 * 60 * MINUTE_MS]
];

/** «10м», «1ч», «7 д», «30d» → ms; anything else → null */
export function parseDuration(text) {
    const match = /^(\d{1,4})\s*([a-zа-яё]+)$/i.exec(String(text || '').trim());
    if (!match) return null;
    const unit = UNITS.find(([re]) => re.test(match[2].toLowerCase()));
    const amount = Number(match[1]);
    return unit && amount > 0 ? amount * unit[1] : null;
}

// First word(s) → command; longer phrases first so «снять мут» wins over «мут».
// (?=\s|$), not \b: \b doesn't see Cyrillic letters as word characters
const VERBS = [
    [/^(снять\s+мут|размут|размутить|unmute)(?=\s|$)/i, 'unmute'],
    [/^(мут|замутить|mute|таймаут|timeout)(?=\s|$)/i, 'mute'],
    [/^(варн|пред|предупреждение|warn)(?=\s|$)/i, 'warn'],
    [/^(кик|кикнуть|kick)(?=\s|$)/i, 'kick'],
    [/^(бан|забанить|ban)(?=\s|$)/i, 'ban'],
    [/^(пропустить|пропуск|pass|approve)(?=\s|$)/i, 'pass'],
    [/^(бустер|буст|booster)(?=\s|$)/i, 'booster'],
    [/^(перенести|переместить|собрать|move)(?=\s|$)/i, 'move'],
    [/^(lockdown|локдаун)(?=\s|$)/i, 'lockdown'],
    [/^(журнал|лог|log)(?=\s|$)/i, 'journal']
];

const GENDERS = [[/^(парень|п|м|male|m)$/i, 'male'], [/^(девушка|д|ж|female|f)$/i, 'female']];

/** The member part: «"ник с пробелами"», «<@123>», «@ник» or one word; and what's left after it */
function takeMember(rest) {
    const text = rest.trim();
    if (!text) return { member: '', rest: '' };
    const quoted = /^["«]([^"»]+)["»]\s*(.*)$/s.exec(text);
    if (quoted) return { member: quoted[1].trim(), rest: quoted[2] };
    const mention = /^<@!?(\d{17,20})>\s*(.*)$/s.exec(text);
    if (mention) return { member: mention[1], rest: mention[2] };
    const [word, ...others] = text.split(/\s+/);
    return { member: word.replace(/^@/, ''), rest: others.join(' ') };
}

/**
 * What the typed text asks for, or null when it isn't a command (then it's a plain search).
 * { kind, member?, durationMs?, durationText?, reason?, gender?, from?, to?, missing? }
 * `missing` names the part still to type («ник», «срок», «парень или девушка», «куда»).
 */
export function parseCommand(input) {
    const text = String(input || '').trim();
    const verb = VERBS.find(([re]) => re.test(text));
    if (!verb) return null;
    const kind = verb[1];
    const rest = text.replace(verb[0], '').trim();

    if (kind === 'lockdown') return { kind };

    if (kind === 'move') {
        // «перенести Болталка в Мафия», «… -> …», «… → …». A channel name may hold « в » itself,
        // so every split is offered and the bar keeps the ones that match real channels
        const separator = /\s+(?:в|во|->|→|to)\s+/gi;
        const splits = [...rest.matchAll(separator)]
            .map(match => ({ from: rest.slice(0, match.index).trim(), to: rest.slice(match.index + match[0].length).trim() }))
            .filter(split => split.from && split.to);
        const from = splits[0]?.from || rest;
        const to = splits[0]?.to || '';
        return { kind, from, to, splits, missing: !from ? 'откуда' : !to ? 'куда' : null };
    }

    const { member, rest: after } = takeMember(rest);
    const base = { kind, member, missing: member ? null : 'ник' };
    if (!member) return base;
    const words = after.trim() ? after.trim().split(/\s+/) : [];

    if (kind === 'pass') {
        const gender = GENDERS.find(([re]) => re.test(words[0] || ''))?.[1] || null;
        return { ...base, gender, missing: gender ? null : 'парень или девушка' };
    }

    if (kind === 'mute' || kind === 'ban' || kind === 'booster') {
        // A duration may be written as «1ч» or «1 ч»
        let durationMs = parseDuration(words[0]);
        let used = durationMs ? 1 : 0;
        if (!durationMs && words.length > 1) {
            durationMs = parseDuration(`${words[0]}${words[1]}`);
            used = durationMs ? 2 : 0;
        }
        const durationText = words.slice(0, used).join(' ') || null;
        const reason = words.slice(used).join(' ') || null;
        // A ban without a term is forever; a mute and a booster term need one
        const missing = kind === 'ban' || durationMs ? null : 'срок';
        return { ...base, durationMs, durationText, reason, missing };
    }

    if (kind === 'warn' || kind === 'kick') return { ...base, reason: words.join(' ') || null };
    return base; // unmute, journal
}

/** The option whose length matches exactly (durations the bot knows), or null */
export function matchDuration(ms, options) {
    return (options || []).find(option => option.ms === ms) || null;
}

/** «1 ч», «7 дн.», «навсегда» for the previews */
export function durationLabel(ms) {
    if (!ms) return 'навсегда';
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes < 60) return `${minutes} мин`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} ч`;
    return `${Math.round(minutes / 1440)} дн.`;
}

/** Examples shown in the empty bar */
export const EXAMPLES = [
    { text: 'мут @ник 1ч флуд', note: 'мут со сроком и причиной' },
    { text: 'пропустить @ник девушка', note: 'пропуск, с «Отменить»' },
    { text: 'перенести Болталка в Мафия', note: 'всех из канала в канал' },
    { text: 'бустер @ник 30д', note: 'буст-аккаунт на срок' },
    { text: 'журнал @ник', note: 'всё про человека' }
];
