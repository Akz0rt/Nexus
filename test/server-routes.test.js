// Standalone test (no test framework configured): run with `node test/server-routes.test.js`
// Starts the real Express app on an ephemeral port (no Discord, no Cosmos) and checks
// that the old dashboard stays behind Basic Auth while /api/v2 uses its own token auth.

const assert = require('assert');

const config = require('../src/config');
Object.assign(config, {
    adminUser: 'admin',
    adminPassword: 'secret',
    clientId: '111',
    discordClientSecret: 'shh',
    publicUrl: 'https://panel.example'
});

const PanelSessionService = require('../src/services/PanelSessionService');
PanelSessionService.get = async token => (token === 'good-token'
    ? { userId: '42', username: 'kira', globalName: 'Kira', avatar: null, createdAt: new Date().toISOString() }
    : null);

const { createApp } = require('../src/server');

async function run() {
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const basic = 'Basic ' + Buffer.from('admin:secret').toString('base64');

    try {
        // Old dashboard: unchanged, Basic Auth
        assert.strictEqual((await fetch(`${base}/`)).status, 401);
        const dash = await fetch(`${base}/`, { headers: { Authorization: basic } });
        assert.strictEqual(dash.status, 200);
        assert.ok((await dash.text()).includes('<html'), 'dashboard HTML served');

        // New API: not challenged by Basic Auth, needs a bearer token
        const anon = await fetch(`${base}/api/v2/me`);
        assert.strictEqual(anon.status, 401);
        assert.strictEqual(anon.headers.get('www-authenticate'), null, 'no Basic Auth challenge on /api/v2');
        assert.strictEqual((await fetch(`${base}/api/v2/me`, { headers: { Authorization: basic } })).status, 401);
        assert.strictEqual((await fetch(`${base}/api/v2/me`, { headers: { Authorization: 'Bearer bad' } })).status, 401);

        const me = await fetch(`${base}/api/v2/me`, { headers: { Authorization: 'Bearer good-token' } });
        assert.strictEqual(me.status, 200);
        assert.strictEqual((await me.json()).user.id, '42');

        // Guild routes answer 503 while the bot isn't connected (no Discord here)
        const queue = await fetch(`${base}/api/v2/guilds/1/queue`, { headers: { Authorization: 'Bearer good-token' } });
        assert.strictEqual(queue.status, 503);

        // Login start: bad challenge rejected, good one redirects to Discord with state
        assert.strictEqual((await fetch(`${base}/api/v2/auth/login?challenge=short`)).status, 400);
        const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
        const login = await fetch(`${base}/api/v2/auth/login?challenge=${challenge}`, { redirect: 'manual' });
        assert.strictEqual(login.status, 302);
        const location = new URL(login.headers.get('location'));
        assert.strictEqual(location.origin + location.pathname, 'https://discord.com/oauth2/authorize');
        assert.strictEqual(location.searchParams.get('redirect_uri'), 'https://panel.example/api/v2/auth/callback');
        assert.strictEqual(location.searchParams.get('scope'), 'identify');
        assert.ok(location.searchParams.get('state'));

        // Callback with a forged state is refused; token exchange with a bogus code too
        assert.strictEqual((await fetch(`${base}/api/v2/auth/callback?state=forged&code=x`)).status, 400);
        const token = await fetch(`${base}/api/v2/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'nope', verifier: 'nope' })
        });
        assert.strictEqual(token.status, 400);

        // Unknown API route → JSON 404, not the dashboard
        assert.strictEqual((await fetch(`${base}/api/v2/nope`, { headers: { Authorization: 'Bearer good-token' } })).status, 404);

        // Secrets not set yet (deployed before Azure config): API says so, dashboard still works
        config.discordClientSecret = '';
        assert.strictEqual((await fetch(`${base}/api/v2/me`, { headers: { Authorization: 'Bearer good-token' } })).status, 503);
        assert.strictEqual((await fetch(`${base}/api/v2/auth/login?challenge=${challenge}`)).status, 503);
        assert.strictEqual((await fetch(`${base}/`, { headers: { Authorization: basic } })).status, 200);

        console.log('PASS: dashboard keeps Basic Auth, /api/v2 uses token auth');
    } finally {
        server.close();
    }
}

run().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
