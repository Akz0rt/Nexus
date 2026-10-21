/**
 * HTTP + SSE client for /api/v2, running in the Electron main process so the
 * session token never reaches the renderer and the server needs no CORS.
 */

const RECONNECT_MS = 5000;

class ApiError extends Error {
    constructor(status, body) {
        super(body?.error || `HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}

/** Split an SSE text buffer into complete events; returns [events, rest]. */
function parseSse(buffer) {
    const events = [];
    const blocks = buffer.split(/\r?\n\r?\n/);
    const rest = blocks.pop();
    for (const block of blocks) {
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith(':')) continue; // comment / heartbeat
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) events.push({ event, data: data.join('\n') });
    }
    return [events, rest];
}

class ApiClient {
    /**
     * @param {string} baseUrl server origin
     * @param {() => string|null} getToken
     * @param {() => void} onUnauthorized called on 401 (session expired / revoked)
     */
    constructor(baseUrl, getToken, onUnauthorized) {
        this.baseUrl = baseUrl;
        this.getToken = getToken;
        this.onUnauthorized = onUnauthorized;
    }

    url(path) {
        if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..')) {
            throw new Error(`Invalid API path: ${path}`);
        }
        return `${this.baseUrl}/api/v2${path}`;
    }

    headers(extra = {}) {
        const token = this.getToken();
        return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
    }

    async request(method, path, body) {
        const res = await fetch(this.url(path), {
            method,
            headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401) this.onUnauthorized();
        if (!res.ok) throw new ApiError(res.status, data);
        return data;
    }

    /** A picture from the API (the banner's preview, history, background) as a data URL */
    async image(path) {
        const res = await fetch(this.url(path), { headers: this.headers() });
        if (res.status === 401) this.onUnauthorized();
        if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new ApiError(res.status, data);
        }
        const type = res.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await res.arrayBuffer());
        return { dataUrl: `data:${type};base64,${buffer.toString('base64')}`, sample: res.headers.get('x-banner-sample') === '1' };
    }

    /** A file sent as the raw request body (the banner background) */
    async upload(path, buffer, type, name) {
        const res = await fetch(this.url(path), {
            method: 'POST',
            headers: this.headers({ 'Content-Type': type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || 'file') }),
            body: buffer
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401) this.onUnauthorized();
        if (!res.ok) throw new ApiError(res.status, data);
        return data;
    }

    /**
     * Subscribe to a guild's live events. Reconnects until close() is called.
     * @param {(event: string, data: any) => void} onEvent
     * @param {(state: 'connecting'|'open'|'error'|'closed') => void} onState
     */
    stream(guildId, onEvent, onState) {
        let closed = false;
        let controller = null;
        let timer = null;

        const connect = async () => {
            if (closed) return;
            onState('connecting');
            controller = new AbortController();
            try {
                const res = await fetch(this.url(`/guilds/${encodeURIComponent(guildId)}/events`), {
                    headers: this.headers({ Accept: 'text/event-stream' }),
                    signal: controller.signal
                });
                if (res.status === 401) {
                    this.onUnauthorized();
                    closed = true;
                    onState('closed');
                    return;
                }
                if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

                onState('open');
                const decoder = new TextDecoder();
                let buffer = '';
                for await (const chunk of res.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const [events, rest] = parseSse(buffer);
                    buffer = rest;
                    for (const { event, data } of events) {
                        try {
                            onEvent(event, JSON.parse(data));
                        } catch {
                            // ignore malformed frame
                        }
                    }
                }
                throw new Error('stream ended'); // server restart / network drop
            } catch (error) {
                if (closed) return;
                onState('error');
                timer = setTimeout(connect, RECONNECT_MS);
            }
        };

        connect();
        return {
            close() {
                closed = true;
                clearTimeout(timer);
                controller?.abort();
                onState('closed');
            }
        };
    }
}

module.exports = { ApiClient, ApiError, parseSse };
