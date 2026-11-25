// /confess — anonymous confessions (logic lives in ./core.js, shared with the
// type-in-the-channel feature in ./channel.js).
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
const { publishConfession } = require('./core');

async function handleConfess({ interaction, client, db, user, safeSave }) {
    const text = String(interaction.options.getString('message') || '').trim();
    const result = await publishConfession({ client, db, user, text, safeSave });
    if (!result.ok) return interaction.editReply(result.error);
    return interaction.editReply(`✅ Your confession was posted anonymously in <#${result.publicChannel.id}>: ${result.posted.url}`);
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
