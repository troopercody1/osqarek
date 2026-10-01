# Deploys this folder as its own Render Web Service (separate from the bot
# service). On Render: New -> Web Service -> same repo -> set "Root Directory"
# to lavalink-server -> Environment: Docker.
FROM ghcr.io/lavalink-devs/lavalink:4

WORKDIR /opt/Lavalink
COPY application.yml ./application.yml

EXPOSE 2333

# Render assigns a random port via $PORT at runtime and routes external
# traffic to it. Lavalink (Spring Boot under the hood) reads its listen
# port from the SERVER_PORT env var, so we forward Render's $PORT into
# that before starting the jar. -Xmx256M keeps the JVM inside Render's
# free-tier 512MB instance; raise it (and move to a paid instance type)
# if you outgrow that.
CMD ["sh", "-c", "export SERVER_PORT=${PORT:-2333} && exec java -Xmx256M -jar Lavalink.jar"]
