#!/bin/bash
# Runs two processes in this one Render service:
#   1. Lavalink itself, bound to a fixed INTERNAL port (never Render's $PORT).
#   2. The small Express app (index.js), bound to Render's $PORT — this is
#      the only thing the public internet ever reaches directly.
# It forwards everything to Lavalink except the "/" and "/health" status page
# (see index.js + views/status.ejs), so Lavalink's own Authorization
# requirement is untouched for every real route.
#
# Binding the public port with Node (near-instant) rather than Lavalink
# (which takes ~30-60s to boot the JVM) also means Render sees an open port
# right away instead of waiting through Lavalink's full startup.
set -e

export SERVER_PORT="${LAVALINK_INTERNAL_PORT:-2333}"
java -Xmx384M -jar Lavalink.jar &
JAVA_PID=$!

node index.js &
NODE_PID=$!

# If either process dies, bring the whole container down so Render restarts it
# cleanly, instead of silently running in a half-working state.
wait -n "$JAVA_PID" "$NODE_PID"
EXIT_CODE=$?
kill "$JAVA_PID" "$NODE_PID" 2>/dev/null || true
exit "$EXIT_CODE"
