async function handleBanList({ interaction, guild, isMod, createEmbed }) {
    if (!isMod) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You do not have permission to view the ban list.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const bans = await guild.bans.fetch().catch((err) => {
        console.error('❌ Failed to fetch ban list:', err.message);
        return null;
    });

    if (!bans) {
        return interaction.editReply("❌ I couldn't fetch the ban list. Check my permissions.");
    }

    if (!bans.size) {
        return interaction.editReply('✅ There are no banned users.');
    }

    const lines = bans
        .map((ban) => `**${ban.user.tag}** (\`${ban.user.id}\`)${ban.reason ? ` - ${ban.reason}` : ''}`)
        .slice(0, 20);

    const embed = createEmbed({
        title: `🔨 Ban List (${bans.size})`,
        description: lines.join('\n'),
        footer: bans.size > 20 ? 'Showing the first 20 bans' : "OsQarek's Universe",
        timestamp: false,
    });

    return interaction.editReply({ embeds: [embed] });
}

module.exports = {
    banlist: handleBanList,
};
