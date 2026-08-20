const play = require('play-dl');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    AudioPlayerStatus,
    createAudioResource,
    VoiceConnectionStatus,
    entersState,
    demuxProbe,
    getVoiceConnection,
} = require('@discordjs/voice');

// --- SAFE COOKIE INITIALIZATION ---
async function setupPlayDL() {
    try {
        console.log("🔐 Setting up SoundCloud authentication...");
        // SoundCloud client_ids are scraped, unofficial tokens that SoundCloud
        // periodically rotates/invalidates. A static SOUNDCLOUD_CLIENT_ID env var
        // will eventually 401. play.getFreeClientID() scrapes a fresh, currently
        // valid one from soundcloud.com at startup instead.
        const clientID = await play.getFreeClientID();
        await play.setToken({
            soundcloud: {
                client_id: clientID
            }
        });
        console.log("✅ SoundCloud Authorized (fresh client ID fetched).");
    } catch (err) {
        console.error("❌ SoundCloud Auth Error:", err.message);
        // Fallback: try the env var if scraping failed for some reason (e.g. network block)
        if (process.env.SOUNDCLOUD_CLIENT_ID) {
            try {
                await play.setToken({ soundcloud: { client_id: process.env.SOUNDCLOUD_CLIENT_ID } });
                console.log("⚠️ SoundCloud Authorized using fallback SOUNDCLOUD_CLIENT_ID env var (may be stale).");
            } catch (fallbackErr) {
                console.error("❌ SoundCloud fallback auth also failed:", fallbackErr.message);
            }
        }
    }
}

const queue = new Map();
let stayInVC = false;

async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || !song) {
        if (serverQueue?.connection) serverQueue.connection.destroy();
        queue.delete(guildId);
        return false;
    }

    try {
        console.log(`🎧 Streaming SoundCloud track: ${song.title}`);

        const streamData = await play.stream(song.streamURL || song.url, {
            quality: 2,
            discordPlayerCompatibility: true
        });

        const stream = streamData.stream || streamData;
        if (!stream) throw new Error("SoundCloud stream is null");

        const { stream: probedStream, type: probedType } = await demuxProbe(stream);

        const resource = createAudioResource(probedStream, {
            inputType: probedType,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume ?? 0.5);

        serverQueue.connection.subscribe(serverQueue.player);
        serverQueue.player.removeAllListeners(AudioPlayerStatus.Idle);

        const playbackStartedAt = Date.now();
        serverQueue.player.play(resource);

        serverQueue.player.on(AudioPlayerStatus.Idle, () => {
            // SoundCloud serves 30s "preview" streams instead of the full track for a lot of
            // commercial/label music when accessed without a paid/OAuth client_id. If playback
            // ended way earlier than the track's reported duration, it's almost certainly that —
            // not a crash — so tell the channel instead of silently vanishing.
            const playedSeconds = (Date.now() - playbackStartedAt) / 1000;
            if (song.duration && playedSeconds < song.duration - 10 && playedSeconds < 40) {
                serverQueue.textChannel?.send(
                    `⚠️ **${song.title}** cut off after ~${Math.round(playedSeconds)}s — SoundCloud likely only allows a preview clip for this track (common for major-label releases without a paid API key).`
                ).catch(() => { });
            }

            serverQueue.songs.shift();

            if (serverQueue.songs.length > 0) {
                playSong(guildId, serverQueue.songs[0]);
            } else if (!stayInVC) {
                serverQueue.connection.destroy();
                queue.delete(guildId);
            }
        });

        return true;

    } catch (err) {
        console.error(`❌ SoundCloud Stream Error: ${err.message}`);
        serverQueue.textChannel?.send(
            `❌ Couldn't play **${song.title}** — this track's stream link is unavailable (it may have been removed or restricted on SoundCloud).`
        ).catch(() => { });

        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) {
            return playSong(guildId, serverQueue.songs[0]);
        } else {
            serverQueue.connection.destroy();
            queue.delete(guildId);
            return false;
        }
    }
}

async function finalizeSongSelection(interaction, member, song) {
    let serverQueue = queue.get(interaction.guild.id);

    if (!serverQueue) {
        const connection = joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true
        });

        // --- TEMP DIAGNOSTIC LOGGING (voice connection troubleshooting) ---
        // Distinguishes "voice signalling never connects" from "signalling OK but
        // UDP audio path never completes" — these need different fixes.
        connection.on('debug', (msg) => console.log('🔧 [voice debug]', msg));
        connection.on('stateChange', (oldState, newState) => {
            console.log(`🔧 [voice state] ${oldState.status} -> ${newState.status} | networking: ${newState.networking?.state?.code ?? newState.networking?.state ?? 'n/a'}`);
        });

        try {
            // 5s was too tight for some hosts' network paths to Discord's voice
            // media servers, causing spurious "operation was aborted" errors
            // even though the connection would have succeeded a couple seconds later.
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (err) {
            connection.destroy();
            console.error("❌ Voice connection failed to become ready:", err.message);
            return interaction.followUp("❌ Couldn't establish a stable voice connection. Please try again.");
        }

        const queueConstruct = {
            textChannel: interaction.channel,
            voiceChannel: member.voice.channel,
            connection: connection,
            player: createAudioPlayer(),
            songs: [song],
            autoplay: false,
            volume: 0.5
        };

        queue.set(interaction.guild.id, queueConstruct);
        connection.subscribe(queueConstruct.player);

        await playSong(interaction.guild.id, song);
        return interaction.followUp(`🎶 Now playing: **${song.title}**`);
    }

    serverQueue.songs.push(song);
    return interaction.followUp(`➕ Added **${song.title}** to queue.`);
}

function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

async function music({ interaction, options, db, createEmbed }) {
    const subcommand = interaction.options.getSubcommand();
    const serverQueue = queue.get(interaction.guildId);
    const member = interaction.member;

    switch (subcommand) {
        case 'join': {
            const voiceChannel = member.voice.channel;
            if (!voiceChannel) return interaction.editReply("❌ You must be in a voice channel.");

            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            return interaction.editReply(`✅ Joined **${voiceChannel.name}**.`);
        }

        case 'nowplaying': {
            // 1. Check if the queue exists
            if (!serverQueue || !serverQueue.songs.length) {
                return interaction.editReply("❌ Nothing is currently playing.");
            }

            const song = serverQueue.songs[0];

            // 2. Build the Now Playing Embed
            const embed = createEmbed({
                title: "🎶 Now Playing",
                description: `**[${song.title}](${song.url})**`,
                thumbnail: song.thumbnail,
                footer: `Requested by ${member.displayName}`,
                timestamp: false,
                fields: [
                    { name: "👤 Artist", value: song.artist, inline: true },
                    { name: "⏱️ Duration", value: formatDuration(song.duration), inline: true }
                ],
            });

            // 3. Finalize the reply
            try {
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error("❌ Now Playing Error:", err);
                // Fallback if editReply fails
                if (!interaction.replied) {
                    await interaction.followUp({ embeds: [embed] }).catch(() => { });
                }
            }
            break;
        }

        case 'play': {
            if (db.musicEnabled === false) return interaction.editReply('🎵 Music module is currently disabled.');
            console.log("DEBUG: Music Play started");
            const query = interaction.options.getString('query');
            if (!member.voice.channel) return interaction.editReply("❌ You must be in a voice channel.");

            try {
                let results = [];
                console.log(`DEBUG: Searching SoundCloud for: ${query}`);

                if (query.includes("soundcloud.com")) {
                    const scTrack = await play.soundcloud(query).catch(() => null);
                    if (!scTrack) return interaction.editReply("❌ Could not load that SoundCloud link.");

                    results = [{
                        title: scTrack.name || scTrack.title,
                        url: scTrack.url,
                        streamURL: scTrack.streamURL,
                        artist: scTrack.publisher?.artist || "Unknown Artist",
                        duration: scTrack.durationInSec || 0,
                        thumbnail: scTrack.thumbnail,
                    }];
                } else {
                    const searchResults = await play.search(query, {
                        limit: 5,
                        source: { soundcloud: "tracks" }
                    });
                    console.log(`DEBUG: Found ${searchResults?.length || 0} results`);

                    if (!searchResults || searchResults.length === 0) {
                        return interaction.editReply("❌ No SoundCloud results found.");
                    }

                    // FIX: Enforce 5 result limit to prevent BASE_TYPE_BAD_LENGTH error
                    results = searchResults.slice(0, 5).map(t => ({
                        title: t.name || t.title,
                        url: t.url,
                        streamURL: t.streamURL,
                        artist: t.publisher?.artist || "Unknown Artist",
                        duration: t.durationInSec || 0,
                        thumbnail: t.thumbnail
                    }));
                }

                if (results.length === 1) {
                    console.log("DEBUG: One result found, jumping to finalization");
                    if (typeof finalizeSongSelection !== 'function') {
                        return interaction.editReply("❌ Internal Error: finalizeSongSelection is not defined.");
                    }

                    // PATCH: Catch 404s during finalization to stop indefinite "thinking"
                    await finalizeSongSelection(interaction, member, results[0]).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ This track is unavailable (404). It may be geo-blocked or private.");
                    });
                    return;
                }

                const embed = createEmbed({
                    title: "🎧 Choose a SoundCloud Track",
                    description: results.map((r, i) => `**${i + 1}.** [${r.title}](${r.url})\n👤 *${r.artist}* • ⏱️ ${formatDuration(r.duration)}`).join("\n\n"),
                    footer: "Select a track using the buttons below",
                    timestamp: false,
                });

                const row = new ActionRowBuilder();
                results.forEach((_, i) => {
                    row.addComponents(new ButtonBuilder().setCustomId(`sc_select_${i}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
                });

                const msg = await interaction.editReply({ embeds: [embed], components: [row] });
                const filter = btn => btn.user.id === interaction.user.id && btn.customId.startsWith("sc_select_");
                const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

                collector.on("collect", async btn => {
                    const index = parseInt(btn.customId.split("_")[2]);
                    const chosen = results[index];
                    await btn.update({ content: `🎶 Selected: **${chosen.title}**`, embeds: [], components: [] }).catch(() => { });
                    collector.stop();

                    // PATCH: Catch stream failures for button selections
                    await finalizeSongSelection(interaction, member, chosen).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ This track is unavailable (404).");
                    });
                });

                collector.on("end", (collected, reason) => {
                    if (reason === 'time' && collected.size === 0) {
                        interaction.editReply({ content: "⏳ Selection timed out.", embeds: [], components: [] }).catch(() => { });
                    }
                });

            } catch (err) {
                console.error("❌ PLAY ERROR:", err);
                return interaction.editReply("❌ Error processing your request.").catch(() => { });
            }
            break;
        }
        case 'skip': {
            if (!serverQueue || !serverQueue.songs.length) return interaction.editReply("❌ Nothing to skip.");
            serverQueue.songs.shift();
            if (!serverQueue.songs.length) {
                serverQueue.player.stop(true);
                serverQueue.connection.destroy();
                queue.delete(interaction.guildId);
                return interaction.editReply("⏭️ Skipped. Queue is now empty.");
            }
            await playSong(interaction.guildId, serverQueue.songs[0]);
            return interaction.editReply("⏭️ Skipped to the next track.");
        }

        case 'queue': {
            if (!serverQueue || !serverQueue.songs.length) return interaction.editReply("📜 The queue is empty.");
            const lines = serverQueue.songs.map((s, i) => `**${i === 0 ? "▶️" : i}.** [${s.title}](${s.url})`).slice(0, 20);
            const embed = createEmbed({
                title: "📜 Current Queue",
                description: lines.join("\n"),
                footer: `Total tracks: ${serverQueue.songs.length}`,
                timestamp: false,
            });
            return interaction.editReply({ embeds: [embed] });
        }

        case 'pause': {
            if (!serverQueue) return interaction.editReply("❌ Nothing is playing.");
            return interaction.editReply(serverQueue.player.pause() ? "⏸️ Paused the music." : "❌ Music is already paused.");
        }

        case 'resume': {
            if (!serverQueue) return interaction.editReply("❌ Nothing is playing.");
            return interaction.editReply(serverQueue.player.unpause() ? "▶️ Resumed the music." : "❌ Music is already playing.");
        }
        case 'volume': {
            const serverQueue = queue.get(interaction.guild.id);

            if (!serverQueue) {
                return interaction.editReply("❌ No music is currently playing.");
            }

            const level = options.getNumber('level');

            // Updated safety check to allow up to 1000%
            if (level < 0 || level > 1000) {
                return interaction.editReply("❌ Please provide a volume between 0 and 1000.");
            }

            const volumeFactor = level / 100; // 1000 becomes 10.0

            // 1. Update the saved volume in your queue object
            serverQueue.volume = volumeFactor;

            // 2. Apply it immediately to the current song resource
            const currentResource = serverQueue.player.state.resource;

            if (currentResource && currentResource.volume) {
                currentResource.volume.setVolume(volumeFactor);

                let response = `🔊 Volume set to **${level}%**`;

                // Dynamic warnings based on how high they push it
                if (level > 200) {
                    response += "\n☢️ **WARNING:** Extreme volume levels will cause heavy distortion!";
                } else if (level > 100) {
                    response += "\n⚠️ *Note: Volumes above 100% may cause audio distortion.*";
                }

                return interaction.editReply(response);
            } else {
                return interaction.editReply("⚠️ Volume updated for future tracks, but the current stream doesn't support live adjustments.");
            }
        }

        case 'leave': {
            const connection = getVoiceConnection(interaction.guildId);
            if (!connection) return interaction.editReply("❌ I'm not in a voice channel.");
            connection.destroy();
            queue.delete(interaction.guildId);
            return interaction.editReply("👋 Left the voice channel and cleared the queue.");
        }

        case 'autoplay': {
            if (!serverQueue) return interaction.editReply("❌ No active queue.");
            serverQueue.autoplay = !serverQueue.autoplay;
            return interaction.editReply(`🔁 Autoplay is now **${serverQueue.autoplay ? 'ENABLED' : 'DISABLED'}**.`);
        }

        case '247': {
            stayInVC = !stayInVC;
            return interaction.editReply(`🛰️ 24/7 mode is now **${stayInVC ? 'ENABLED' : 'DISABLED'}**.`);
        }

        case 'clear': {
            if (!serverQueue) return interaction.editReply("❌ There is no active queue to clear.");
            serverQueue.songs = [serverQueue.songs[0]];
            return interaction.editReply("🧹 Cleared all upcoming songs from the queue.");
        }
    }

    // FINAL PATCH: Fallback to ensure the "Thinking" state is cleared if a subcommand ends early
    if (interaction.deferred && !interaction.replied) {
        await interaction.editReply("✅ Command processed.").catch(() => { });
    }
    return;
}

module.exports = {
    music,
    setupPlayDL,
    queue,
};
