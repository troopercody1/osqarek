# Deploys this folder as its own Render Web Service (separate from the bot).
# Render: New -> Web Service -> same repo -> Root Directory = lavalink-server
# -> Environment: Docker.
#
# The youtube-source plugin is declared in application.yml (snapshot build) and
# downloaded by Lavalink at startup, so no plugin jar is copied here. Do not
# also drop a youtube-plugin jar in ./plugins/ — two copies will conflict.
FROM ghcr.io/lavalink-devs/lavalink:4

WORKDIR /opt/Lavalink
COPY application.yml ./application.yml

EXPOSE 2333

# Render assigns $PORT; Lavalink reads SERVER_PORT. Heap raised from 256M to
# 384M: the 256M heap was causing GC pressure and "1006 no ping" disconnects.
# Keep it under ~400M on Render's 512MB free tier (JVM needs headroom).
CMD ["sh", "-c", "export SERVER_PORT=${PORT:-2333} && exec java -Xmx384M -jar Lavalink.jar"]
