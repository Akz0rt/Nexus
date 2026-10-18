// Standalone test (no test framework configured): run with `node test/invites.test.js`
// Which invite brought a newcomer in: the one whose use count went up; the vanity
// link when only it grew; nothing when it can't be told; and the kick counter that
// survives a re-join.

const assert = require('assert');
const { InviteTracker, diffInvites } = require('../src/modules/invites/InviteTracker');

const map = entries => new Map(entries.map(([code, uses, inviterId, maxUses = 0]) => [code, { uses, inviterId, maxUses }]));

function diff() {
    assert.deepStrictEqual(diffInvites(map([['a', 3, 'lev'], ['b', 1, 'kira']]), map([['a', 3, 'lev'], ['b', 2, 'kira']])),
        { code: 'b', inviterId: 'kira', vanity: false });
    assert.deepStrictEqual(diffInvites(map([['a', 0, 'lev']]), map([['a', 0, 'lev'], ['new', 1, 'mira']])),
        { code: 'new', inviterId: 'mira', vanity: false }, 'an invite made after the snapshot');
    assert.deepStrictEqual(diffInvites(map([['once', 0, 'lev', 1]]), map([])),
        { code: 'once', inviterId: 'lev', vanity: false }, 'a one-use invite vanishes when used');
    assert.deepStrictEqual(diffInvites(map([['a', 1, 'lev']]), map([['a', 1, 'lev']]), { before: 10, after: 11 }),
        { code: null, inviterId: null, vanity: true });
    assert.strictEqual(diffInvites(map([['a', 1, 'lev'], ['b', 1, 'x']]), map([['a', 2, 'lev'], ['b', 2, 'x']])), null,
        'two at once: no guessing');
    assert.strictEqual(diffInvites(map([['a', 1, 'lev']]), map([['a', 1, 'lev']])), null, 'nothing grew');
}

function fakeGuild(lists) {
    let call = 0;
    return {
        id: 'g', vanityURLCode: null,
        invites: {
            fetch: async () => {
                const list = lists[Math.min(call++, lists.length - 1)];
                if (list === 'forbidden') throw new Error('Missing Permissions');
                return new Map(list.map(([code, uses, inviterId]) => [code, { code, uses, inviterId, maxUses: 0 }]));
            }
        }
    };
}

async function tracker() {
    const t = new InviteTracker();
    const guild = fakeGuild([[['a', 1, 'lev']], [['a', 2, 'lev']], [['a', 3, 'lev']]]);
    await t.snapshot(guild);
    const found = await t.onJoin({ guild, id: 'u1' });
    assert.strictEqual(found.inviterId, 'lev');
    assert.deepStrictEqual(t.joinOf('g', 'u1'), { code: 'a', inviterId: 'lev', vanity: false });
    assert.strictEqual(t.joinOf('g', 'nobody'), null);
    // Two joins at once are diffed one after the other, each against the previous snapshot
    const guild2 = fakeGuild([[['a', 0, 'lev'], ['b', 0, 'kira']], [['a', 1, 'lev'], ['b', 0, 'kira']], [['a', 1, 'lev'], ['b', 1, 'kira']]]);
    await t.snapshot(guild2);
    const [first, second] = await Promise.all([t.onJoin({ guild: guild2, id: 'x' }), t.onJoin({ guild: guild2, id: 'y' })]);
    assert.strictEqual(first.inviterId, 'lev');
    assert.strictEqual(second.inviterId, 'kira');

    const blind = new InviteTracker();
    const noRight = fakeGuild(['forbidden']);
    await blind.snapshot(noRight);
    assert.strictEqual(blind.canTrack('g'), false, 'Diagnostics learns the bot cannot see invites');
    assert.strictEqual(await blind.onJoin({ guild: noRight, id: 'z' }), null);
}

async function kickCounter() {
    const QueueCardService = require('../src/modules/verification/QueueCardService');
    const GuildSettingsService = require('../src/services/GuildSettingsService');
    const AuditLogService = require('../src/services/AuditLogService');
    const VerificationService = require('../src/modules/verification/VerificationService');

    const cards = new Map();
    QueueCardService.get = async (guildId, userId) => cards.get(userId) || null;
    QueueCardService.upsert = async card => { cards.set(card.userId, { ...card }); return card; };
    AuditLogService.log = async () => {};
    GuildSettingsService.get = async guildId => GuildSettingsService.resolve(guildId, {
        unverifiedRoleId: 'unv', maleRoleId: 'm', femaleRoleId: 'f', verifyQueueChannelId: 'q', modules: { verification: true }
    });
    VerificationService.safeRender = async () => {};
    VerificationService.assertPermission = async () => true;

    const member = {
        id: 'u', user: { bot: false, username: 'u' },
        roles: { cache: new Map([['unv', {}]]) },
        kick: async () => {}
    };
    const guild = { id: 'g', members: { cache: new Map([['u', member]]), fetch: async () => member } };
    VerificationService.fetchMember = async () => member;
    cards.set('u', { guildId: 'g', userId: 'u', status: 'pending', kickCount: 0 });
    const first = await VerificationService.kick(guild, 'u', 'спам', { id: 'mod' }, 'panel');
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    assert.strictEqual(cards.get('u').kickCount, 1);
    // Back on the server: a new queue card keeps the count
    cards.set('u', { ...cards.get('u') }); // status kicked
    const second = await VerificationService.kick(guild, 'u', 'снова', { id: 'mod' }, 'panel');
    assert.strictEqual(second.ok, true);
    assert.strictEqual(cards.get('u').kickCount, 2, 'kicks add up across re-joins');
}

(async () => {
    diff();
    await tracker();
    await kickCounter();
    console.log('invites tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
