/** Shared by the action routes: who acts, and service results → HTTP. */

function actorOf(req) {
    return { id: req.session.userId, tag: req.session.username };
}

/**
 * { ok: true, ...data } → 200 with the data; { ok: false, code } → the code's
 * status from `statuses` (400 when unknown) with { error: code }.
 */
function sendResult(res, result, statuses) {
    if (result.ok) return res.json(result);
    res.status(statuses[result.code] || 400).json({ error: result.code });
}

module.exports = { actorOf, sendResult };
