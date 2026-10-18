/**
 * Reads the rows of the old economy bot's MySQL dump (`INSERT INTO ... VALUES (...), (...);`).
 * A small tokenizer, not a split on "),(": the JSON inside the strings has brackets,
 * commas and escaped quotes of its own.
 */

const UNESCAPE = { n: '\n', r: '\r', t: '\t', 0: '\0', b: '\b', Z: '\x1a' };

/** One value starting at `i`: a quoted string, a number or NULL. @returns {[value, nextIndex]} */
function readValue(sql, i) {
    if (sql[i] === "'") {
        let out = '';
        i++;
        while (i < sql.length) {
            const ch = sql[i];
            if (ch === '\\') {
                const next = sql[i + 1];
                out += UNESCAPE[next] ?? next;
                i += 2;
            } else if (ch === "'" && sql[i + 1] === "'") {
                out += "'";
                i += 2;
            } else if (ch === "'") {
                return [out, i + 1];
            } else {
                out += ch;
                i++;
            }
        }
        throw new Error('Unterminated string in dump');
    }
    const match = /^(NULL|-?\d+(?:\.\d+)?)/i.exec(sql.slice(i, i + 40));
    if (!match) throw new Error(`Unexpected value at ${i}: ${sql.slice(i, i + 20)}`);
    const raw = match[1];
    return [/^null$/i.test(raw) ? null : Number(raw), i + raw.length];
}

const skipSpace = (sql, i) => {
    while (/\s/.test(sql[i] || '')) i++;
    return i;
};

/** Every row of every `INSERT INTO \`table\`` statement, as objects keyed by column. */
function parseInserts(sql, table) {
    const rows = [];
    const head = new RegExp(`INSERT INTO \`${table}\` \\(([^)]*)\\) VALUES\\s*`, 'g');
    let match;
    while ((match = head.exec(sql))) {
        const columns = match[1].split(',').map(c => c.trim().replace(/`/g, ''));
        let i = head.lastIndex;
        for (;;) {
            i = skipSpace(sql, i);
            if (sql[i] !== '(') throw new Error(`Expected "(" at ${i}`);
            i++;
            const values = [];
            for (;;) {
                i = skipSpace(sql, i);
                const [value, next] = readValue(sql, i);
                values.push(value);
                i = skipSpace(sql, next);
                if (sql[i] === ',') { i++; continue; }
                if (sql[i] === ')') { i++; break; }
                throw new Error(`Expected "," or ")" at ${i}`);
            }
            if (values.length !== columns.length) throw new Error(`Row has ${values.length} values for ${columns.length} columns`);
            rows.push(Object.fromEntries(columns.map((column, k) => [column, values[k]])));
            i = skipSpace(sql, i);
            if (sql[i] === ',') { i++; continue; }
            if (sql[i] === ';') break;
            throw new Error(`Expected "," or ";" at ${i}`);
        }
        head.lastIndex = i;
    }
    return rows;
}

module.exports = { parseInserts };
