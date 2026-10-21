const express = require('express');
const crypto = require('node:crypto');
const config = require('../../config');
const PanelSessionService = require('../../services/PanelSessionService');

/**
 * Desktop-app login via Discord OAuth2 (scope identify) with PKCE:
 *   1. app opens the system browser on /auth/login?challenge=<S256(verifier)>
 *   2. Discord redirects to /auth/callback; we create a one-time code (60 s)
 *      and hand it to the app via APP_SCHEME://auth?code=...
 *   3. app POSTs /auth/token { code, verifier } and gets a session token.
 * A program intercepting the deep link can't redeem the code without the verifier.
 * State and codes live in memory — fine for the single App Service instance.
 */

const APP_SCHEME = 'birthdaybot-panel';
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const DISCORD_API = 'https://discord.com/api/v10';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function pkceChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class LoginFlowStore {
    constructor(now = () => Date.now()) {
        this.now = now;
        this.states = new Map(); // state -> { challenge, exp }
        this.codes = new Map();  // code -> { user, challenge, exp }
    }

    prune() {
        const t = this.now();
        for (const [key, value] of this.states) if (value.exp < t) this.states.delete(key);
        for (const [key, value] of this.codes) if (value.exp < t) this.codes.delete(key);
    }

    startLogin(challenge) {
        this.prune();
        const state = crypto.randomBytes(24).toString('base64url');
        this.states.set(state, { challenge, exp: this.now() + STATE_TTL_MS });
        return state;
    }

    /** One-shot: returns the challenge bound to this state, or null. */
    consumeState(state) {
        this.prune();
        const entry = this.states.get(state);
        this.states.delete(state);
        return entry ? entry.challenge : null;
    }

    issueCode(user, challenge) {
        this.prune();
        const code = crypto.randomBytes(24).toString('base64url');
        this.codes.set(code, { user, challenge, exp: this.now() + CODE_TTL_MS });
        return code;
    }

    /** One-shot: returns the Discord user if the verifier matches the login's challenge. */
    redeemCode(code, verifier) {
        this.prune();
        const entry = this.codes.get(code);
        this.codes.delete(code);
        if (!entry || !verifier) return null;
        return safeEqual(pkceChallenge(verifier), entry.challenge) ? entry.user : null;
    }
}

function isConfigured() {
    return Boolean(config.clientId && config.discordClientSecret && config.publicUrl);
}

function redirectUri() {
    return `${config.publicUrl}/api/v2/auth/callback`;
}

function bearerToken(req) {
    const header = req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function resultPage(title, body, deepLink) {
    const link = deepLink
        ? `<p><a href="${escapeHtml(deepLink)}">Открыть приложение</a></p><script>location.href=${JSON.stringify(deepLink)}</script>`
        : '';
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>' +
        `</head><body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>${link}</body></html>`;
}

async function exchangeCode(code) {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.discordClientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri()
        })
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
    const { access_token: accessToken } = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!userRes.ok) throw new Error(`Discord /users/@me failed: ${userRes.status}`);
    return userRes.json();
}

function createAuthRouter(store = new LoginFlowStore(), { onLogout = () => {} } = {}) {
    const router = express.Router();

    router.get('/login', (req, res) => {
        if (!isConfigured()) {
            return res.status(503).send(resultPage('Вход не настроен',
                'Задайте DISCORD_CLIENT_SECRET и PUBLIC_URL в настройках App Service.'));
        }
        const challenge = String(req.query.challenge || '');
        if (!CHALLENGE_RE.test(challenge)) {
            return res.status(400).send(resultPage('Ошибка входа', 'Откройте вход из приложения.'));
        }

        const params = new URLSearchParams({
            client_id: config.clientId,
            response_type: 'code',
            redirect_uri: redirectUri(),
            scope: 'identify',
            state: store.startLogin(challenge),
            prompt: 'none'
        });
        res.redirect(`https://discord.com/oauth2/authorize?${params}`);
    });

    router.get('/callback', async (req, res) => {
        const challenge = store.consumeState(String(req.query.state || ''));
        if (!challenge) {
            return res.status(400).send(resultPage('Ошибка входа', 'Ссылка устарела. Начните вход заново из приложения.'));
        }
        if (req.query.error || !req.query.code) {
            return res.status(400).send(resultPage('Вход отменён', 'Можно закрыть эту вкладку.'));
        }

        try {
            const user = await exchangeCode(String(req.query.code));
            const code = store.issueCode(
                { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar },
                challenge
            );
            res.send(resultPage('Вход выполнен', 'Возвращаемся в приложение — эту вкладку можно закрыть.',
                `${APP_SCHEME}://auth?code=${encodeURIComponent(code)}`));
        } catch (error) {
            console.error('Panel auth callback error:', error.message || error);
            res.status(502).send(resultPage('Ошибка входа', 'Discord не ответил. Попробуйте ещё раз.'));
        }
    });

    router.post('/token', async (req, res, next) => {
        try {
            const user = store.redeemCode(String(req.body?.code || ''), String(req.body?.verifier || ''));
            if (!user) return res.status(400).json({ error: 'invalid_code' });

            const { token, session } = await PanelSessionService.create(user);
            res.json({ token, user: publicUser(session) });
        } catch (error) {
            next(error);
        }
    });

    router.post('/logout', async (req, res, next) => {
        try {
            const token = bearerToken(req);
            await PanelSessionService.delete(token);
            onLogout(token);
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

function publicUser(session) {
    return {
        id: session.userId,
        username: session.username,
        globalName: session.globalName,
        avatarURL: session.avatar
            ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=128`
            : null
    };
}

module.exports = {
    APP_SCHEME,
    LoginFlowStore,
    pkceChallenge,
    isConfigured,
    bearerToken,
    publicUser,
    createAuthRouter
};
