const play = require('play-dl');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    AudioPlayerStatus,
    createAudioResource,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection,
} = require('@discordjs/voice');

// --- YOUTUBE AUTH (OPTIONAL) ---
async function setupPlayDL() {
    try {
        // YouTube streaming works with play-dl out of the box with no auth. A
        // cookie is only needed to reach age-restricted videos or to reduce the
        // chance of hitting YouTube's "confirm you're not a bot" block, which
        // shows up more often on datacenter/cloud-hosted IPs (e.g. Railway).
        // Export your browser's YouTube cookie header into YOUTUBE_COOKIE to enable it.
        if (process.env.YOUTUBE_COOKIE) {
            console.log("🔐 Setting up YouTube authentication...");
            await play.setToken({
                youtube: {
                    cookie: process.env.YOUTUBE_COOKIE
                }
            });
            console.log("✅ YouTube cookie loaded.");
        } else {
            console.log("ℹ️ No YOUTUBE_COOKIE set — streaming YouTube without authentication.");
        }
    } catch (err) {
        console.error("❌ YouTube Auth Error:", err.message);
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
        console.log(`🎧 Streaming YouTube track: ${song.title}`);

        // play-dl auto-picks the best audio-only format and tells us the
        // container type via streamData.type — no need to re-probe it.
        const streamData = await play.stream(song.url, {
            discordPlayerCompatibility: true
        });

        if (!streamData?.stream) throw new Error("YouTube stream is null");

        const resource = createAudioResource(streamData.stream, {
            inputType: streamData.type,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume ?? 0.5);

        serverQueue.connection.subscribe(serverQueue.player);
        serverQueue.player.removeAllListeners(AudioPlayerStatus.Idle);

        serverQueue.player.play(resource);

        serverQueue.player.on(AudioPlayerStatus.Idle, () => {
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
        console.error(`❌ YouTube Stream Error: ${err.message}`);
        serverQueue.textChannel?.send(
            `❌ Couldn't play **${song.title}** — this video is unavailable (it may be age-restricted, region-locked, or removed from YouTube).`
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

// Starts playback with the first video (joining VC if needed) and silently
// pushes the rest of a playlist onto the queue behind it.
async function queuePlaylist(interaction, member, songs) {
    await finalizeSongSelection(interaction, member, songs[0]);
    const rest = songs.slice(1);
    if (!rest.length) return;

    const serverQueue = queue.get(interaction.guild.id);
    if (!serverQueue) return;

    serverQueue.songs.push(...rest);
    return interaction.channel?.send(
        `📜 Queued **${rest.length}** more track${rest.length === 1 ? '' : 's'} from the playlist.`
    ).catch(() => { });
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
                console.log(`DEBUG: Resolving YouTube query: ${query}`);

                const ytType = play.yt_validate(query); // 'video' | 'playlist' | false

                if (ytType === 'playlist') {
                    const playlist = await play.playlist_info(query, { incomplete: true }).catch(() => null);
                    if (!playlist) return interaction.editReply("❌ Could not load that YouTube playlist.");

                    const videos = await playlist.all_videos().catch(() => []);
                    if (!videos.length) return interaction.editReply("❌ That playlist has no playable videos.");

                    const songs = videos.map(v => ({
                        title: v.title,
                        url: v.url,
                        artist: v.channel?.name || "Unknown Artist",
                        duration: v.durationInSec || 0,
                        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url,
                    }));

                    await queuePlaylist(interaction, member, songs).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ Couldn't start that playlist.");
                    });
                    return;
                }

                if (ytType === 'video') {
                    const info = await play.video_basic_info(query).catch(() => null);
                    if (!info?.video_details) return interaction.editReply("❌ Could not load that YouTube video.");

                    const v = info.video_details;
                    results = [{
                        title: v.title,
                        url: v.url,
                        artist: v.channel?.name || "Unknown Artist",
                        duration: v.durationInSec || 0,
                        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url,
                    }];
                } else {
                    const searchResults = await play.search(query, {
                        limit: 5,
                        source: { youtube: "video" }
                    });
                    console.log(`DEBUG: Found ${searchResults?.length || 0} results`);

                    if (!searchResults || searchResults.length === 0) {
                        return interaction.editReply("❌ No YouTube results found.");
                    }

                    // FIX: Enforce 5 result limit to prevent BASE_TYPE_BAD_LENGTH error
                    results = searchResults.slice(0, 5).map(v => ({
                        title: v.title,
                        url: v.url,
                        artist: v.channel?.name || "Unknown Artist",
                        duration: v.durationInSec || 0,
                        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url,
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
                        return interaction.editReply("❌ This video is unavailable. It may be geo-blocked or private.");
                    });
                    return;
                }

                const embed = createEmbed({
                    title: "🎧 Choose a YouTube Video",
                    description: results.map((r, i) => `**${i + 1}.** [${r.title}](${r.url})\n👤 *${r.artist}* • ⏱️ ${formatDuration(r.duration)}`).join("\n\n"),
                    footer: "Select a track using the buttons below",
                    timestamp: false,
                });

                const row = new ActionRowBuilder();
                results.forEach((_, i) => {
                    row.addComponents(new ButtonBuilder().setCustomId(`yt_select_${i}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
                });

                const msg = await interaction.editReply({ embeds: [embed], components: [row] });
                const filter = btn => btn.user.id === interaction.user.id && btn.customId.startsWith("yt_select_");
                const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

                collector.on("collect", async btn => {
                    const index = parseInt(btn.customId.split("_")[2]);
                    const chosen = results[index];
                    await btn.update({ content: `🎶 Selected: **${chosen.title}**`, embeds: [], components: [] }).catch(() => { });
                    collector.stop();

                    // PATCH: Catch stream failures for button selections
                    await finalizeSongSelection(interaction, member, chosen).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ This video is unavailable.");
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
