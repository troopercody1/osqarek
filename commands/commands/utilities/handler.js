const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const dayjs = require('dayjs');

const BRAND_COLOR = '#5500FF';

let hf = null;
try {
    // v2's HfInference talked to the now-retired api-inference.huggingface.co.
    // InferenceClient (v3+) routes through router.huggingface.co instead.
    const { InferenceClient } = require('@huggingface/inference');
    hf = process.env.HF_TOKEN ? new InferenceClient(process.env.HF_TOKEN) : null;
} catch (err) {
    console.error('❌ Failed to initialize InferenceClient for utilities module:', err.message);
}

async function userinfo({ interaction }) {
    const target = interaction.options.getMember('target') || interaction.member;

    const embed = new EmbedBuilder()
        .setTitle(`👤 User Info: ${target.user.tag}`)
        .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
        .setColor(0x00FFFF)
        .addFields(
            { name: '🆔 User ID', value: `\`${target.id}\``, inline: true },
            { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
            { name: '🚀 Created Account', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: '🎭 Top Role', value: `${target.roles.highest}`, inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

async function serverinfo({ interaction }) {
    const { guild } = interaction;

    const embed = new EmbedBuilder()
        .setTitle(`🏰 ${guild.name} | Universe Specs`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setColor(0xFF00FF)
        .addFields(
            { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
            { name: '👥 Members', value: `\`${guild.memberCount}\``, inline: true },
            { name: '✨ Boosts', value: `Level ${guild.premiumTier}`, inline: true },
            { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

async function pfp({ interaction, db, createEmbed }) {
    if (db.utilitiesEnabled === false) return interaction.editReply('🚫 The Utilities module is currently disabled.');
    const user = interaction.options.getUser('target') || interaction.user;
    const pfpEmbed = createEmbed({
        title: `${user.username}'s Profile Picture`,
        image: user.displayAvatarURL({ size: 1024, dynamic: true }),
        timestamp: false,
    });
    return interaction.editReply({ embeds: [pfpEmbed] });
}

async function osqareksocials({ interaction, client, createEmbed }) {
    const socialEmbed = createEmbed({
        title: '🔗 Official OsQarek Links',
        description: 'Stay connected with the OsQarek across all platforms!',
        thumbnail: client.user.displayAvatarURL(),
        footer: 'OsQarek\'s Universe • Official Socials',
        timestamp: false,
        fields: [
            { name: '🎮 Roblox', value: '[Follow OsQarek on Roblox!](https://www.roblox.com/users/3232149484/profile?friendshipSourceType=PlayerSearch)', inline: true },
            { name: '🏰 OsQarek\'s Universe', value: '[Play the Game](https://www.roblox.com/games/122256355143828/OsQareks-Universe)', inline: true },
            { name: '📺 YouTube', value: '[Subscribe](https://www.youtube.com/channel/UCzbWsgIRlrg1yTzD1SwsBAw)', inline: true },
            { name: '🐦 Twitter', value: '[Follow](https://x.com/OQarek)', inline: true },
            { name: '📸 Instagram', value: '[Follow](https://www.instagram.com/oscarek2304/)', inline: true },
            { name: '🎵 Spotify', value: '[Listen](https://open.spotify.com/artist/1pJNyBvcufHketSgMj3upF?si=2c403446d85648cc)', inline: true },
        ],
    });

    return interaction.editReply({ embeds: [socialEmbed] });
}

async function poll({ interaction, db }) {
    if (db.utilitiesEnabled === false) return interaction.editReply('🚫 The Utilities module is currently disabled.');
    const question = interaction.options.getString('question');
    const pollEmbed = new EmbedBuilder()
        .setTitle('📊 New Poll')
        .setDescription(question)
        .setColor(0x9B59B6)
        .setFooter({ text: `Asked by ${interaction.user.username}` });

    const message = await interaction.editReply({ embeds: [pollEmbed], fetchReply: true });
    await message.react('👍');
    await message.react('👎');
}

async function askRules({ interaction }) {
    if (!hf) return interaction.editReply('🚫 The AI module is not configured (missing HF_TOKEN).');
    const question = interaction.options.getString('question');

    // Updated Rules & Warning System Context for the AI
    const rulesText = `
OsQarek's Universe Rules:
1. Respectful communication, no bullying.
2. No spam (except in #spam).
3. Respect privacy.
4. No self-promotion (except in #self-promo).
5. Follow Discord ToS.
6. No NSFW.

Warning System (Escalation Ladder):
- 1st offence: Official Warn
- 2nd offence: 10m mute
- 3rd offence: 30m mute
- 4th offence: Kick
- 5th offence: Kick
- 6th offence: 1d ban
- 7th offence: Permanent ban
`;

    const response = await hf.chatCompletion({
        model: "Qwen/Qwen3.8-27B",
        provider: "featherless-ai",
        messages: [
            {
                role: "system",
                content: `You are the Rules Assistant for OsQarek's Universe. Be helpful but firm. Use these rules and the specific warning ladder to answer: ${rulesText}`
            },
            { role: "user", content: question }
        ]
    });

    // Added a small "Dark Neon" purple dot to identify AI responses
    return interaction.editReply(`🔮 **Universe AI:** ${response.choices[0].message.content}`);
}

async function summarize({ interaction, createEmbed }) {
    if (!hf) return interaction.editReply('🚫 The AI module is not configured (missing HF_TOKEN).');
    const messages = await interaction.channel.messages.fetch({ limit: 50 });
    const textContent = messages.map(m => `${m.author.username}: ${m.content}`).join('\n');

    const response = await hf.chatCompletion({
        model: "Qwen/Qwen3.8-27B",
        provider: "featherless-ai",
        messages: [
            { role: "system", content: "Summarize the following chat conversation in 3 bullet points." },
            { role: "user", content: textContent }
        ]
    });

    const summaryEmbed = createEmbed({
        title: '🛰️ Channel Summary (Last 50 Msgs)',
        description: response.choices[0].message.content,
        timestamp: false,
    });

    return interaction.editReply({ embeds: [summaryEmbed] });
}

async function announce({ interaction, options, channel, isMod }) {
    if (!isMod) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);
    const chan = options.getChannel('channel') || channel;
    chan.send({ embeds: [new EmbedBuilder().setDescription(options.getString('message')).setColor(0x3498DB)] });
    return interaction.editReply("✅ Announcement sent.");
}

async function afk({ interaction, options, member, user, db }) {
    const reason = options.getString('reason') || 'AFK';
    db.afk[user.id] = { reason: reason, timestamp: Date.now() };
    await db.save();

    if (member.manageable && !member.displayName.startsWith('[AFK] ')) {
        member.setNickname(`[AFK] ${member.displayName}`).catch(() => { });
    }
    return interaction.editReply(`💤 I've set your AFK: **${reason}**`);
}

async function reminder({ interaction, options, user, db }) {
    const timeInput = options.getString('time');
    const task = options.getString('task');
    const date = dayjs(timeInput);

    if (!date.isValid() || date.isBefore(dayjs())) {
        return interaction.editReply({
            content: "❌ Invalid date/time. Please use `YYYY-MM-DD HH:mm`."
        });
    }

    const endTimestamp = date.valueOf();
    db.reminders.push({
        userId: user.id,
        channelId: interaction.channelId,
        task: task,
        expiresAt: endTimestamp
    });
    await db.save();

    const embed = new EmbedBuilder()
        .setTitle('⏰ Reminder Set')
        .setDescription(`**Task:** ${task}`)
        .addFields(
            { name: 'Scheduled For', value: `<t:${Math.floor(endTimestamp / 1000)}:F>`, inline: false }
        )
        .setColor(0x00FF00);

    return interaction.editReply({ embeds: [embed] });
}

async function emojiNames({ interaction }) {
    const prefix = interaction.options.getString('prefix');
    const suffix = interaction.options.getString('suffix');
    const isRestoring = !prefix && !suffix;

    const members = await interaction.guild.members.fetch();
    const manageableMembers = members.filter(m => !m.user.bot && m.manageable);

    await interaction.editReply(`✨ *Emoji Name Started...** [Targeting ${manageableMembers.size} users]`);

    let count = 0;
    for (const member of manageableMembers.values()) {
        try {
            if (isRestoring) {
                if (member.nickname) { await member.setNickname(null); count++; }
            } else {
                const newNick = `${prefix || ''} ${member.displayName} ${suffix || ''}`.trim();
                if (newNick !== member.displayName && newNick.length <= 32) {
                    await member.setNickname(newNick);
                    count++;
                }
            }
            await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
            console.error(`Error: ${err.message}`);
        }
    }
    return interaction.followUp(`✅ **Emoji Name Complete:** ${count} usernames updated.`);
}

async function random({ interaction, guild }) {
    const members = await guild.members.fetch();
    const rand = members.random();
    return interaction.editReply(`🎲 Random pick: ${rand}`);
}

// --- Migrated from index.js legacy command chain ---

async function ship({ interaction, createEmbed }) {
    let u1 = interaction.options.getUser('user1');
    let u2 = interaction.options.getUser('user2');

    if (!u1 || !u2) {
        const members = await interaction.channel.members.filter(m => !m.user.bot);
        const randoms = members.random(2);
        u1 = u1 || randoms[0].user;
        u2 = u2 || randoms[1].user;
    }

    const lovePercent = Math.floor(Math.random() * 101);
    const shipEmbed = createEmbed({
        title: '💖 Universe Matchmaker',
        description: `**${u1.username}** & **${u2.username}**\n\n**Match:** ${lovePercent}%`,
        color: lovePercent > 50 ? '#FF00FF' : BRAND_COLOR,
    });

    await interaction.editReply({ embeds: [shipEmbed] });
}

async function reactionrole({ interaction, createEmbed }) {
    const text = interaction.options.getString('text');
    const role = interaction.options.getRole('role');
    const targetChannel = interaction.options.getChannel('channel');
    const time = interaction.options.getInteger('time');

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ Only higher-ups can distribute cosmic roles.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const roleEmbed = createEmbed({
        title: '🌌 Universe Role Assignment',
        description: text,
        fields: [{ name: 'Role', value: `${role}`, inline: true }],
    });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rr_${role.id}`)
            .setLabel(`Get ${role.name}`)
            .setStyle(ButtonStyle.Primary)
    );

    const sentMessage = await targetChannel.send({ embeds: [roleEmbed], components: [row] });
    await interaction.editReply(`✅ Reaction role sent to ${targetChannel}!`);

    if (time) {
        setTimeout(async () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`expired_${role.id}`)
                    .setLabel('Expired')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
            await sentMessage.edit({ components: [disabledRow] }).catch(() => { });
        }, time * 1000);
    }
}

async function userignore({ interaction, db }) {
    const target = interaction.options.getUser('target');

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Administrator** permissions to banish users from the Universe.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    if (!db.ignoredUsers) db.ignoredUsers = [];

    const isIgnored = db.ignoredUsers.includes(target.id);

    if (isIgnored) {
        db.ignoredUsers = db.ignoredUsers.filter(id => id !== target.id);
        await interaction.editReply(`✨ **${target.username}** has been unbanned from using the bot.`);
    } else {
        db.ignoredUsers.push(target.id);
        await interaction.editReply(`🌌 **${target.username}** is now banned from using all bot features.`);
    }

    await db.save();
}

async function nickname({ interaction, db }) {
    const target = interaction.options.getMember('target');
    const newName = interaction.options.getString('name');
    const shouldModerate = interaction.options.getBoolean('moderate') || false;
    const reasonText = interaction.options.getString('reason') || 'No reason provided';

    if (!target.manageable) return await interaction.editReply("❌ I don't have permission to modify that user.");

    let finalName = newName;
    const modTag = `ModeratedNickname#${target.id.slice(-4)}`;
    if (shouldModerate) finalName = modTag;

    try {
        if (shouldModerate) {
            const userEmbed = new EmbedBuilder()
                .setTitle('🛡️ Nickname Moderated')
                .setDescription(`Your nickname in **${interaction.guild.name}** was updated to meet server standards.`)
                .addFields(
                    { name: 'New Nickname', value: `\`${modTag}\``, inline: true },
                    { name: 'Reason', value: reasonText, inline: true }
                )
                .setColor(0xFF0000)
                .setTimestamp();

            await target.send({ embeds: [userEmbed] }).catch(() => console.log("User DMs closed."));
        }

        await target.setNickname(finalName);

        const logChannel = interaction.guild.channels.cache.get(db.modLogChannel);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle('📝 Nickname Action')
                .setColor(shouldModerate ? 0xFF0000 : 0x00FF00)
                .addFields(
                    { name: 'Target', value: `${target.user.tag} (${target.id})`, inline: false },
                    { name: 'Moderator', value: `${interaction.user.tag}`, inline: false },
                    { name: 'Action', value: shouldModerate ? 'Manual Moderation' : 'Manual Rename', inline: true },
                    { name: 'New Name', value: `\`${finalName || 'Reset to Default'}\``, inline: true },
                    { name: 'Reason', value: reasonText, inline: false }
                )
                .setTimestamp();

            await logChannel.send({ embeds: [logEmbed] });
        }

        await interaction.editReply(`✅ **${target.user.tag}** has been updated.`);

    } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
    }
}

module.exports = {
    announce,
    afk,
    'ask-rules': askRules,
    summarize,
    poll,
    pfp,
    osqareksocials,
    userinfo,
    'emoji-names': emojiNames,
    serverinfo,
    reminder,
    random,
    ship,
    reactionrole,
    userignore,
    nickname,
};
