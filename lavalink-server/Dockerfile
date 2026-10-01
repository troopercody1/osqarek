# Deploys this folder as its own Render Web Service (separate from the bot
# service). On Render: New -> Web Service -> same repo -> set "Root Directory"
# to lavalink-server -> Environment: Docker.
# --- Stage 1: fetch the youtube-source plugin jar straight from GitHub ---
# Releases, rather than letting Lavalink's own downloader pull it from
# maven.lavalink.dev at container start — that host has been unreliable
# (404s) for this artifact even on valid release tags. Uses a separate,
# curl-equipped image since the Lavalink runtime image below may not have
# curl installed.
FROM curlimages/curl:8.11.1 AS plugin-downloader

# Bump this when a newer release comes out:
# https://github.com/lavalink-devs/youtube-source/releases
ARG YOUTUBE_PLUGIN_VERSION=1.18.2

RUN curl -fL -o /tmp/youtube-plugin.jar \
    "https://github.com/lavalink-devs/youtube-source/releases/download/${YOUTUBE_PLUGIN_VERSION}/youtube-plugin-${YOUTUBE_PLUGIN_VERSION}.jar"

# --- Stage 2: the actual Lavalink server image ---
FROM ghcr.io/lavalink-devs/lavalink:4

WORKDIR /opt/Lavalink
COPY application.yml ./application.yml
COPY --from=plugin-downloader /tmp/youtube-plugin.jar ./plugins/youtube-plugin.jar

EXPOSE 2333

# Render assigns a random port via $PORT at runtime and routes external
# traffic to it. Lavalink (Spring Boot under the hood) reads its listen
# port from the SERVER_PORT env var, so we forward Render's $PORT into
# that before starting the jar. -Xmx256M keeps the JVM inside Render's
# free-tier 512MB instance; raise it (and move to a paid instance type)
# if you outgrow that.
CMD ["sh", "-c", "export SERVER_PORT=${PORT:-2333} && exec java -Xmx256M -jar Lavalink.jar"]
