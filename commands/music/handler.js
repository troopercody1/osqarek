const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLavalink } = require('./lavalink');

// Guild-scoped 24/7 flags. Kept outside the player (instead of the old single
// global `stayInVC` boolean) so enabling it in one server doesn't affect every
// other server the bot is in — the original global flag was a bug, not a
// feature, and it's just as simple to key it by guild.
const stay247 = new Set();

function formatDuration(ms) {
    const totalSec = Math.floor((ms || 0) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function trackToSong(track) {
    return {
        title: track.info.title,
        url: track.info.uri,
        artist: track.info.author || "Unknown Artist",
        duration: track.info.duration,
        thumbnail: track.info.artworkUrl,
    };
}

// Wires the manager-level events once per process. Safe to call repeatedly;
// LavalinkManager is a singleton (see lavalink.js) so this only ever attaches
// once in practice, but guard anyway in case handler.js is required twice.
let listenersAttached = false;
function attachManagerListeners(lavalink) {
    if (listenersAttached) return;
    listenersAttached = true;

    lavalink.on('trackError', (player, track, payload) => {
        console.error(`❌ Lavalink track error for "${track?.info?.title}":`, payload?.exception?.message || payload);
        player.textChannel?.send(
            `❌ Couldn't play **${track?.info?.title || "that track"}** — ${payload?.exception?.message || "it may be age-restricted, region-locked, or unavailable."}`
        ).catch(() => { });
    });

    lavalink.on('trackStuck', (player, track) => {
        console.error(`❌ Lavalink track stuck: "${track?.info?.title}"`);
        player.textChannel?.send(`⚠️ **${track?.info?.title || "That track"}** got stuck and was skipped.`).catch(() => { });
    });

    // Fires once the queue has nothing left to play. Mirrors the old
    // "auto-leave unless 24/7 mode" behavior from the play-dl implementation.
    lavalink.on('queueEnd', (player) => {
        if (stay247.has(player.guildId)) return;
        player.destroy().catch(() => { });
    });
}

async function getOrCreatePlayer({ client, interaction, member, textChannel }) {
    const lavalink = getLavalink(client);
    attachManagerListeners(lavalink);

    let player = lavalink.getPlayer(interaction.guildId);
    if (player) return player;

    player = lavalink.createPlayer({
        guildId: interaction.guildId,
        voiceChannelId: member.voice.channel.id,
        textChannelId: textChannel.id,
        selfDeaf: true,
        selfMute: false,
    });
    // Kept for the manager event handlers above, which only receive `player`.
    player.textChannel = textChannel;

    await player.connect();
    return player;
}

async function finalizeSongSelection(interaction, member, track) {
    const player = await getOrCreatePlayer({ client: interaction.client, interaction, member, textChannel: interaction.channel });

    player.queue.add(track);

    if (!player.playing && !player.paused) {
        await player.play();
        return interaction.followUp(`🎶 Now playing: **${track.info.title}**`);
    }

    return interaction.followUp(`➕ Added **${track.info.title}** to queue.`);
}

// Starts playback with the first track (joining VC if needed) and silently
// queues the rest of a playlist behind it.
async function queuePlaylist(interaction, member, tracks) {
    await finalizeSongSelection(interaction, member, tracks[0]);
    const rest = tracks.slice(1);
    if (!rest.length) return;

    const player = getLavalink(interaction.client).getPlayer(interaction.guildId);
    if (!player) return;

    player.queue.add(rest);
    return interaction.channel?.send(
        `📜 Queued **${rest.length}** more track${rest.length === 1 ? '' : 's'} from the playlist.`
    ).catch(() => { });
}

async function music({ interaction, options, db, createEmbed, client }) {
    const subcommand = interaction.options.getSubcommand();
    const lavalink = getLavalink(client);
    attachManagerListeners(lavalink);
    const player = lavalink.getPlayer(interaction.guildId);
    const member = interaction.member;

    switch (subcommand) {
        case 'join': {
            const voiceChannel = member.voice.channel;
            if (!voiceChannel) return interaction.editReply("❌ You must be in a voice channel.");

            await getOrCreatePlayer({ client, interaction, member, textChannel: interaction.channel });
            return interaction.editReply(`✅ Joined **${voiceChannel.name}**.`);
        }

        case 'nowplaying': {
            const current = player?.queue?.current;
            if (!current) {
                return interaction.editReply("❌ Nothing is currently playing.");
            }

            const song = trackToSong(current);
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

            try {
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error("❌ Now Playing Error:", err);
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
                console.log(`DEBUG: Resolving YouTube query: ${query}`);

                // player.search() understands raw URLs (video/playlist) as well as
                // plain text, which it runs through defaultSearchPlatform (ytsearch).
                // This replaces play-dl's separate yt_validate()/search() branching.
                const searchResult = await lavalink.search({ query, source: 'ytsearch' }, interaction.user).catch((err) => {
                    console.error("❌ YouTube Search Error:", err.message);
                    return null;
                });

                if (!searchResult || searchResult.loadType === 'error') {
                    return interaction.editReply(`❌ YouTube search failed — ${searchResult?.exception?.message || "the request to YouTube failed."}`);
                }
                if (searchResult.loadType === 'empty') {
                    return interaction.editReply("❌ No YouTube results found.");
                }

                if (searchResult.loadType === 'playlist') {
                    const tracks = searchResult.tracks;
                    if (!tracks.length) return interaction.editReply("❌ That playlist has no playable videos.");

                    await queuePlaylist(interaction, member, tracks).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ Couldn't start that playlist.");
                    });
                    return;
                }

                if (searchResult.loadType === 'track') {
                    await finalizeSongSelection(interaction, member, searchResult.tracks[0]).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ This video is unavailable. It may be geo-blocked or private.");
                    });
                    return;
                }

                // loadType === 'search': show a 1-5 result picker, same as before.
                const results = searchResult.tracks.slice(0, 5);
                console.log(`DEBUG: Found ${results.length} results`);

                if (results.length === 1) {
                    console.log("DEBUG: One result found, jumping to finalization");
                    await finalizeSongSelection(interaction, member, results[0]).catch(err => {
                        console.error("❌ STREAM ERROR:", err.message);
                        return interaction.editReply("❌ This video is unavailable. It may be geo-blocked or private.");
                    });
                    return;
                }

                const embed = createEmbed({
                    title: "🎧 Choose a YouTube Video",
                    description: results.map((t, i) => `**${i + 1}.** [${t.info.title}](${t.info.uri})\n👤 *${t.info.author || "Unknown Artist"}* • ⏱️ ${formatDuration(t.info.duration)}`).join("\n\n"),
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
                    await btn.update({ content: `🎶 Selected: **${chosen.info.title}**`, embeds: [], components: [] }).catch(() => { });
                    collector.stop();

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
            if (!player || !player.queue.current) return interaction.editReply("❌ Nothing to skip.");
            const hadNext = player.queue.tracks.length > 0;
            await player.skip(0, false);
            return interaction.editReply(hadNext ? "⏭️ Skipped to the next track." : "⏭️ Skipped. Queue is now empty.");
        }

        case 'queue': {
            if (!player || !player.queue.current) return interaction.editReply("📜 The queue is empty.");
            const songs = [player.queue.current, ...player.queue.tracks];
            const lines = songs.map((t, i) => `**${i === 0 ? "▶️" : i}.** [${t.info.title}](${t.info.uri})`).slice(0, 20);
            const embed = createEmbed({
                title: "📜 Current Queue",
                description: lines.join("\n"),
                footer: `Total tracks: ${songs.length}`,
                timestamp: false,
            });
            return interaction.editReply({ embeds: [embed] });
        }

        case 'pause': {
            if (!player) return interaction.editReply("❌ Nothing is playing.");
            if (player.paused) return interaction.editReply("❌ Music is already paused.");
            await player.pause();
            return interaction.editReply("⏸️ Paused the music.");
        }

        case 'resume': {
            if (!player) return interaction.editReply("❌ Nothing is playing.");
            if (!player.paused) return interaction.editReply("❌ Music is already playing.");
            await player.resume();
            return interaction.editReply("▶️ Resumed the music.");
        }
        case 'volume': {
            if (!player) {
                return interaction.editReply("❌ No music is currently playing.");
            }

            const level = options.getNumber('level');

            // Updated safety check to allow up to 1000%
            if (level < 0 || level > 1000) {
                return interaction.editReply("❌ Please provide a volume between 0 and 1000.");
            }

            // Lavalink's player volume is already a 0-1000 percentage, so it takes
            // the slash command's `level` directly (no /100 conversion needed here).
            await player.setVolume(level);

            let response = `🔊 Volume set to **${level}%**`;
            if (level > 200) {
                response += "\n☢️ **WARNING:** Extreme volume levels will cause heavy distortion!";
            } else if (level > 100) {
                response += "\n⚠️ *Note: Volumes above 100% may cause audio distortion.*";
            }

            return interaction.editReply(response);
        }

        case 'leave': {
            if (!player) return interaction.editReply("❌ I'm not in a voice channel.");
            stay247.delete(interaction.guildId);
            await player.destroy();
            return interaction.editReply("👋 Left the voice channel and cleared the queue.");
        }

        case 'autoplay': {
            if (!player) return interaction.editReply("❌ No active queue.");
            player.autoplayEnabled = !player.autoplayEnabled;
            return interaction.editReply(`🔁 Autoplay is now **${player.autoplayEnabled ? 'ENABLED' : 'DISABLED'}**.`);
        }

        case '247': {
            const enabled = !stay247.has(interaction.guildId);
            if (enabled) stay247.add(interaction.guildId);
            else stay247.delete(interaction.guildId);
            return interaction.editReply(`🛰️ 24/7 mode is now **${enabled ? 'ENABLED' : 'DISABLED'}**.`);
        }

        case 'clear': {
            if (!player || !player.queue.tracks.length) return interaction.editReply("❌ There is no active queue to clear.");
            player.queue.splice(0, player.queue.tracks.length);
            return interaction.editReply("🧹 Cleared all upcoming songs from the queue.");
        }
    }

    if (interaction.deferred && !interaction.replied) {
        await interaction.editReply("✅ Command processed.").catch(() => { });
    }
    return;
}

module.exports = {
    music,
};
