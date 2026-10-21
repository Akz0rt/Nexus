// Discord avatars for the banner, as data URIs (satori draws them without fetching)
const FETCH_TIMEOUT_MS = 4000;
const MAX_CACHED = 100;

// URL → data URI. An avatar URL changes with the avatar, so a hit is never stale
const cache = new Map();

/**
 * The picture behind an avatar URL, or null (then the card draws initials).
 * @param {string|null} url
 */
async function avatarDataUri(url) {
    if (!url) return null;
    if (cache.has(url)) return cache.get(url);
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) return null;
        const type = response.headers.get('content-type') || 'image/png';
        if (!/^image\/(png|jpeg|webp|gif)/.test(type)) return null;
        const uri = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
        cache.set(url, uri);
        return uri;
    } catch {
        return null;
    }
}

/** A member as the card wants them: id, name, avatar */
async function person(member, extra = {}) {
    return {
        id: member.id,
        name: member.displayName,
        avatar: await avatarDataUri(member.user.displayAvatarURL({ size: 256, extension: 'png', forceStatic: true })),
        ...extra
    };
}

module.exports = { avatarDataUri, person };
