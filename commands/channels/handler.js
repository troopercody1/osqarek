const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
    extractUserIds,
    isTempChannelBlocked,
    buildTempChannelOverwrites,
    getTempChannelRecord,
    canManageTempChannel,
} = require('../tempChannelUtils');

function slugify(name) {
    return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 90) || 'temp';
}

async function resolveMembers(guild, idList) {
    const resolved = [];
    for (const id of idList) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member && member.id !== guild.client.user.id) resolved.push(member);
    }
    return resolved;
}

async function handleAddVoice({ interaction, options, guild, user, db, createEmbed }) {
    const categoryId = process.env.TEMP_CHANNEL_CAT;
    if (!categoryId) {
        return interaction.editReply('❌ `TEMP_CHANNEL_CAT` is not configured — ask an admin to set it to a category ID.');
    }
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
        return interaction.editReply('❌ `TEMP_CHANNEL_CAT` doesn\'t point to a valid category in this server.');
    }

    if (isTempChannelBlocked(db, user.id)) {
        return interaction.editReply('🚫 You have been blocked from using temporary channels.');
    }

    const rawName = options.getString('name');
    const membersInput = options.getString('members');
    const allowedMembers = await resolveMembers(guild, extractUserIds(membersInput));
    const blockedRequested = allowedMembers.filter((m) => isTempChannelBlocked(db, m.id));
    const usableMembers = allowedMembers.filter((m) => !isTempChannelBlocked(db, m.id));
    const allowedIds = usableMembers.map((m) => m.id);

    const baseSlug = slugify(rawName);

    let voiceChannel;
    let textChannel;
    try {
        voiceChannel = await guild.channels.create({
            name: `🔊 ${rawName}`.slice(0, 100),
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: buildTempChannelOverwrites({
                guild, PermissionFlagsBits, ownerId: user.id, allowedIds, isVoice: true,
            }),
        });

        textChannel = await guild.channels.create({
            name: `text-${baseSlug}`,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: buildTempChannelOverwrites({
                guild, PermissionFlagsBits, ownerId: user.id, allowedIds, isVoice: false,
            }),
        });
    } catch (err) {
        console.error('❌ Failed to create temp channel pair:', err.message);
        if (voiceChannel) await voiceChannel.delete().catch(() => {});
        return interaction.editReply('❌ Failed to create the channel(s). Check my permissions and the category setup.');
    }

    if (!db.tempChannels) db.tempChannels = {};
    const createdAt = Date.now();
    db.tempChannels[voiceChannel.id] = { ownerId: user.id, guildId: guild.id, type: 'voice', pairId: textChannel.id, allowed: allowedIds, createdAt };
    db.tempChannels[textChannel.id] = { ownerId: user.id, guildId: guild.id, type: 'text', pairId: voiceChannel.id, allowed: allowedIds, createdAt };
    await db.save();

    const embed = createEmbed({
        title: '✅ Temp Channel Created',
        description:
            `**Voice:** <#${voiceChannel.id}>\n**Text:** <#${textChannel.id}>\n\n` +
            `**Allowed:** ${allowedIds.length ? allowedIds.map((id) => `<@${id}>`).join(', ') : 'Just you'}` +
            (blockedRequested.length ? `\n\n⚠️ Skipped (blocked from temp channels): ${blockedRequested.map((m) => `<@${m.id}>`).join(', ')}` : ''),
        footer: 'Manage it anytime with /channel',
    });

    return interaction.editReply({ embeds: [embed] });
}

async function handleDelete({ interaction, options, guild, channel, user, isMod, db }) {
    const targetChannel = options.getChannel('channel') || channel;
    const record = getTempChannelRecord(db, targetChannel.id);

    if (!record) {
        return interaction.editReply('❌ That channel isn\'t a tracked temp channel.');
    }
    if (!canManageTempChannel(record, user.id, isMod)) {
        return interaction.editReply('❌ You don\'t own that channel (and aren\'t a moderator).');
    }

    const idsToDelete = [targetChannel.id];
    if (record.pairId) idsToDelete.push(record.pairId);

    await interaction.editReply(`🗑️ Deleting ${idsToDelete.map((id) => `<#${id}>`).join(' and ')}...`);

    for (const id of idsToDelete) {
        const ch = guild.channels.cache.get(id);
        if (ch) await ch.delete().catch((err) => console.error(`❌ Failed to delete temp channel ${id}:`, err.message));
        if (db.tempChannels) delete db.tempChannels[id];
    }
    await db.save();
}

async function handleMemberAdd({ interaction, options, guild, channel, user, isMod, db }) {
    const targetChannel = options.getChannel('channel') || channel;
    const record = getTempChannelRecord(db, targetChannel.id);
    const target = options.getUser('target');

    if (!record) {
        return interaction.editReply('❌ That channel isn\'t a tracked temp channel.');
    }
    if (!canManageTempChannel(record, user.id, isMod)) {
        return interaction.editReply('❌ You don\'t own that channel (and aren\'t a moderator).');
    }
    if (isTempChannelBlocked(db, target.id)) {
        return interaction.editReply(`🚫 **${target.tag}** has been blocked from temporary channels and can't be added.`);
    }

    const idsToUpdate = [targetChannel.id, ...(record.pairId ? [record.pairId] : [])];
    for (const id of idsToUpdate) {
        const ch = guild.channels.cache.get(id);
        if (!ch) continue;
        const rec = getTempChannelRecord(db, id);
        const isVoice = rec ? rec.type === 'voice' : ch.type === ChannelType.GuildVoice;
        await ch.permissionOverwrites.edit(target.id, isVoice
            ? { ViewChannel: true, Connect: true, Speak: true }
            : { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
        ).catch((err) => console.error(`❌ Failed to grant access on ${id}:`, err.message));

        if (rec && !rec.allowed.includes(target.id)) rec.allowed.push(target.id);
    }
    await db.save();

    return interaction.editReply(`✅ Added **${target.tag}** to <#${targetChannel.id}>${record.pairId ? ' and its paired channel' : ''}.`);
}

async function handleMemberDelete({ interaction, options, guild, channel, user, isMod, db }) {
    const targetChannel = options.getChannel('channel') || channel;
    const record = getTempChannelRecord(db, targetChannel.id);
    const target = options.getUser('target');

    if (!record) {
        return interaction.editReply('❌ That channel isn\'t a tracked temp channel.');
    }
    if (!canManageTempChannel(record, user.id, isMod)) {
        return interaction.editReply('❌ You don\'t own that channel (and aren\'t a moderator).');
    }

    const idsToUpdate = [targetChannel.id, ...(record.pairId ? [record.pairId] : [])];
    for (const id of idsToUpdate) {
        const ch = guild.channels.cache.get(id);
        if (!ch) continue;
        await ch.permissionOverwrites.delete(target.id).catch((err) => console.error(`❌ Failed to revoke access on ${id}:`, err.message));

        const rec = getTempChannelRecord(db, id);
        if (rec) rec.allowed = rec.allowed.filter((id2) => id2 !== target.id);

        if (ch.type === ChannelType.GuildVoice) {
            const targetMember = guild.members.cache.get(target.id);
            if (targetMember?.voice?.channelId === ch.id) {
                await targetMember.voice.disconnect().catch(() => {});
            }
        }
    }
    await db.save();

    return interaction.editReply(`✅ Removed **${target.tag}** from <#${targetChannel.id}>${record.pairId ? ' and its paired channel' : ''}.`);
}

async function handleChannel(ctx) {
    const { interaction, options } = ctx;
    const subcommand = options.getSubcommand();

    switch (subcommand) {
        case 'add-voice':
            return handleAddVoice(ctx);
        case 'delete':
            return handleDelete(ctx);
        case 'member-add':
            return handleMemberAdd(ctx);
        case 'member-delete':
            return handleMemberDelete(ctx);
        default:
            return interaction.editReply('❌ Unknown subcommand.');
    }
}

module.exports = {
    channel: handleChannel,
};
