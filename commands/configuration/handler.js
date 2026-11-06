const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

function requireAdmin(interaction, isAtLeastAdmin) {
    if (isAtLeastAdmin) {
        console.log(`DEBUG: Role check passed for /${interaction.commandName}`);
        return false;
    }
    console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
    interaction.editReply('❌ You need Admin+ permissions to use this command.');
    return true;
}

async function addmod({ interaction, options, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    if (!Array.isArray(db.modRoles)) db.modRoles = [];

    const role = options.getRole('role');
    if (!db.modRoles.includes(role.id)) db.modRoles.push(role.id);

    await db.save();
    return interaction.editReply(`✅ Mod role ${role.name} added.`);
}

async function deletemod({ interaction, options, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    const role = options.getRole('role');

    db.modRoles = (db.modRoles || []).filter((id) => id !== role.id);
    await db.save();
    return interaction.editReply('✅ Mod role removed.');
}

async function modlog({ interaction, options, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    db.modLogChannel = options.getChannel('channel').id;
    await db.save();
    return interaction.editReply('✅ Mod Log set.');
}

async function setchatlog({ interaction, options, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    db.chatLogChannel = options.getChannel('channel').id;
    await db.save();
    return interaction.editReply('✅ Chat Log set.');
}

async function setloachannel({ interaction, options, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    db.loaChannel = options.getChannel('channel').id;
    await db.save();
    return interaction.editReply(`✅ LOA Request channel set to <#${db.loaChannel}>`);
}

async function ignorechannel({ interaction, options, channel, db, isAtLeastAdmin }) {
    if (requireAdmin(interaction, isAtLeastAdmin)) return;
    if (!Array.isArray(db.ignoredChannels)) db.ignoredChannels = [];

    const channelId = String((options.getChannel('channel') || channel).id);
    const index = db.ignoredChannels.indexOf(channelId);
    const isIgnored = index > -1;

    if (isIgnored) {
        db.ignoredChannels.splice(index, 1);
    } else {
        db.ignoredChannels.push(channelId);
    }

    await db.save();
    return interaction.editReply(`✅ <#${channelId}> ${isIgnored ? 'is no longer ignored' : 'is now being ignored'}.`);
}

async function aitoggle({ interaction, db }) {
    const status = interaction.options.getBoolean('status');
    const moderator = interaction.member;
    const ownerRoleId = '771423764511981599';
    const coOwnerRoleId = '1511810524818440243';

    if (!moderator.roles.cache.has(ownerRoleId) && !moderator.roles.cache.has(coOwnerRoleId)) {
        return interaction.editReply('❌ Only Owner/Co-Owner can toggle the AI.');
    }

    db.aiEnabled = status;
    await db.save();

    const embed = new EmbedBuilder()
        .setTitle('🌌 AI System Update')
        .setDescription(`The Universe AI has been set to: **${status ? 'ENABLED' : 'DISABLED'}**`)
        .setColor(status ? '#00FF99' : '#FF0055')
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

module.exports = {
    addmod,
    deletemod,
    modlog,
    setchatlog,
    setloachannel,
    ignorechannel,
    aitoggle,
};
