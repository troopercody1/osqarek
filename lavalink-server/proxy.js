// The public "web portion" of this Lavalink service.
//
// Lavalink itself has no home page: every route, including "/", requires the
// Authorization header (LAVALINK_PASSWORD), so a browser or an uptime monitor
// hitting the bare URL always gets HTTP 401 — even when Lavalink is perfectly
// healthy. That's expected Lavalink behaviour, not a bug.
//
// This tiny proxy sits in front of Lavalink and is what Render actually
// exposes on $PORT:
//   - GET/HEAD "/" (and "/health", "/favicon.ico") -> a small static status
//     page, no auth required. This is what a browser or an HTTP(S) uptime
//     monitor should see: a normal 200, instead of Lavalink's 401.
//   - Everything else (all real Lavalink REST calls and the bot's
//     /v4/websocket connection) is passed straight through to Lavalink on
//     its internal port, headers/body/Authorization untouched. Lavalink's
//     own authentication and behavior are completely unchanged.
//
// Only built-in Node modules are used (no npm install needed in the image).
const http = require('http');
const net = require('net');
const { URL } = require('url');

const PUBLIC_PORT = Number(process.env.PORT) || 10000; // Render's assigned public port
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.LAVALINK_INTERNAL_PORT) || 2333; // Lavalink's own fixed internal port

const STATUS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>OsQarek Lavalink</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background:#0b0b14; color:#e7e5ff; }
  .card { text-align:center; padding:32px 40px; border:1px solid #2a2750; border-radius:16px; background:rgba(20,18,48,0.5); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#57F287; margin-right:8px; box-shadow:0 0 10px #57F287; vertical-align:1px; }
  h1 { font-size:20px; margin:0 0 6px; font-weight:600; }
  p { margin:0; color:#a79fe0; font-size:13px; }
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>Lavalink audio node is online</h1>
  <p>Public status page only — no dashboard or API is exposed here.</p>
</div></body></html>`;

function isHealthPath(pathname) {
    return pathname === '/' || pathname === '/health' || pathname === '/favicon.ico';
}

const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://placeholder').pathname; } catch { /* keep default */ }

    if ((req.method === 'GET' || req.method === 'HEAD') && isHealthPath(pathname)) {
        if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : STATUS_PAGE);
    }

    // Everything else: straight through to Lavalink, unmodified.
    const proxyReq = http.request(
        { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers },
        (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); }
    );
    proxyReq.on('error', (err) => {
        console.error('[proxy] Lavalink unreachable:', err.message);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Lavalink is starting up or unreachable — try again shortly.');
    });
    req.pipe(proxyReq);
});

// Raw passthrough for WebSocket upgrades (the bot's /v4/websocket connection).
server.on('upgrade', (req, clientSocket, head) => {
    const serverSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
        const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        serverSocket.write(headerLines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) serverSocket.write(head);
        clientSocket.pipe(serverSocket);
        serverSocket.pipe(clientSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
    console.log(`[proxy] Public web portion listening on :${PUBLIC_PORT}, forwarding to Lavalink on :${TARGET_PORT}`);
});
