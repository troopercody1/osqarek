// The public "web portion" of this Lavalink service.
//
// Lavalink itself has no home page: every route, including "/", requires the
// Authorization header (LAVALINK_PASSWORD), so a browser or a plain HTTP
// uptime monitor hitting the bare URL always gets a 401 — even when Lavalink
// is perfectly healthy. That's expected Lavalink behaviour, not a bug.
//
// This tiny Express app is what Render actually exposes on $PORT:
//   - GET/HEAD "/" and "/health" render views/status.ejs — no auth required,
//     a normal 200 either way, with the dot turning red if Lavalink's own
//     port isn't accepting connections.
//   - Everything else (all real Lavalink REST calls and the bot's
//     /v4/websocket connection) is forwarded straight to Lavalink on its
//     internal port, headers/body/Authorization untouched — Lavalink's own
//     authentication and behavior are completely unchanged.
const path = require('path');
const net = require('net');
const http = require('http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PUBLIC_PORT = Number(process.env.PORT) || 10000; // Render's assigned public port
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.LAVALINK_INTERNAL_PORT) || 2333; // Lavalink's own fixed internal port
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || null; // optional: only used to show the version on the status page

// Quick, cheap check: is something listening on Lavalink's internal port?
function checkUp(timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = net.connect(TARGET_PORT, TARGET_HOST);
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

// Best-effort only: without LAVALINK_PASSWORD set on *this* service, the
// status page just omits the version line rather than failing.
function fetchVersion() {
    if (!LAVALINK_PASSWORD) return Promise.resolve(null);
    return new Promise((resolve) => {
        const req = http.request(
            { host: TARGET_HOST, port: TARGET_PORT, path: '/version', headers: { Authorization: LAVALINK_PASSWORD }, timeout: 1500 },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve(res.statusCode === 200 ? body.trim().slice(0, 40) : null));
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get(['/', '/health'], async (req, res) => {
    const [up, version] = await Promise.all([checkUp(), fetchVersion()]);
    res.set('Cache-Control', 'no-store');
    res.status(up ? 200 : 503).render('status', { up, version });
});
app.head(['/', '/health'], async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status((await checkUp()) ? 200 : 503).end();
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Everything else: straight through to Lavalink, unmodified (REST + the bot's WebSocket).
const lavalinkProxy = createProxyMiddleware({
    target: `http://${TARGET_HOST}:${TARGET_PORT}`,
    changeOrigin: false,
    ws: true,
    logLevel: 'warn',
    onError(err, req, res) {
        console.error('[web] Lavalink unreachable:', err.message);
        if (res.writeHead) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Lavalink is starting up or unreachable — try again shortly.'); }
    },
});
app.use(lavalinkProxy);

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
    console.log(`[web] Public web portion listening on :${PUBLIC_PORT}, forwarding to Lavalink on :${TARGET_PORT}`);
});
server.on('upgrade', lavalinkProxy.upgrade); // the bot's /v4/websocket connection
