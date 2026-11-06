const { ActivityType } = require('discord.js');

async function help({ interaction, client, createEmbed }) {
    const helpEmbed = createEmbed({
        title: "🛡️ OsQarek's Universe | Command List",
        description: 'Navigate the Universe with the commands below. Permission levels apply.',
        thumbnail: client.user.displayAvatarURL(),
        footer: "OsQarek's Universe",
        fields: [
            { name: '👤 Public & Fun', value: '`ping`, `pfp`, `diceroll`, `randomletter`, `ship`, `osqareksocials`, `serverinfo`, `userinfo`, `afk`, `offences`, `random`, `reminder`, `joke`, `dadjoke`, `randomfact`, `cat`, `dog`, `coinflip`, `poll`, `latest-updates`' },
            { name: '🎮 Game & AI', value: '`ask-rules`, `summarize`, `suggest`, `quizlist`, `quizcreate`, `startquiz`, `delquiz`, `apply`, `join`, `leave`' },
            { name: '🎵 Music Engine', value: '`play`, `skip`, `queue`, `clearqueue`, `pause`, `resume`, `volume`, `nowplaying`, `autoplay`, `247`' },
            { name: '👮 Staff (Trial+)', value: '`warn`, `mute`, `unmute`, `kick`, `softban`, `purge`, `notes`, `warnings`, `loa`, `case`, `dm`, `addnote`' },
            { name: '⚔️ Moderation & Stats', value: '`lockdown`, `slowmode`, `reason`, `staffstats`, `allstaffstats`, `staff-leaderboard`' },
            { name: '⚙️ Admin', value: '`ban`, `unban`, `banlist`, `modlog`, `setloachannel`, `setchatlog`, `togglecommand`, `delwarn`, `clearwarns`, `ignorechannel`, `addmod`, `deletemod`, `announce`, `globalannounce`, `role`, `messagereset`, `restart`, `reloaddb`, `reactionrole`, `userignore`, `staffdm`, `latest-action`' },
            { name: '👑 Owners', value: '`strike remove`, `strike add`, `strikes`, `aitoggle`, `staff-reset`' },
        ],
    });

    return interaction.editReply({ embeds: [helpEmbed] });
}

async function ping({ interaction, client }) {
    return interaction.editReply(`🏓 Latency: **${client.ws.ping}ms**`);
}

async function restart({ interaction, guild, user, isHeadAdmin, logAction }) {
    if (!isHeadAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You do not have permission to restart the bot.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);
    logAction(guild, '🚀 Restart', `By: ${user.tag}`, 0xFF0000);
    await interaction.editReply('🚀 Restarting...');
    process.exit(0);
}

const MAX_DB_UPLOAD_BYTES = 8 * 1024 * 1024;

async function reloaddb({ interaction, options, user, guild, isHeadAdmin, reloadDatabase, logAction }) {
    if (!isHeadAdmin) return interaction.editReply('❌ You need **Head Admin+** to reload the database.');
    const source = options.getString('source') || 'auto';
    const attachment = options.getAttachment('file');
    try {
        let uploaded = null;
        if (attachment) {
            if (!/\.(txt|json)$/i.test(attachment.name || '')) return interaction.editReply('❌ Upload a `.txt` or `.json` file.');
            if (attachment.size > MAX_DB_UPLOAD_BYTES) return interaction.editReply('❌ That file is too large (8 MB max).');
            const res = await require('axios').get(attachment.url, {
                responseType: 'text',
                transformResponse: (d) => d,
                timeout: 15000,
                maxContentLength: MAX_DB_UPLOAD_BYTES,
            });
            try {
                uploaded = JSON.parse(String(res.data).replace(/^\uFEFF/, ''));
            } catch (err) {
                return interaction.editReply(`❌ That file isn't valid JSON (${err.message.slice(0, 120)}). Live database left unchanged.`);
            }
        }
        const r = await reloadDatabase(source, uploaded);
        const backup = r.backupFile ? `\nPrevious in-memory state saved to \`${r.backupFile}\`.` : '\n⚠️ Could not write a backup of the previous state.';
        const persisted = r.saved === true ? '\n💾 Saved to the persistent database.' : (r.saved === false ? '\n⚠️ Loaded in memory, but saving to the persistent database failed — run it again or check the logs.' : '');
        logAction(guild, '🔄 Database Reloaded', `**By:** ${user.tag}\n**Source:** ${r.source}\n**Top-level keys:** ${r.keys}\n**Cases:** ${r.cases}`, 0x3498DB);
        return interaction.editReply(`✅ Database reloaded from **${r.source}** (${r.keys} top-level keys, ${r.cases} cases).${persisted}${backup}`);
    } catch (err) {
        console.error('❌ /reloaddb failed:', err);
        return interaction.editReply(`❌ Reload failed, live database left unchanged: ${err.message}`);
    }
}

async function status({ interaction, options, guild, member, user, client, db, logAction }) {
    const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
    const hasPerms = member.roles.cache.some((role) => adminRoles.includes(role.id)) || member.permissions.has('Administrator');

    if (!hasPerms) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You do not have permission to change the bot's status.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const presets = {
        universe: { text: "OsQarek's Universe", type: ActivityType.Watching, presence: 'idle' },
        game: { text: "OsQarek's Universe Game on ROBLOX", type: ActivityType.Playing, presence: 'dnd' },
        help: { text: 'for /help', type: ActivityType.Listening, presence: 'online' },
        expand: { text: 'the Universe expand', type: ActivityType.Watching, presence: 'idle' },
    };
    const selected = presets[options.getString('preset')];

    if (!selected) return interaction.editReply('❌ Unknown status preset.');

    client.user.setPresence({
        activities: [{ name: selected.text, type: selected.type }],
        status: selected.presence,
    });

    if (db.modLogChannel) {
        logAction(guild, '🔄 Status Updated', `**Admin:** ${user.tag}\n**New Status:** ${selected.text}\n**Presence:** ${selected.presence}`, 0x3498DB);
    }

    return interaction.editReply(`✅ Status manually set to: **${selected.text}**`);
}

async function latestUpdate({ interaction }) {
    const updateEmbed = {
        title: "🚀 OsQarek's Universe | Bot Update v1.4.2",
        description: '**Latest stability patches and feature additions.**',
        color: 0x00FF00,
        thumbnail: { url: interaction.guild.iconURL({ dynamic: true }) },
        fields: [
            {
                name: '🛡️ Stability Fixes',
                value: '• Resolved intermittent crashes during high load.\n• Optimized database queries for faster response times.',
            },
        ],
        footer: { text: 'Universe Utilities', icon_url: interaction.user.displayAvatarURL() },
        timestamp: new Date().toISOString(),
    };

    return interaction.editReply({ embeds: [updateEmbed] });
}

module.exports = {
    help,
    ping,
    restart,
    reloaddb,
    status,
    'latest-update': latestUpdate,
};
