// /mod train <rank> <user>
// Owner / Co-Owner only. DMs the chosen user a short training course (embeds)
// covering the staff commands available at the chosen rank.
//
// Permission data below mirrors the checks in index.js / commands/staff/handler.js:
//   Trial+ = isTrial, Mod+ = isMod, Admin+ = isAtLeastAdmin, Head Admin+ = isHeadAdmin.

const RANKS = {
    trial: {
        label: 'Trial Moderator',
        emoji: '🔰',
        color: 0x95A5A6,
        weekly: { min: 50, promo: 200 },
        summary: 'You are the first line of staff. You handle warnings, mutes and note-taking, and pass bigger problems up to a Moderator or higher.',
        inherits: null,
        sections: [
            {
                name: '⚠️ Warnings',
                value:
                    '`/warn add target [reason]` — issue a formal warning. Warnings **auto-escalate**:\n' +
                    '• 1st: warn • 2nd: 10m mute • 3rd: 30m mute • 4th–5th: kick • 6th: 1-day ban • 7th+: perm ban\n' +
                    '`/warn view target` — full case history for a user.\n' +
                    '`/warn offences [target]` — quick offence count.\n' +
                    '⚠️ You cannot warn other staff. Staff discipline goes through Owner/Co-Owner strikes.',
            },
            {
                name: '🔇 Mutes',
                value:
                    '`/mod mute target minutes evidence` — timeout a member. **Evidence (screenshot/attachment) is required.**\n' +
                    '`/mod unmute target` — remove a timeout.',
            },
            {
                name: '📁 Cases & Notes',
                value:
                    '`/case id` — look up a case.\n' +
                    '`/latest-action` — the last 5 moderation actions.\n' +
                    '`/notes view target` • `/notes add target note` • `/notes delete target index` — private staff notes. Check these before acting on someone.',
            },
            {
                name: '🏖️ Staff Tools',
                value:
                    '`/loa request reason duration [start]` — request leave. Dates use `YYYY-MM-DD HH:mm`.\n' +
                    '`/loa list` • `/loa end` — see who is away / end your own LOA.\n' +
                    '`/staffstats view` — your weekly message progress.\n' +
                    '`/strikes target` — check a staff member\'s strike count.',
            },
        ],
        tips: [
            'Check `/warn view` and `/notes view` before acting on someone.',
            'Always attach evidence to mutes.',
            'Not sure? Ask a Moderator or higher before acting.',
        ],
    },

    mod: {
        label: 'Moderator',
        emoji: '🛡️',
        color: 0x3498DB,
        weekly: { min: 100, promo: 250 },
        summary: 'You enforce the rules day to day and clean up chat. You keep every Trial Moderator command and gain the tools below.',
        inherits: 'Trial Moderator (warn, mute/unmute, case, notes, LOA, staffstats view)',
        sections: [
            {
                name: '👢 Enforcement',
                value:
                    '`/mod kick target evidence [reason]` — remove a member. **Evidence is required.**\n' +
                    '`/mod channel-block target` — toggle a member\'s access to temp channels (run again to unblock).\n' +
                    '`/banlist` — view current bans (first 20).',
            },
            {
                name: '🧹 Chat Control',
                value:
                    '`/mod purge amount` — bulk delete 1–100 recent messages (Discord skips messages older than 14 days).\n' +
                    '`/slowmode seconds` — set slowmode in the current channel (`0` turns it off).',
            },
            {
                name: '📬 Communication',
                value:
                    '`/mod dm target message` — send an official staff DM.\n' +
                    '`/announce message [channel]` — post an announcement embed.',
            },
            {
                name: '🗂️ Case Management',
                value:
                    '`/reason id new_reason` — fix the reason on a case.\n' +
                    '`/warn delete target` — remove a user\'s most recent case/warning (use for mistakes).\n' +
                    '`/nickname target [name] [moderate] [reason]` — change a nickname, or set `moderate` to flag an unpingable name.',
            },
        ],
        tips: [
            'Purge and kick are hard to undo — double-check the target first.',
            'Use `/reason` to keep case logs accurate for other staff.',
        ],
    },

    headmod: {
        label: 'Head Moderator',
        emoji: '🎖️',
        color: 0x2ECC71,
        weekly: { min: 150, promo: 375 },
        summary: 'Head Moderators use the same command set as Moderators — the difference is responsibility and a higher activity requirement.',
        inherits: 'Moderator and Trial Moderator (everything listed in those trainings)',
        sections: [
            {
                name: '🧰 Your Toolkit',
                value:
                    'You have the full **Moderator** command set: `/mod kick`, `/mod purge`, `/mod dm`, `/mod channel-block`, `/banlist`, `/slowmode`, `/announce`, `/reason`, `/warn delete`, `/nickname`, plus all Trial commands.',
            },
            {
                name: '🔎 Good Habits for the Role',
                value:
                    '• Use `/latest-action` and `/case id` to review recent actions.\n' +
                    '• Correct mistakes with `/reason` and `/warn delete`.\n' +
                    '• Use `/notes view` to keep decisions consistent across the team.',
            },
        ],
        tips: [
            'Your weekly minimum is higher — keep an eye on `/staffstats view`.',
            'Bans, softbans, lockdowns and role changes need an Administrator.',
        ],
    },

    admin: {
        label: 'Administrator',
        emoji: '⚙️',
        color: 0xE67E22,
        weekly: { min: 250, promo: 625 },
        summary: 'You handle the heavy actions and run staff admin. You keep every Moderator command and gain the tools below.',
        inherits: 'Head Moderator, Moderator and Trial Moderator',
        sections: [
            {
                name: '🔨 Heavy Enforcement',
                value:
                    '`/mod ban target [reason]` — permanent ban.\n' +
                    '`/mod unban id` — unban using a User ID.\n' +
                    '`/mod softban target [reason]` — ban + instant unban to wipe 7 days of messages.\n' +
                    '`/mod lockdown status` — lock (`True`) or unlock (`False`) the current channel.',
            },
            {
                name: '♻️ Records & Roles',
                value:
                    '`/warn clear target` — clear all of a user\'s offences.\n' +
                    '`/warn offense clear target` — reset the offence count to 0 but **keep case history**.\n' +
                    '`/role action target role` — add/remove a role (only roles below your own highest role).\n' +
                    '`/modlog channel` — set the mod-log channel.',
            },
            {
                name: '📊 Staff Management',
                value:
                    '`/staffstats all` — weekly progress for all staff.\n' +
                    '`/loa adminset user duration [start] [reason]` — set an LOA for a staff member.\n' +
                    '`/syncstats [audit] [dryrun] [debug]` — rebuild weekly message stats. Try `dryrun` first.\n' +
                    '`/messagereset` — reset weekly counts (all-time totals are kept).\n' +
                    '`/ping-all-staff reason` — DM + ping all staff. Emergencies only.',
            },
            {
                name: '🔑 Permission-Based',
                value:
                    '`/reactionrole` needs **Manage Roles**; `/userignore` needs **Administrator**.',
            },
        ],
        tips: [
            'Prefer `/warn offense clear` over `/warn clear` when you want to keep a paper trail.',
            'Run `/syncstats dryrun:True` before a real sync.',
        ],
    },

    headadmin: {
        label: 'Head Administrator',
        emoji: '👑',
        color: 0x9B59B6,
        weekly: { min: 375, promo: null },
        summary: 'You oversee the bot and the admin team. You keep every Administrator command and gain bot-control access.',
        inherits: 'Administrator and everything below it',
        sections: [
            {
                name: '🤖 Bot Control',
                value:
                    '`/restart` — refresh the bot session.\n' +
                    'You can still run commands that have been **disabled** for everyone else.',
            },
            {
                name: '🧰 Everything Else',
                value:
                    'All Administrator commands apply (`/mod ban`, `/mod unban`, `/mod softban`, `/mod lockdown`, `/role`, `/modlog`, `/syncstats`, `/messagereset`, `/loa adminset`, `/warn clear`).',
            },
        ],
        tips: [
            'Restart only when needed — it briefly interrupts the bot.',
            'Staff strikes are Owner/Co-Owner only; escalate staff issues to them.',
        ],
    },

    coowner: {
        label: 'Co-Owner',
        emoji: '💎',
        color: 0xF1C40F,
        weekly: { min: 0, promo: null },
        summary: 'You have full access to every staff command, plus staff discipline and training.',
        inherits: 'Every rank below you',
        sections: [
            {
                name: '⚡ Staff Discipline',
                value:
                    '`/strike add target reason` — give a staff member a strike (**3 strikes** is the serious threshold).\n' +
                    '`/strike remove target reason` — remove a strike.\n' +
                    '`/strikes target` — check a count. Strikes DM the staff member and post to the private staff log.',
            },
            {
                name: '🎓 Training',
                value:
                    '`/mod train rank user` — DM a rank training course to someone (Owner/Co-Owner only).',
            },
            {
                name: '🧰 Everything Else',
                value:
                    'All Head Administrator, Administrator, Moderator and Trial commands, including `/restart` and `/mod ban`.',
            },
        ],
        tips: [
            'Always give a clear reason on strikes — the staff member receives it by DM.',
        ],
    },
};

const RANK_CHOICES = Object.entries(RANKS).map(([value, r]) => ({ name: r.label, value }));

function weeklyLine(w) {
    if (!w.min && !w.promo) return 'No weekly message requirement.';
    return `Weekly minimum: **${w.min}** messages` + (w.promo ? ` • Promotion goal: **${w.promo}**` : ' • No promotion tier above this rank');
}

// Builds the list of embeds that make up one training course.
function buildTrainingEmbeds(rankKey, { createEmbed, guildName, trainerTag }) {
    const r = RANKS[rankKey];
    const embeds = [];

    // 1) Welcome / overview
    embeds.push(createEmbed({
        title: `${r.emoji} ${r.label} Training`,
        description:
            `Welcome to **${guildName}** staff training.\n${r.summary}\n\n` +
            `📈 ${weeklyLine(r.weekly)}\n` +
            (r.inherits ? `🔁 **Also includes:** ${r.inherits}` : '🔁 This is the entry rank — nothing is inherited.'),
        color: r.color,
        footer: `Training sent by ${trainerTag}`,
    }));

    // 2) Command sections (split across embeds if they would exceed Discord's 6000-char embed limit)
    let current = createEmbed({ title: `📘 Your Commands — ${r.label}`, color: r.color, timestamp: false });
    let size = current.data.title.length;
    for (const s of r.sections) {
        const len = s.name.length + s.value.length;
        if (size + len > 5500) {
            embeds.push(current);
            current = createEmbed({ title: `📘 Your Commands (cont.) — ${r.label}`, color: r.color, timestamp: false });
            size = current.data.title.length;
        }
        current.addFields({ name: s.name, value: s.value.slice(0, 1024) });
        size += len;
    }
    embeds.push(current);

    // 3) Tips
    embeds.push(createEmbed({
        title: '✅ Rules of Thumb',
        description: r.tips.map((t) => `• ${t}`).join('\n') + '\n\nIf you have questions, ask in the staff channels. Good luck!',
        color: r.color,
        footer: "OsQarek's Universe",
        timestamp: false,
    }));

    return embeds;
}

async function handleTrain({ interaction, options, guild, user, isOwner, createEmbed, logAction }) {
    if (!isOwner) {
        return interaction.editReply('❌ Only **Owner / Co-Owner** can use `/mod train`.');
    }

    const rankKey = options.getString('rank');
    const target = options.getUser('user');

    if (!RANKS[rankKey]) return interaction.editReply('❌ Unknown rank.');
    if (!target) return interaction.editReply('❌ You need to pick a user to train.');
    if (target.bot) return interaction.editReply('❌ You cannot send training to a bot.');

    const embeds = buildTrainingEmbeds(rankKey, {
        createEmbed,
        guildName: guild.name,
        trainerTag: user.tag,
    });

    try {
        for (const embed of embeds) {
            await target.send({ embeds: [embed] });
        }
    } catch (err) {
        return interaction.editReply(`❌ Could not DM **${target.tag}** (their DMs are closed or they blocked the bot).`);
    }

    if (logAction) {
        logAction(guild, '🎓 Staff Training Sent', `**Rank:** ${RANKS[rankKey].label}\n**Recipient:** ${target.tag}\n**Sent by:** ${user.tag}`, 0x2ECC71);
    }

    return interaction.editReply(`✅ Sent the **${RANKS[rankKey].label}** training to **${target.tag}** in their DMs.`);
}

module.exports = { RANKS, RANK_CHOICES, buildTrainingEmbeds, handleTrain };
