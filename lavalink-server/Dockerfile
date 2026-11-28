# Deploys this folder as its own Render Web Service (separate from the bot).
# Render: New -> Web Service -> same repo -> Root Directory = lavalink-server
# -> Environment: Docker.
#
# The youtube-source plugin is declared in application.yml (snapshot build) and
# downloaded by Lavalink at startup, so no plugin jar is copied here. Do not
# also drop a youtube-plugin jar in ./plugins/ — two copies will conflict.
#
# This image also runs a small Express app (index.js + views/status.ejs)
# alongside Lavalink so the service has an actual public web page at "/" —
# Lavalink itself requires Authorization on every route, so without this,
# opening the URL in a browser (or most uptime monitors) always shows a 401,
# even when Lavalink is perfectly healthy. Lavalink's own authentication is
# completely unchanged for every other path; see index.js for details.
FROM ghcr.io/lavalink-devs/lavalink:4

# The base image is Ubuntu-based. Node + npm are only for the small status
# page / proxy in front of Lavalink.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/Lavalink
COPY application.yml ./application.yml

# Installed before copying the rest so this layer only rebuilds when the
# dependency list actually changes.
COPY package.json ./package.json
RUN npm install --omit=dev

COPY index.js ./index.js
COPY views ./views
COPY start.sh ./start.sh
# a+rx (not just the owner) because the image drops back to its non-root
# runtime user (UID 322) below, which didn't create these copied-in files.
RUN chmod a+rx ./start.sh ./index.js
USER 322

EXPOSE 2333

# The base Lavalink image already defines its own ENTRYPOINT, which would
# otherwise swallow our CMD as unused extra arguments to "java" (that's what
# was happening before this line existed: Lavalink booted straight to its own
# default port, and start.sh never ran at all). Setting ENTRYPOINT here fully
# replaces the base image's, so start.sh genuinely becomes the container's
# startup command.
#
# Render assigns $PORT; the Express app binds that (see index.js/start.sh).
# Lavalink itself stays on a fixed internal port (LAVALINK_INTERNAL_PORT,
# default 2333) and is never reachable directly from outside.
# Heap raised from 256M to 384M: the 256M heap was causing GC pressure and
# "1006 no ping" disconnects. Keep it under ~400M on Render's 512MB free tier
# (JVM needs headroom).
ENTRYPOINT ["./start.sh"]
