// Anything a member types in CONFESSION_CHANNEL is deleted and re-posted as an
// anonymous confession. Also handles the "Reply" button + its modal.
const axios = require('axios');
const path = require('path');
const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
} = require('discord.js');
const { publishConfession, publishReply, REPLY_BUTTON_ID, REPLY_MODAL_PREFIX } = require('./core');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Download the first image attachment and give it a neutral file name, so the
// original upload can be deleted without losing it (and without leaking the name).
async function grabImage(message) {
    const att = message.attachments.find((a) => (a.contentType || '').startsWith('image/') && a.size <= MAX_IMAGE_BYTES);
    if (!att) return null;
    try {
        const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 15_000, maxContentLength: MAX_IMAGE_BYTES });
        const ext = (path.extname(new URL(att.url).pathname) || '.png').toLowerCase();
        return { buffer: Buffer.from(res.data), name: `confession${ext}` };
    } catch (err) {
        console.error('❌ [confess] Could not download attachment:', err.message);
        return null;
    }
}

/** Call from messageCreate. Returns true if the message was consumed. */
async function handleConfessionChannelMessage(message, { client, db, safeSave }) {
    const channelId = (process.env.CONFESSION_CHANNEL || '').trim();
    if (!channelId || message.channel.id !== channelId) return false;
    if (message.author.bot || !message.guild) return false;

    const text = message.content || '';
    const hasAttachment = message.attachments.size > 0;
    if (!text.trim() && !hasAttachment) return true; // stickers etc. — ignore

    const image = hasAttachment ? await grabImage(message) : null;
    if (!text.trim() && !image) return true; // attachment we couldn't use

    // Publish first, delete second: if posting fails the user's message survives.
    const result = await publishConfession({ client, db, user: message.author, text, image, safeSave });

    // Remove the original either way — it must never stay visible in the channel.
    await message.delete().catch((err) =>
        console.error('❌ [confess] Failed to delete original message (needs Manage Messages):', err.message));

    if (!result.ok) {
        // We can't reply ephemerally to a normal message, so DM the reason.
        message.author.send(`${result.error}\n\nYour message in <#${channelId}> was removed.`).catch(() => { });
    }
    return true;
}

/** Call from interactionCreate for buttons. Returns true if handled. */
async function handleReplyButton(interaction) {
    if (!interaction.isButton() || interaction.customId !== REPLY_BUTTON_ID) return false;

    const modal = new ModalBuilder()
        .setCustomId(`${REPLY_MODAL_PREFIX}${interaction.message.id}`)
        .setTitle('Anonymous Reply')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('confreply_content')
                .setLabel('Your reply (posted anonymously)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1800)
        ));
    await interaction.showModal(modal);
    return true;
}

/** Call from interactionCreate for modal submits. Returns true if handled. */
async function handleReplyModal(interaction, { client, db, safeSave }) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith(REPLY_MODAL_PREFIX)) return false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetMessageId = interaction.customId.slice(REPLY_MODAL_PREFIX.length);
    const text = interaction.fields.getTextInputValue('confreply_content');

    const result = await publishReply({ client, db, user: interaction.user, text, targetMessageId, safeSave });
    await interaction.editReply(result.ok ? `✅ Your anonymous reply was posted: ${result.posted.url}` : result.error);
    return true;
}

module.exports = { handleConfessionChannelMessage, handleReplyButton, handleReplyModal };
