// /confess — anonymous confessions.
//
//  1. Submission:   the user runs /confess and types their message. The reply
//                   is ephemeral (see the master deferral in index.js), so
//                   only they ever see the command and the confirmation.
//  2. Anonymization: the public post is a plain embed with NO author, name,
//                   ID, avatar or mention of the sender.
//  3. Publishing:   the embed is posted to CONFESSION_CHANNEL. The real author
//                   is recorded ONLY in the staff channel CONFESSION_LOGS.
//
// .env:
//   CONFESSION_CHANNEL=<channel id>   public channel confessions are posted in
//   CONFESSION_LOGS=<channel id>      private staff channel with author info
const { EmbedBuilder } = require('discord.js');

const COOLDOWN_MS = 30_000;
const MAX_STORED = 500;
const lastConfession = new Map(); // userId -> timestamp (in-memory)

async function getTextChannel(client, id) {
    if (!id) return null;
    try {
        const channel = await client.channels.fetch(id);
        return channel && channel.isTextBased() && 'send' in channel ? channel : null;
    } catch {
        return null;
    }
}

async function handleConfess({ interaction, client, db, user, safeSave }) {
    const channelId = (process.env.CONFESSION_CHANNEL || '').trim();
    const logsId = (process.env.CONFESSION_LOGS || '').trim();

    if (!channelId || !logsId) {
        return interaction.editReply('❌ Confessions are not set up yet. Staff need to set `CONFESSION_CHANNEL` and `CONFESSION_LOGS`.');
    }

    if ((db.confessionBans || []).some((b) => b.userId === user.id)) {
        return interaction.editReply('🚫 You aren\'t allowed to use confessions. Contact staff if you think this is a mistake.');
    }

    const text = String(interaction.options.getString('message') || '').trim();
    if (!text) return interaction.editReply('❌ Your confession can\'t be empty.');

    const wait = COOLDOWN_MS - (Date.now() - (lastConfession.get(user.id) || 0));
    if (wait > 0) {
        return interaction.editReply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before sending another confession.`);
    }

    const lowered = text.toLowerCase();
    if ((db.bannedWords || []).some((w) => w && lowered.includes(String(w).toLowerCase()))) {
        return interaction.editReply('❌ Your confession contains a word that isn\'t allowed in this server.');
    }

    // Require BOTH channels to be reachable before posting, so nothing is ever
    // published anonymously without a staff log entry behind it.
    const [publicChannel, logChannel] = await Promise.all([
        getTextChannel(client, channelId),
        getTextChannel(client, logsId),
    ]);
    if (!publicChannel || !logChannel) {
        console.error('❌ [confess] CONFESSION_CHANNEL or CONFESSION_LOGS is missing or not a text channel the bot can access.');
        return interaction.editReply('❌ Confessions are misconfigured right now. Please let staff know.');
    }

    db.confessionCount = (db.confessionCount || 0) + 1;
    const number = db.confessionCount;

    // Public, anonymous card — deliberately no author/thumbnail/footer identity.
    const publicEmbed = new EmbedBuilder()
        .setTitle(`🤫 Anonymous Confession #${number}`)
        .setDescription(text)
        .setColor(0x5865F2)
        .setFooter({ text: 'Submit your own anonymously with /confess' })
        .setTimestamp();

    let posted;
    try {
        // allowedMentions: [] so a confession can't ping @everyone / roles / users.
        posted = await publicChannel.send({ embeds: [publicEmbed], allowedMentions: { parse: [] } });
    } catch (err) {
        db.confessionCount -= 1;
        console.error('❌ [confess] Failed to post confession:', err.message);
        return interaction.editReply('❌ I couldn\'t post your confession. Please try again later.');
    }

    lastConfession.set(user.id, Date.now());

    // Kept for the staff dashboard (/confessions) — capped so the DB can't grow forever.
    if (!Array.isArray(db.confessions)) db.confessions = [];
    db.confessions.push({
        number,
        userId: user.id,
        username: user.tag ?? user.username,
        text,
        url: posted.url,
        at: new Date().toISOString(),
    });
    if (db.confessions.length > MAX_STORED) db.confessions.splice(0, db.confessions.length - MAX_STORED);
    safeSave().catch(() => { });

    // Staff-only log with the real author.
    try {
        const logEmbed = new EmbedBuilder()
            .setTitle(`📝 Confession #${number} — Author Log`)
            .setDescription(text)
            .addFields(
                { name: 'Author', value: `${user.tag ?? user.username} (<@${user.id}>)`, inline: true },
                { name: 'User ID', value: user.id, inline: true },
                { name: 'Posted', value: `[Jump to confession](${posted.url})`, inline: false },
            )
            .setThumbnail(user.displayAvatarURL())
            .setColor(0xFEE75C)
            .setTimestamp();
        await logChannel.send({ embeds: [logEmbed], allowedMentions: { parse: [] } });
    } catch (err) {
        console.error(`❌ [confess] Posted #${number} but failed to write the author log:`, err.message);
    }

    return interaction.editReply(`✅ Your confession was posted anonymously in <#${publicChannel.id}>: ${posted.url}`);
}

// /confession allow | disallow | list  (Moderator+)
async function handleConfessionAdmin({ interaction, options, user, db, isMod, safeSave, client }) {
    if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');

    if (!Array.isArray(db.confessionBans)) db.confessionBans = [];
    const sub = options.getSubcommand();

    if (sub === 'disallow') {
        const target = options.getUser('user');
        if (target.bot) return interaction.editReply('❌ Bots can\'t use confessions anyway.');
        if (db.confessionBans.some((b) => b.userId === target.id)) {
            return interaction.editReply(`ℹ️ **${target.tag ?? target.username}** is already disallowed.`);
        }
        db.confessionBans.push({
            userId: target.id,
            username: target.tag ?? target.username,
            reason: (options.getString('reason') || '').trim() || 'No reason given',
            by: user.tag ?? user.username,
            at: new Date().toISOString(),
        });
        await safeSave();
        return interaction.editReply(`🚫 **${target.tag ?? target.username}** can no longer use \`/confess\`.`);
    }

    if (sub === 'allow') {
        const target = options.getUser('user');
        const before = db.confessionBans.length;
        db.confessionBans = db.confessionBans.filter((b) => b.userId !== target.id);
        if (db.confessionBans.length === before) {
            return interaction.editReply(`ℹ️ **${target.tag ?? target.username}** wasn\'t disallowed.`);
        }
        await safeSave();
        return interaction.editReply(`✅ **${target.tag ?? target.username}** can use \`/confess\` again.`);
    }

    if (sub === 'list') {
        if (db.confessionBans.length === 0) return interaction.editReply('✅ Nobody is disallowed from confessions.');
        const lines = db.confessionBans.slice(0, 25).map((b) =>
            `• <@${b.userId}> (${b.username || b.userId}) — ${b.reason} _(by ${b.by})_`);
        const more = db.confessionBans.length > 25 ? `\n…and ${db.confessionBans.length - 25} more (see the dashboard).` : '';
        return interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('🚫 Disallowed from /confess').setDescription(lines.join('\n') + more).setColor(0xED4245)],
            allowedMentions: { parse: [] },
        });
    }

    return interaction.editReply('❌ Unknown confession subcommand.');
}

module.exports = { confess: handleConfess, confession: handleConfessionAdmin };
