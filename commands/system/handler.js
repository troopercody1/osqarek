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
            { name: '⚙️ Admin', value: '`ban`, `unban`, `banlist`, `modlog`, `setloachannel`, `setchatlog`, `togglecommand`, `delwarn`, `clearwarns`, `ignorechannel`, `addmod`, `deletemod`, `announce`, `globalannounce`, `role`, `messagereset`, `restart`, `reactionrole`, `userignore`, `staffdm`, `latest-action`' },
            { name: '👑 Owners', value: '`strike remove`, `strike add`, `strikes`, `aitoggle`, `staff-reset`' },
        ],
    });

    return interaction.editReply({ embeds: [helpEmbed] });
}

async function ping({ interaction, client }) {
    return interaction.editReply(`🏓 Latency: **${client.ws.ping}ms**`);
}

async function restart({ interaction, guild, user, isHeadAdmin, logAction }) {
    if (!isHeadAdmin) return interaction.editReply('❌ You do not have permission to restart the bot.');
    logAction(guild, '🚀 Restart', `By: ${user.tag}`, 0xFF0000);
    await interaction.editReply('🚀 Restarting...');
    process.exit(0);
}

async function status({ interaction, options, guild, member, user, client, db, logAction }) {
    const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
    const hasPerms = member.roles.cache.some((role) => adminRoles.includes(role.id)) || member.permissions.has('Administrator');

    if (!hasPerms) {
        return interaction.editReply("❌ You do not have permission to change the bot's status.");
    }

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
    status,
    'latest-update': latestUpdate,
};
