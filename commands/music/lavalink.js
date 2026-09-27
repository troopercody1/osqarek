const { LavalinkManager } = require('lavalink-client');

// Audio backend: Lavalink (a Java server) does the actual downloading/decoding/
// encoding of tracks and streams the finished Opus audio straight to Discord's
// voice servers. This bot process only talks to Lavalink over a WebSocket/REST
// connection and forwards Discord voice-gateway events back and forth — it
// never touches raw audio itself, which is why @discordjs/voice, opusscript
// and libsodium-wrappers are no longer dependencies.
//
// YouTube playback specifically goes through Lavalink's "youtube-source"
// plugin (https://github.com/lavalink-devs/youtube-source), which replaces
// Lavalink's deprecated built-in YouTube source. That plugin is installed and
// configured on the Lavalink SERVER side (see application.yml) — nothing to
// install here — but it's why searches/URLs still use the familiar
// ytsearch:/youtube.com handling.
//
// One manager per bot process. Created lazily so commands/music/handler.js
// and index.js can both reach the same instance without a require cycle.
let manager = null;

function getLavalink(client) {
    if (manager) return manager;

    const missingEnv = ['LAVALINK_HOST', 'LAVALINK_PORT', 'LAVALINK_PASSWORD'].filter((k) => !process.env[k]);
    if (missingEnv.length) {
        console.warn(`⚠️ Lavalink env vars not set (${missingEnv.join(', ')}) — falling back to localhost:2333. Music playback will fail until a Lavalink node is reachable.`);
    }

    manager = new LavalinkManager({
        nodes: [
            {
                id: process.env.LAVALINK_NODE_ID || 'main',
                host: process.env.LAVALINK_HOST || 'localhost',
                port: Number(process.env.LAVALINK_PORT) || 2333,
                authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
                secure: process.env.LAVALINK_SECURE === 'true',
            },
        ],
        sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
        client: {
            id: process.env.CLIENT_ID || client.user?.id,
            username: "OsQarek's Universe",
        },
        autoSkip: true,
        playerOptions: {
            // The youtube-source plugin implements the same "ytsearch:"/"ytmsearch:"
            // query prefixes as Lavalink's old built-in YouTube source, so plain-text
            // /music play queries keep searching YouTube by default.
            defaultSearchPlatform: 'ytsearch',
            onDisconnect: { autoReconnect: true, destroyPlayer: false },
            // Queue-empty auto-leave is handled manually in handler.js (so 24/7 mode
            // can override it per guild), so this is left high rather than instant.
            onEmptyQueue: { destroyAfterMs: undefined },
        },
    });

    manager.nodeManager.on('connect', (node) => console.log(`✅ Lavalink node "${node.id}" connected.`));
    manager.nodeManager.on('disconnect', (node, reason) => console.log(`🔌 Lavalink node "${node.id}" disconnected:`, reason));
    manager.nodeManager.on('reconnecting', (node) => console.log(`🔄 Lavalink node "${node.id}" reconnecting...`));
    manager.nodeManager.on('error', (node, error) => console.error(`❌ Lavalink node "${node.id}" error:`, error?.message || error));

    return manager;
}

module.exports = { getLavalink };
