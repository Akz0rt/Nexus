/**
 * Text and voice per member merged into one ranking. "both" scores a message
 * and a voice minute alike, as the old dashboard did.
 */
function mergeTop(textRows, voiceRows, mode) {
    const byUser = new Map();
    const row = (userId, sample) => {
        if (!byUser.has(userId)) {
            byUser.set(userId, { userId, displayName: sample.displayName || null, avatarURL: sample.avatarURL || null, messages: 0, minutes: 0 });
        }
        return byUser.get(userId);
    };
    if (mode !== 'voice') for (const r of textRows) row(r.userId, r).messages += Number(r.totalMessages || 0);
    if (mode !== 'text') for (const r of voiceRows) row(r.userId, r).minutes += Number(r.totalMinutes || 0);
    const score = r => (mode === 'text' ? r.messages : mode === 'voice' ? r.minutes : r.messages + r.minutes);
    return [...byUser.values()]
        .map(r => ({ ...r, score: score(r) }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score);
}

module.exports = { mergeTop };
