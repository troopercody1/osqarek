const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

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

// --- Migrated from index.js legacy command chain ---

async function mute({ interaction, options, guild, user, isTrial, logAction }) {
    if (!isTrial) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target');
    const m = options.getInteger('minutes') || 10;
    const reason = options.getString('reason') || 'No reason provided';

    await guild.members.cache.get(target.id).timeout(m * 60000, reason);

    logAction(guild, '🔇 Mute', `**User:** ${target.tag}\n**Duration:** ${m}m\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`, 0xFFA500);
    return interaction.editReply(`🔇 Muted ${target.tag} for ${m} minutes.`);
}

async function unmute({ interaction, options, guild, user, isTrial, logAction }) {
    if (!isTrial) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getMember('target');
    if (!target.communicationDisabledUntil) return interaction.editReply("❌ User is not muted.");

    await target.timeout(null);

    logAction(guild, '🔊 Unmute', `**User:** ${target.user.tag}\n**Moderator:** ${user.tag}`, 0x00FF00);
    return interaction.editReply(`🔊 Unmuted **${target.user.tag}**.`);
}

async function slowmode({ interaction, options, guild, channel, user, isMod, logAction }) {
    if (!isMod) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const seconds = options.getInteger('seconds');
    await channel.setRateLimitPerUser(seconds);

    logAction(guild, '⏳ Slowmode', `**Channel:** ${channel}\n**Set to:** ${seconds}s\n**Moderator:** ${user.tag}`, 0x3498DB);
    return interaction.editReply(`✅ Slowmode set to **${seconds}s**.`);
}

async function caseView({ interaction, options, isTrial, db }) {
    if (!isTrial) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const c = db.cases.find(x => x.id === options.getInteger('id'));
    if (!c) return interaction.editReply("❌ Case not found.");
    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`Case #${c.id}`).addFields({ name: 'User', value: c.user }, { name: 'Reason', value: c.reason })] });
}

async function reason({ interaction, options, isMod, db }) {
    if (!isMod) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const c = db.cases.find(x => x.id === options.getInteger('id'));
    if (c) { c.reason = options.getString('new_reason'); await db.save(); return interaction.editReply("✅ Case updated."); }
    return interaction.editReply("❌ Case not found.");
}

// --- /warn (subcommand dispatcher) ---

async function warnAdd({ interaction, options, guild, user, isTrial, db, logAction, applyEscalation }) {
    if (!isTrial) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target');
    const reasonText = options.getString('reason') || 'No reason provided.';
    const targetMember = target ? guild.members.cache.get(target.id) : null;

    if (target.id === user.id) return interaction.editReply("❌ You cannot warn yourself.");
    if (targetMember && targetMember.roles.cache.has('772558550555295794')) {
        return interaction.editReply("❌ You cannot warn another staff member. Use `/strike` instead.");
    }

    const { action, caseId } = await applyEscalation(guild, target, targetMember, reasonText, user.tag);
    logAction(guild, `🛡️ Case #${caseId} | ${action}`, `**Target:** ${target.tag}\n**Moderator:** ${user.tag}\n**Reason:** ${reasonText}`, 0xFFCC00);
    return interaction.editReply(`✅ **${target.tag}** warned. Result: **${action}** (Case #${caseId})`);
}

async function warnDelete({ interaction, options, guild, user, isMod, db, logAction }) {
    if (!isMod) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target');

    const userCases = db.cases.filter(c => c.userId === target.id);
    if (userCases.length === 0) {
        return interaction.editReply("❌ That user has no cases to remove.");
    }

    const lastCaseIndex = db.cases.map(c => c.userId).lastIndexOf(target.id);
    db.cases.splice(lastCaseIndex, 1);

    db.offences[target.id] = db.cases.filter(c => c.userId === target.id).length;

    await db.save();
    logAction(guild, '➖ Warn Removed', `User: ${target.tag}\nMod: ${user.tag}`);
    return interaction.editReply("✅ Removed 1 offence and deleted the most recent case.");
}

async function warnClear({ interaction, options, guild, user, isAtLeastAdmin, db, logAction }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Administrator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target'); db.offences[target.id] = 0; await db.save();
    logAction(guild, '♻️ Warns Cleared', `User: ${target.tag}\nMod: ${user.tag}`);
    return interaction.editReply("✅ Cleared all offences.");
}

async function warnOffenseClear({ interaction, options, guild, user, isAtLeastAdmin, db, logAction }) {
    if (!isAtLeastAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Administrator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target');
    db.offences[target.id] = 0;
    await db.save();
    logAction(guild, '♻️ Offence Count Cleared', `User: ${target.tag}\nMod: ${user.tag}`);
    return interaction.editReply(`✅ Cleared **${target.tag}**'s offence count. Their case history has been kept.`);
}

async function warnOffences({ interaction, options, user, db }) {
    const target = options.getUser('target') || user;
    return interaction.editReply(`📊 ${target.tag} has **${db.offences[target.id] || 0}** offences.`);
}

async function warnView({ interaction, options, isTrial, db }) {
    if (!isTrial) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = options.getUser('target');

    const userCases = (db.cases || []).filter(c => c.userId === target.id);

    const history = userCases.map(c => {
        let caseTime = null;

        const possibleFields = [c.timestamp, c.createdAt, c.date, c.time, c.issuedAt];
        for (const field of possibleFields) {
            if (field && !isNaN(new Date(field).getTime())) {
                caseTime = new Date(field).getTime();
                break;
            }
        }

        if (!caseTime) {
            const timeKey = Object.keys(c).find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('date'));
            if (timeKey && !isNaN(new Date(c[timeKey]).getTime())) {
                caseTime = new Date(c[timeKey]).getTime();
            }
        }

        if (caseTime) {
            const unixSeconds = Math.floor(caseTime / 1000);
            return `#${c.id} [${c.type.toUpperCase()}] ${c.reason} — <t:${unixSeconds}:f>`;
        } else {
            return `#${c.id} [${c.type.toUpperCase()}] ${c.reason} — *(No date logged)*`;
        }
    }).join('\n') || "No history found for this user.";

    const embed = new EmbedBuilder()
        .setTitle(`📜 Infraction History: ${target.username}`)
        .setDescription(history)
        .setColor(userCases.length > 0 ? 0xE74C3C : 0x2ECC71)
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function warn(ctx) {
    const { options } = ctx;
    const subcommand = options.getSubcommand();
    const group = options.getSubcommandGroup(false);

    if (group === 'offense' && subcommand === 'clear') return warnOffenseClear(ctx);
    if (subcommand === 'add') return warnAdd(ctx);
    if (subcommand === 'delete') return warnDelete(ctx);
    if (subcommand === 'clear') return warnClear(ctx);
    if (subcommand === 'offences') return warnOffences(ctx);
    if (subcommand === 'view') return warnView(ctx);
    return ctx.interaction.editReply('❌ Unknown warn subcommand.');
}

// --- /mod (subcommand dispatcher) ---

async function mod({ interaction, options, guild, user, isMod, isTrial, isAtLeastAdmin, db, logAction, logActionWithEvidence }) {
    if (db.moderationEnabled === false) return interaction.editReply('🚫 The Moderation module is currently disabled.');
    const subcommand = interaction.options.getSubcommand();
    const target = options.getUser('target');
    const reasonText = options.getString('reason') || 'No reason provided.';
    const targetMember = target ? guild.members.cache.get(target.id) : null;

    switch (subcommand) {
        case 'kick': {
            if (!isMod) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Moderator+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const kickEvidence = options.getAttachment('evidence');
            if (!kickEvidence) return interaction.editReply("❌ Evidence (an attachment) is required to use `/mod kick`.");

            await logActionWithEvidence(
                guild,
                target,
                '👢 Kick',
                `**User:** ${target.tag}\n**Reason:** ${reasonText}\n**Moderator:** ${user.tag}`,
                0xFF4500,
                '👢 You have been kicked',
                `**Server:** ${guild.name}\n**Reason:** ${reasonText}\n**Moderator:** ${user.tag}`,
                kickEvidence
            );

            await targetMember.kick(reasonText);
            return interaction.editReply(`👢 Kicked ${target.tag}.`);
        }

        case 'ban': {
            if (!isAtLeastAdmin) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Admin+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            await guild.members.ban(target, { reason: reasonText });
            logAction(guild, '🔨 Ban', `**User:** ${target.tag}\n**Reason:** ${reasonText}\n**Moderator:** ${user.tag}`, 0xFF0000);
            return interaction.editReply(`🔨 Banned ${target.tag}.`);
        }

        case 'unban': {
            if (!isAtLeastAdmin) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Admin+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const unbanId = options.getString('id');
            await guild.members.unban(unbanId);
            logAction(guild, '🔓 Unban', `**ID:** ${unbanId}\n**Moderator:** ${user.tag}`, 0x00FF00);
            return interaction.editReply(`🔓 Unbanned ID: ${unbanId}.`);
        }

        case 'mute': {
            if (!isTrial) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const muteEvidence = options.getAttachment('evidence');
            if (!muteEvidence) return interaction.editReply("❌ Evidence (an attachment) is required to use `/mod mute`.");

            const minutes = options.getInteger('minutes');
            await targetMember.timeout(minutes * 60 * 1000, reasonText);

            await logActionWithEvidence(
                guild,
                target,
                '🔇 Mute',
                `**User:** ${target.tag}\n**Duration:** ${minutes}m\n**Moderator:** ${user.tag}\n**Reason:** ${reasonText}`,
                0x808080,
                '🔇 You have been muted',
                `**Server:** ${guild.name}\n**Duration:** ${minutes} minutes\n**Reason:** ${reasonText}\n**Moderator:** ${user.tag}`,
                muteEvidence
            );

            return interaction.editReply(`🔇 Muted ${target.tag} for ${minutes} minutes.`);
        }

        case 'unmute': {
            if (!isTrial) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            await targetMember.timeout(null);
            logAction(guild, '🔊 Unmute', `**User:** ${target.tag}\n**Moderator:** ${user.tag}`, 0x00FF00);
            return interaction.editReply(`🔊 Removed timeout for ${target.tag}.`);
        }

        case 'softban': {
            if (!isAtLeastAdmin) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Admin+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            await guild.members.ban(target, { deleteMessageSeconds: 604800, reason: `Softban: ${reasonText}` });
            await guild.members.unban(target);
            logAction(guild, '☁️ Softban', `**User:** ${target.tag}\n**Reason:** ${reasonText}\n**Moderator:** ${user.tag}`, 0xFFFF00);
            return interaction.editReply(`☁️ Softbanned ${target.tag} (Messages cleared).`);
        }

        case 'purge': {
            if (!isMod) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Moderator+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const amount = options.getInteger('amount');

            const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);

            if (deleted) {
                await interaction.channel.send(`🧹 Purged **${deleted.size}** messages.`).then(msg => {
                    setTimeout(() => msg.delete().catch(() => { }), 5000);
                });
            }

            logAction(guild, '🧹 Purge', `**Amount:** ${amount}\n**Channel:** ${interaction.channel.name}\n**Moderator:** ${user.tag}`, 0x3498DB);
            return;
        }

        case 'lockdown': {
            if (!isAtLeastAdmin) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Admin+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const status = options.getBoolean('status');
            await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: !status });
            logAction(guild, status ? '🔒 Lockdown' : '🔓 Unlock', `**Channel:** ${interaction.channel.name}\n**Moderator:** ${user.tag}`, 0xE74C3C);
            return interaction.editReply(status ? `🔒 Channel locked.` : `🔓 Channel unlocked.`);
        }

        case 'dm': {
            if (!isMod) {
                console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
                return interaction.editReply("❌ You need **Moderator+** to use this.");
            }
            console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

            const messageContent = options.getString('message');

            const dmEmbed = {
                color: 0x2ECC71,
                description: `### Message from OsQarek's Universe Staff Team\n\n${messageContent}`
            };

            try {
                await target.send({ embeds: [dmEmbed] });
                logAction(guild, '📬 Staff DM Sent', `**Recipient:** ${target.tag}\n**Moderator:** ${user.tag}\n**Message:** ${messageContent}`, 0x2ECC71);
                return interaction.editReply(`✅ DM successfully sent to **${target.tag}**.`);
            } catch (e) {
                return interaction.editReply(`❌ Could not DM **${target.tag}** (DMs closed or blocked).`);
            }
        }

        default:
            return interaction.editReply('❌ Unknown /mod subcommand.');
    }
}

module.exports = {
    banlist: handleBanList,
    mute,
    unmute,
    slowmode,
    case: caseView,
    reason,
    warn,
    mod,
};
