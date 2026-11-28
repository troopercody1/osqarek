# Deploys this folder as its own Render Web Service (separate from the bot).
# Render: New -> Web Service -> same repo -> Root Directory = lavalink-server
# -> Environment: Docker.
#
# The youtube-source plugin is declared in application.yml (snapshot build) and
# downloaded by Lavalink at startup, so no plugin jar is copied here. Do not
# also drop a youtube-plugin jar in ./plugins/ — two copies will conflict.
#
# This image also runs a tiny Node proxy (proxy.js, start.sh) alongside
# Lavalink so the service has an actual public web page at "/" — Lavalink
# itself requires Authorization on every route, so without this, opening the
# URL in a browser (or most uptime monitors) always shows a 401, even when
# Lavalink is perfectly healthy. See proxy.js for details; Lavalink's own
# authentication is completely unchanged for every other path.
FROM ghcr.io/lavalink-devs/lavalink:4

# The base image is Ubuntu-based; Node is only used for the small status-page
# proxy (proxy.js uses built-in modules only, no npm install needed).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/Lavalink
COPY application.yml ./application.yml
COPY proxy.js ./proxy.js
COPY start.sh ./start.sh
# a+rx (not just the owner) because the image drops back to its non-root
# runtime user (UID 322) below, which didn't create these copied-in files.
RUN chmod a+rx ./start.sh ./proxy.js
USER 322

EXPOSE 2333

# Render assigns $PORT; the Node proxy binds that (see proxy.js/start.sh).
# Lavalink itself stays on a fixed internal port (LAVALINK_INTERNAL_PORT,
# default 2333) and is never reachable directly from outside.
# Heap raised from 256M to 384M: the 256M heap was causing GC pressure and
# "1006 no ping" disconnects. Keep it under ~400M on Render's 512MB free tier
# (JVM needs headroom).
CMD ["./start.sh"]
