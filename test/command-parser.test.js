// Standalone test (no test framework configured): run with `node test/command-parser.test.js`
// The command bar's parser (desktop/renderer/commands.js, an ES module with no imports).

const assert = require('assert');
const path = require('path');
const fs = require('fs');

(async () => {
    // The renderer's package is CommonJS for Node, so load the module from its source
    const source = fs.readFileSync(path.join(__dirname, '../desktop/renderer/commands.js'), 'utf8');
    const { parseCommand, parseDuration, matchDuration, durationLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

    const H = 60 * 60 * 1000;
    assert.strictEqual(parseDuration('1ч'), H);
    assert.strictEqual(parseDuration('10м'), 10 * 60 * 1000);
    assert.strictEqual(parseDuration('7д'), 7 * 24 * H);
    assert.strictEqual(parseDuration('30d'), 30 * 24 * H);
    assert.strictEqual(parseDuration('1 h'), H);
    assert.strictEqual(parseDuration('флуд'), null);
    assert.strictEqual(parseDuration('0ч'), null);

    // Not a command: a plain search
    assert.strictEqual(parseCommand('Борис'), null);
    assert.strictEqual(parseCommand('мутный'), null, 'a word starting with «мут» is not «мут»');

    assert.deepStrictEqual(parseCommand('мут @Борис 1ч флуд в чате'),
        { kind: 'mute', member: 'Борис', durationMs: H, durationText: '1ч', reason: 'флуд в чате', missing: null });
    assert.deepStrictEqual(parseCommand('мут "Ayla Vanel" 1 ч'),
        { kind: 'mute', member: 'Ayla Vanel', durationMs: H, durationText: '1 ч', reason: null, missing: null });
    assert.strictEqual(parseCommand('мут @Борис').missing, 'срок');
    assert.strictEqual(parseCommand('мут').missing, 'ник');
    assert.strictEqual(parseCommand('МУТ <@400000000000000003> 10м').member, '400000000000000003');

    assert.deepStrictEqual(parseCommand('бан @spam'), { kind: 'ban', member: 'spam', durationMs: null, durationText: null, reason: null, missing: null }, 'a ban without a term is forever');
    assert.strictEqual(parseCommand('бан @spam 7д реклама').reason, 'реклама');
    assert.deepStrictEqual(parseCommand('снять мут @Борис'), { kind: 'unmute', member: 'Борис', missing: null });
    assert.deepStrictEqual(parseCommand('варн @Гриша оскорбления'), { kind: 'warn', member: 'Гриша', missing: null, reason: 'оскорбления' });
    assert.strictEqual(parseCommand('кик @Гриша').reason, null);

    assert.strictEqual(parseCommand('пропустить @Вика девушка').gender, 'female');
    assert.strictEqual(parseCommand('пропустить @Тимур п').gender, 'male');
    assert.strictEqual(parseCommand('пропустить @Тимур').missing, 'парень или девушка');

    assert.strictEqual(parseCommand('бустер @boost01 30д').durationMs, 30 * 24 * H);

    assert.deepStrictEqual(parseCommand('перенести Болталка в Мафия — лобби'), { kind: 'move', from: 'Болталка', to: 'Мафия — лобби', missing: null });
    assert.strictEqual(parseCommand('перенести Болталка').missing, 'куда');
    assert.deepStrictEqual(parseCommand('lockdown'), { kind: 'lockdown' });
    assert.deepStrictEqual(parseCommand('журнал @Борис'), { kind: 'journal', member: 'Борис', missing: null });

    const mutes = [{ id: '10m', ms: 600000 }, { id: '1h', ms: H }];
    assert.strictEqual(matchDuration(H, mutes).id, '1h');
    assert.strictEqual(matchDuration(2 * H, mutes), null);
    assert.strictEqual(durationLabel(H), '1 ч');
    assert.strictEqual(durationLabel(null), 'навсегда');
    console.log('command parser tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
