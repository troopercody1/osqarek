const { EmbedBuilder } = require('discord.js');
const dayjs = require('dayjs');

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
    if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
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
};
