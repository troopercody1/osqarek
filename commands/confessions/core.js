// Shared confession logic, used by BOTH the /confess slash command and the
// "type in the confessions channel" feature, plus anonymous replies.
//
// Anonymity rules (unchanged): the public post never contains the author.
// The real author is only ever written to the staff channel CONFESSION_LOGS.
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
} = require('discord.js');

const COOLDOWN_MS = 30_000;
const REPLY_COOLDOWN_MS = 10_000;
const MAX_STORED = 500;
const lastConfession = new Map(); // userId -> timestamp (in-memory)
const lastReply = new Map();

// customId of the public "Reply" button. The modal id carries the id of the
// message being replied to: `confreplymodal_<messageId>`.
const REPLY_BUTTON_ID = 'confreply';
const REPLY_MODAL_PREFIX = 'confreplymodal_';

function replyRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(REPLY_BUTTON_ID)
            .setLabel('Reply')
            .setEmoji('💬')
            .setStyle(ButtonStyle.Secondary)
    );
}

async function getTextChannel(client, id) {
    if (!id) return null;
    try {
        const channel = await client.channels.fetch(id);
        return channel && channel.isTextBased() && 'send' in channel ? channel : null;
    } catch {
        return null;
    }
}

function isBanned(db, userId) {
    return (db.confessionBans || []).some((b) => b.userId === userId);
}

function hasBannedWord(db, text) {
    const lowered = text.toLowerCase();
    return (db.bannedWords || []).some((w) => w && lowered.includes(String(w).toLowerCase()));
}

// image: optional { buffer, name } — re-uploaded by the bot so the original
// (which carries the author's name in the URL/metadata) can be deleted.
const makeFile = (image) => new AttachmentBuilder(image.buffer, { name: image.name });

/**
 * Validate + publish a confession.
 * Returns { ok: true, posted, number, publicChannel } or { ok: false, error }.
 */
async function publishConfession({ client, db, user, text, image, safeSave }) {
    const channelId = (process.env.CONFESSION_CHANNEL || '').trim();
    const logsId = (process.env.CONFESSION_LOGS || '').trim();

    if (!channelId || !logsId) {
        return { ok: false, error: '❌ Confessions are not set up yet. Staff need to set `CONFESSION_CHANNEL` and `CONFESSION_LOGS`.' };
    }
    if (isBanned(db, user.id)) {
        return { ok: false, error: '🚫 You aren\'t allowed to use confessions. Contact staff if you think this is a mistake.' };
    }

    text = String(text || '').trim();
    if (!text && !image) return { ok: false, error: '❌ Your confession can\'t be empty.' };

    const wait = COOLDOWN_MS - (Date.now() - (lastConfession.get(user.id) || 0));
    if (wait > 0) {
        return { ok: false, error: `⏳ Please wait ${Math.ceil(wait / 1000)}s before sending another confession.` };
    }
    if (hasBannedWord(db, text)) {
        return { ok: false, error: '❌ Your confession contains a word that isn\'t allowed in this server.' };
    }

    // Require BOTH channels to be reachable before posting, so nothing is ever
    // published anonymously without a staff log entry behind it.
    const [publicChannel, logChannel] = await Promise.all([
        getTextChannel(client, channelId),
        getTextChannel(client, logsId),
    ]);
    if (!publicChannel || !logChannel) {
        console.error('❌ [confess] CONFESSION_CHANNEL or CONFESSION_LOGS is missing or not a text channel the bot can access.');
        return { ok: false, error: '❌ Confessions are misconfigured right now. Please let staff know.' };
    }

    db.confessionCount = (db.confessionCount || 0) + 1;
    const number = db.confessionCount;

    const publicEmbed = new EmbedBuilder()
        .setTitle(`🤫 Anonymous Confession #${number}`)
        .setColor(0x5865F2)
        .setFooter({ text: 'Type in this channel to confess anonymously' })
        .setTimestamp();
    if (text) publicEmbed.setDescription(text);
    if (image) publicEmbed.setImage(`attachment://${image.name}`);

    let posted;
    try {
        // allowedMentions: [] so a confession can't ping @everyone / roles / users.
        posted = await publicChannel.send({
            embeds: [publicEmbed],
            components: [replyRow()],
            files: image ? [makeFile(image)] : [],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        db.confessionCount -= 1;
        console.error('❌ [confess] Failed to post confession:', err.message);
        return { ok: false, error: '❌ I couldn\'t post your confession. Please try again later.' };
    }

    lastConfession.set(user.id, Date.now());

    if (!Array.isArray(db.confessions)) db.confessions = [];
    db.confessions.push({
        number,
        userId: user.id,
        username: user.tag ?? user.username,
        text: text || '[image only]',
        url: posted.url,
        at: new Date().toISOString(),
    });
    if (db.confessions.length > MAX_STORED) db.confessions.splice(0, db.confessions.length - MAX_STORED);
    safeSave().catch(() => { });

    try {
        const logEmbed = new EmbedBuilder()
            .setTitle(`📝 Confession #${number} — Author Log`)
            .addFields(
                { name: 'Author', value: `${user.tag ?? user.username} (<@${user.id}>)`, inline: true },
                { name: 'User ID', value: user.id, inline: true },
                { name: 'Posted', value: `[Jump to confession](${posted.url})`, inline: false },
            )
            .setThumbnail(user.displayAvatarURL())
            .setColor(0xFEE75C)
            .setTimestamp();
        if (text) logEmbed.setDescription(text);
        if (image) logEmbed.setImage(`attachment://${image.name}`);
        await logChannel.send({
            embeds: [logEmbed],
            files: image ? [makeFile(image)] : [],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        console.error(`❌ [confess] Posted #${number} but failed to write the author log:`, err.message);
    }

    return { ok: true, posted, number, publicChannel };
}

/**
 * Publish an anonymous reply to a confession (or to another reply).
 * Returns { ok: true, posted } or { ok: false, error }.
 */
async function publishReply({ client, db, user, text, targetMessageId, safeSave }) {
    const channelId = (process.env.CONFESSION_CHANNEL || '').trim();
    const logsId = (process.env.CONFESSION_LOGS || '').trim();

    if (!channelId || !logsId) return { ok: false, error: '❌ Confessions are not set up yet.' };
    if (isBanned(db, user.id)) {
        return { ok: false, error: '🚫 You aren\'t allowed to use confessions. Contact staff if you think this is a mistake.' };
    }

    text = String(text || '').trim();
    if (!text) return { ok: false, error: '❌ Your reply can\'t be empty.' };

    const wait = REPLY_COOLDOWN_MS - (Date.now() - (lastReply.get(user.id) || 0));
    if (wait > 0) return { ok: false, error: `⏳ Please wait ${Math.ceil(wait / 1000)}s before replying again.` };
    if (hasBannedWord(db, text)) {
        return { ok: false, error: '❌ Your reply contains a word that isn\'t allowed in this server.' };
    }

    const [publicChannel, logChannel] = await Promise.all([
        getTextChannel(client, channelId),
        getTextChannel(client, logsId),
    ]);
    if (!publicChannel || !logChannel) {
        return { ok: false, error: '❌ Confessions are misconfigured right now. Please let staff know.' };
    }

    // Work out which confession this thread belongs to, for the title.
    let label = '';
    try {
        const target = await publicChannel.messages.fetch(targetMessageId);
        const m = target.embeds?.[0]?.title?.match(/#(\d+)/);
        if (m) label = ` to Confession #${m[1]}`;
    } catch { /* target deleted — still post, just without a reference */ }

    const embed = new EmbedBuilder()
        .setTitle(`💬 Anonymous Reply${label}`)
        .setDescription(text)
        .setColor(0x57F287)
        .setTimestamp();

    let posted;
    try {
        posted = await publicChannel.send({
            embeds: [embed],
            components: [replyRow()], // replies can be replied to as well
            reply: { messageReference: targetMessageId, failIfNotExists: false },
            allowedMentions: { parse: [], repliedUser: false },
        });
    } catch (err) {
        console.error('❌ [confess] Failed to post reply:', err.message);
        return { ok: false, error: '❌ I couldn\'t post your reply. Please try again later.' };
    }

    lastReply.set(user.id, Date.now());

    if (!Array.isArray(db.confessionReplies)) db.confessionReplies = [];
    db.confessionReplies.push({
        userId: user.id,
        username: user.tag ?? user.username,
        text,
        replyTo: targetMessageId,
        url: posted.url,
        at: new Date().toISOString(),
    });
    if (db.confessionReplies.length > MAX_STORED) db.confessionReplies.splice(0, db.confessionReplies.length - MAX_STORED);
    safeSave().catch(() => { });

    try {
        await logChannel.send({
            embeds: [new EmbedBuilder()
                .setTitle(`📝 Confession Reply${label} — Author Log`)
                .setDescription(text)
                .addFields(
                    { name: 'Author', value: `${user.tag ?? user.username} (<@${user.id}>)`, inline: true },
                    { name: 'User ID', value: user.id, inline: true },
                    { name: 'Posted', value: `[Jump to reply](${posted.url})`, inline: false },
                )
                .setThumbnail(user.displayAvatarURL())
                .setColor(0xFEE75C)
                .setTimestamp()],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        console.error('❌ [confess] Posted a reply but failed to write the author log:', err.message);
    }

    return { ok: true, posted };
}

module.exports = { publishConfession, publishReply, REPLY_BUTTON_ID, REPLY_MODAL_PREFIX };
