const { ActivityType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

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
    if (!isHeadAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You do not have permission to restart the bot.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);
    logAction(guild, '🚀 Restart', `By: ${user.tag}`, 0xFF0000);
    await interaction.editReply('🚀 Restarting...');
    process.exit(0);
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

// --- Migrated from index.js legacy command chain ---

async function togglecommand({ interaction, options, guild, user, db, isAtLeastAdmin, logAction, safeSave }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You need Admin+ permissions to use this command.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const cmd = options.getString('command').toLowerCase();
    if (db.disabledCommands.includes(cmd)) db.disabledCommands = db.disabledCommands.filter(c => c !== cmd);
    else db.disabledCommands.push(cmd);
    await db.save();
    logAction(guild, '⚙️ Toggle', `Command /${cmd} toggled by ${user.tag}`);
    return interaction.editReply(`✅ Toggled \`/${cmd}\`.`);
}

async function latestAction({ interaction, db }) {
    const modLogs = db.modLogs || [];

    if (modLogs.length === 0) {
        return interaction.editReply({ content: "📂 No moderation actions recorded yet." });
    }

    const recentActions = modLogs.slice(-5).reverse();

    const embed = new EmbedBuilder()
        .setTitle('🛰️ OsQarek’s Universe | Recent Activity')
        .setColor(0x00FFFF)
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .setTimestamp();

    const logList = recentActions.map((log, index) => {
        const time = `<t:${Math.floor(log.timestamp / 1000)}:R>`;
        const actionEmoji = log.action.includes('Ban') ? '🔨' : log.action.includes('LOA') ? '📂' : '📝';

        return `**${index + 1}. ${actionEmoji} ${log.action}**\n` +
            `👤 **Target:** ${log.target}\n` +
            `🛡️ **Moderator:** ${log.moderator} | ${time}\n` +
            `📄 **Reason:** \`${log.reason || 'None'}\`\n` +
            `──────────────`;
    }).join('\n');

    embed.setDescription(logList);

    return await interaction.editReply({ embeds: [embed] });
}

async function role({ interaction, options, member, isAtLeastAdmin }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You need Admin+ permissions to use this command.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const action = options.getString('action');
    const target = options.getMember('target');
    const targetRole = options.getRole('role');

    if (targetRole.position >= member.roles.highest.position) return interaction.editReply("❌ You cannot manage a role higher than yours.");

    if (action === 'add') {
        await target.roles.add(targetRole);
        return interaction.editReply(`✅ Added **${targetRole.name}** to ${target.user.tag}.`);
    } else {
        await target.roles.remove(targetRole);
        return interaction.editReply(`✅ Removed **${targetRole.name}** from ${target.user.tag}.`);
    }
}

async function clearall({ interaction, channel, isAtLeastAdmin }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You need Admin+ permissions to use this command.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const position = channel.position;
    const newChannel = await channel.clone();
    await channel.delete();
    await newChannel.setPosition(position);
    await newChannel.send("☢️ **Channel Nuked.**");
    // No editReply — the old (deferred) channel/interaction is gone.
}

async function globalannounce({ interaction, options, guild, client, isAtLeastAdmin }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You need Admin+ permissions to use this command.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const announcement = options.getString('message');
    let successCount = 0;

    const announceEmbed = new EmbedBuilder()
        .setTitle('📢 Server-Wide Announcement')
        .setDescription(announcement)
        .setColor(0xFF4500)
        .setTimestamp();

    const channels = guild.channels.cache.filter(c =>
        c.isTextBased() &&
        c.permissionsFor(client.user).has(PermissionFlagsBits.SendMessages)
    );

    await interaction.editReply(`📡 Attempting to send to ${channels.size} channels...`);

    for (const [id, chan] of channels) {
        try {
            await chan.send({ embeds: [announceEmbed] });
            successCount++;
            await new Promise(res => setTimeout(res, 500));
        } catch (e) {
            console.error(`Could not send to ${chan.name}`);
        }
    }

    return interaction.editReply(`✅ Finished! Sent to **${successCount}** channels.`);
}

module.exports = {
    help,
    ping,
    restart,
    status,
    'latest-update': latestUpdate,
    togglecommand,
    'latest-action': latestAction,
    role,
    clearall,
    globalannounce,
};
