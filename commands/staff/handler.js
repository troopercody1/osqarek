const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    MessageFlags,
} = require('discord.js');

const BRAND_COLOR = '#5500FF';

async function pingAllStaff({ interaction, getCachedMembers }) {
    const reason = interaction.options.getString('reason');
    const staffRoleId = '1266661585380708473';

    if (interaction.isChatInputCommand()) {
        // Only defer if we haven't replied or deferred yet
        if (!interaction.deferred && !interaction.replied) {
            try {
                await interaction.deferReply({ ephemeral: false });
            } catch (err) {
                console.error("Failed to defer interaction:", err);
            }
        }
    }

    const members = await getCachedMembers(interaction.guild, { ttl: 300000 });
    const staffMembers = members.filter(m => m.roles.cache.has(staffRoleId) && !m.user.bot);

    if (staffMembers.size === 0) {
        return interaction.editReply("No staff members found with that role.");
    }

    let dmCount = 0;

    const dmPromises = staffMembers.map(async (member) => {
        try {
            const embed = new EmbedBuilder()
                .setTitle('🚨 **URGENT STAFF ALERT:**')
                .setDescription(`You have been pinged by **${interaction.user.tag}** in **${interaction.guild.name}**.`)
                // FIX 2: Wrap fields in an array [ ] to fix the Sapphire/Shapeshift validator error
                .addFields([
                    { name: 'Reason', value: reason }
                ])
                .setColor(0xFF0000)
                .setTimestamp();

            await member.send({ embeds: [embed] });
            dmCount++;
        } catch (err) {
            console.log(`Could not DM ${member.user.tag}.`);
        }
    });

    await Promise.all(dmPromises);

    const pingList = staffMembers.map(m => `<@${m.id}>`).join(' ');

    const publicEmbed = new EmbedBuilder()
        .setTitle('Staff Notified')
        .setDescription(`**Reason:** ${reason}\n\n**Notified:** ${dmCount} staff members via DM.`)
        .setColor(0x5865F2)
        .setFooter({ text: `Requested by ${interaction.user.username}` });

    await interaction.editReply({
        content: `⚠️ **Attention Staff:** ${pingList}`,
        embeds: [publicEmbed]
    });
}

async function staffdm({ interaction, options, guild, member, createEmbed, getCachedMembers }) {
    const staffRoles = [
        '826829037136510986', // Trial Mod
        '772558550555295794', // Mod
        '801828933800296478', // Head Mod
        '850513087399329823', // Admin
        '850513944329191445', // Head Admin
        '771423764511981599', // Owner
        '1511810524818440243'  // Co-Owner
    ];

    // Permission check: Admin+ only
    if (
        !member.roles.cache.some(r => staffRoles.includes(r.id)) &&
        !member.permissions.has(PermissionFlagsBits.Administrator)
    ) {
        return interaction.editReply("❌ You do not have permission to use this command.");
    }

    const msg = options.getString('message');
    const guildMembers = await getCachedMembers(guild, { ttl: 300000 });

    // Filter all members with ANY staff role
    const staffMembers = guildMembers.filter(m =>
        m.roles.cache.some(r => staffRoles.includes(r.id))
    );

    let sent = 0;
    let failed = 0;

    // Build the embed once (reused for all DMs)
    const embed = createEmbed({
        title: "📢 Staff Announcement",
        description: msg,
        footer: `Sent by ${interaction.user.tag}`,
    });

    for (const [, staff] of staffMembers) {
        try {
            await staff.send({ embeds: [embed] });
            sent++;
        } catch {
            failed++;
        }
    }

    return interaction.editReply(
        `📨 Staff DM sent.\n\n` +
        `👥 Total staff: **${staffMembers.size}**\n` +
        `✅ Delivered: **${sent}**\n` +
        `⚠️ Failed (DMs closed): **${failed}**`
    );
}

async function strike({ interaction, guild, createEmbed, db }) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getMember('target');
    const reason = interaction.options.getString('reason');
    const moderator = interaction.member;

    // IDs
    const OWNER_ROLE_ID = '771423764511981599';
    const CO_OWNER_ROLE_ID = '1511810524818440243';
    const STAFF_ONLY_LOG = '1478171273422045277';

    if (!moderator.roles.cache.has(OWNER_ROLE_ID) && !moderator.roles.cache.has(CO_OWNER_ROLE_ID)) {
        return interaction.editReply("❌ Only Owner/Co-Owner can manage strikes.");
    }

    // Switched from db.offences to db.staffStrikes
    if (!db.staffStrikes[target.id]) db.staffStrikes[target.id] = 0;

    let embed = createEmbed();

    if (sub === 'add') {
        db.staffStrikes[target.id] += 1;
        const count = db.staffStrikes[target.id];

        embed.setTitle('⚠️ Staff Strike Added')
            .setColor(count >= 3 ? '#FF0055' : BRAND_COLOR)
            .setDescription(`**${target.user.tag}** now has **${count}/3** strikes.\n**Reason:** ${reason}`);

        db.cases.push({ id: db.cases.length + 1, user: target.id, type: 'Staff Strike', reason, moderator: moderator.user.tag });
    } else {
        if (db.staffStrikes[target.id] <= 0) return interaction.editReply("Target has no strikes.");

        db.staffStrikes[target.id] -= 1;
        const count = db.staffStrikes[target.id];

        embed.setTitle('✅ Staff Strike Removed')
            .setColor('#00FF99')
            .setDescription(`Removed 1 strike from **${target.user.tag}**.\n**Remaining:** ${count}\n**Reason:** ${reason}`);

        db.cases.push({ id: db.cases.length + 1, user: target.id, type: 'Strike Removal', reason, moderator: moderator.user.tag });
    }

    await db.save();

    // 1. DM the Staff Member
    try { await target.send({ embeds: [embed] }); } catch (e) { }

    // 2. Private Staff Log
    const staffLog = interaction.guild.channels.cache.get(STAFF_ONLY_LOG);
    if (staffLog) {
        await staffLog.send({ embeds: [embed] });
    }

    // 3. Interaction Reply
    await interaction.editReply({ embeds: [embed] });
}

async function strikes({ interaction, db, createEmbed }) {
    const target = interaction.options.getUser('target');
    const strikeCount = db.staffStrikes[target.id] || 0;

    const embed = createEmbed({
        title: '📋 Staff Strike Record',
        description: `**${target.tag}** currently has **${strikeCount}** strike(s).`,
        color: strikeCount >= 3 ? '#FF0055' : BRAND_COLOR,
    });

    return interaction.editReply({ embeds: [embed] });
}

async function apply({ interaction, db }) {
    // --- TOGGLE CHECK ---
    if (db.disabledCommands && db.disabledCommands.includes('apply')) {
        return interaction.editReply("❌ **Applications are currently closed.** Please check back later!");
    }

    const applyEmbed = new EmbedBuilder()
        .setTitle('📝 Staff Application')
        .setDescription(
            "We are always looking for dedicated members to join the **OsQarek's Universe** team!\n\n" +
            "**Requirements:**\n" +
            "• Must be 13+ years old.\n" +
            "• Must be active in the community.\n" +
            "• Must have a positive attitude and willingness to help others.\n" +
            "• Must be at least level 10\n" +
            "• Must have at least 1000 messages (do *g.m* to check).\n" +
            "• Must be in the server for at least 2 weeks.\n" +
            "• Must have under 3 warnings (Ping <@933260214097035276> or <@778819029041152010> to check.)\n"
        )
        .addFields({
            name: '🔗 How to Apply',
            value: '[Click here to open the Google Form](https://forms.gle/9M2CBRCdCsJZ6ytV8)'
        })
        .setColor(0x3498DB)
        .setFooter({ text: 'Good luck with your application!' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Open Application')
            .setURL('https://forms.gle/9M2CBRCdCsJZ6ytV8')
            .setStyle(ButtonStyle.Link)
    );

    return interaction.editReply({ embeds: [applyEmbed], components: [row] });

}

async function notesAdd({ interaction, options, user, isTrial, db }) {
    if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    const target = options.getUser('target'); if (!db.notes[target.id]) db.notes[target.id] = [];
    db.notes[target.id].push({ text: options.getString('note'), mod: user.tag });
    await db.save(); return interaction.editReply("✅ Note added.");
}

async function notesView({ interaction, options, isTrial, db }) {
    if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    const target = options.getUser('target');
    const list = (db.notes[target.id] || []).map((n, i) => `**#${i + 1}** ${n.text} (${n.mod})`).join('\n') || "None";
    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`Notes: ${target.tag}`).setDescription(list)] });
}

async function notesDelete({ interaction, options, isTrial, db }) {
    if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
    const target = options.getUser('target'); const idx = options.getInteger('index') - 1;
    if (db.notes[target.id]?.[idx]) { db.notes[target.id].splice(idx, 1); await db.save(); return interaction.editReply("✅ Deleted."); }
    return interaction.editReply("❌ Not found.");
}

async function notes(ctx) {
    const subcommand = ctx.options.getSubcommand();
    if (subcommand === 'add') return notesAdd(ctx);
    if (subcommand === 'view') return notesView(ctx);
    if (subcommand === 'delete') return notesDelete(ctx);
    return ctx.interaction.editReply('❌ Unknown notes subcommand.');
}

async function syncstats({ interaction, isAtLeastAdmin, db }) {
    if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Administrator+** to use this.');
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
    }

    try {
        const syncStartedAt = Date.now();
        const runAudit = interaction.options.getBoolean('audit') || false;
        const isDryRun = interaction.options.getBoolean('dryrun') || false;
        const isDebug = interaction.options.getBoolean('debug') || false;

        // 1. Calculate Start Timestamp (Last Monday)
        const lastMonday = new Date();
        lastMonday.setHours(0, 0, 0, 0);
        const day = lastMonday.getDay();
        const diff = (day === 0 ? 6 : day - 1);
        lastMonday.setDate(lastMonday.getDate() - diff);
        const startTimestamp = lastMonday.getTime();

        const guild = interaction.guild;
        const allMembers = await guild.members.fetch();
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

        let auditLog = { kicked: 0, flagged: [], failed: 0, debugAges: [] };
        let modeText = isDryRun ? '🧪 (Mode: Dry Run)' : (runAudit ? '🛡️ (Mode: Active Audit)' : '📊 (Mode: Stats Only)');

        // Exclude the bot's own automated log channels from the scan — they're filled
        // with bot-generated action-log embeds (not staff conversation), and on servers
        // that have been running a while they can balloon into hundreds of thousands of
        // messages, dwarfing every real channel and wrecking the ETA/scan time for zero
        // useful signal (log entries are authored by the bot, not by staff members).
        const excludedLogChannelIds = new Set([db.modLogChannel, db.chatLogChannel].filter(Boolean));

        const channelsToScan = guild.channels.cache.filter(c =>
            c.isTextBased() &&
            c.permissionsFor(guild.members.me).has(['ViewChannel', 'ReadMessageHistory']) &&
            !excludedLogChannelIds.has(c.id)
        );
        const totalChannelsToScan = channelsToScan.size;

        // Small helper to render a millisecond duration as "Xm Ys" or "X.Ys"
        const formatDuration = (ms) => {
            const totalSeconds = Math.max(0, Math.floor(ms / 1000));
            const minutes = Math.floor(totalSeconds / 60);
            const remSeconds = totalSeconds % 60;
            const tenths = Math.floor((ms % 1000) / 100);
            return minutes > 0 ? `${minutes}m ${remSeconds}s` : `${remSeconds}.${tenths}s`;
        };

        // This now walks each channel's FULL history (to rebuild all-time stats), which
        // takes much longer than a single Monday-to-now pass, so the old per-channel
        // estimate is no longer accurate — this is a rough floor, not a real ETA. It gets
        // replaced with a live, measured ETA once scanning actually starts (see below).
        const estSeconds = Math.ceil(channelsToScan.size * 1.5);
        const timeString = estSeconds < 60 ? `${estSeconds}s` : `${Math.floor(estSeconds / 60)}m ${estSeconds % 60}s`;

        const skippedLogNote = excludedLogChannelIds.size > 0
            ? ` (skipping ${excludedLogChannelIds.size} bot log channel${excludedLogChannelIds.size > 1 ? 's' : ''})`
            : '';
        await interaction.editReply(`🔍 **Syncing Universe System...** ${modeText}\nScanning **${channelsToScan.size}** channels${skippedLogNote} (full history). **ETA: at least ~${timeString}, likely longer.**`);

        // 2. Security Audit Logic
        for (const [id, member] of allMembers) {
            if (member.user.bot || member.id === guild.ownerId) continue;
            const accountAge = Date.now() - member.user.createdTimestamp;
            const ageInDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));

            if (isDebug && auditLog.debugAges.length < 10) {
                auditLog.debugAges.push(`${member.user.username}: ${ageInDays}d`);
            }

            if (accountAge < ONE_WEEK_MS) {
                if (isDryRun) {
                    auditLog.flagged.push(`${member.user.tag} (${ageInDays}d)`);
                } else if (runAudit) {
                    try {
                        await member.send(`🛡️ **OsQarek's Universe: Security Audit**\nYour account is only ${ageInDays} days old. We require 7 days.`).catch(() => { });
                        await member.kick(`Retroactive Audit: Account age (${ageInDays}d) < 7d`);
                        auditLog.kicked++;
                    } catch (err) {
                        auditLog.failed++;
                    }
                }
            }
        }

        // 3. Staff Message Sync (Updated to use lastMonday)
        const staffIds = allMembers.filter(m =>
            m.roles.cache.has('826829037136510986') ||
            m.roles.cache.has('772558550555295794') ||
            m.roles.cache.has('850513087399329823') ||
            m.roles.cache.has('1511810524818440243') ||
            m.roles.cache.has('771423764511981599')
        ).map(m => m.id);

        if (!db.stats) db.stats = {};
        staffIds.forEach(id => {
            if (!db.stats[id]) db.stats[id] = { count: 0, allTime: 0 };
            db.stats[id].count = 0;
            db.stats[id].allTime = 0;
        });

        // Scan the FULL history of every channel (not just back to last Monday)
        // so we can rebuild both the weekly count and a true all-time count in one pass.
        let scannedCount = 0;
        let allTimeScannedCount = 0;
        let channelsDone = 0;
        let pagesFetched = 0; // one "page" = one 100-message fetch call, our real progress unit
        let lastProgressEditAt = Date.now();
        let skippedChannels = [];

        // Discord.js has no built-in timeout on message fetches. On hosts with flaky
        // egress to Discord, a single fetch can stall forever with no error and no
        // resolution — the await just hangs, which freezes the whole sync (this is
        // exactly what "stuck at page X for 30 minutes with no movement" looks like).
        // Race every fetch against a hard timeout so a stalled request can't block us.
        const FETCH_TIMEOUT_MS = 20000;
        const MAX_RETRIES_PER_PAGE = 3;

        // Persist progress every CLUSTER_SIZE channels instead of a single db.save()
        // at the very end. A full-history scan over many channels can run for minutes;
        // saving only once at the end means a crash/restart mid-scan (host flakiness,
        // Discord API hiccups, etc.) loses everything accumulated so far. Saving in
        // clusters bounds how much work can be lost to at most one cluster's worth.
        const CLUSTER_SIZE = 5;
        let lastSaveError = null;
        // Generic guard against calls that neither resolve nor reject — just hang.
        // .catch() alone does NOT protect against this (it only handles rejections),
        // which is exactly how this command has kept freezing partway through: any
        // Discord/DB call that stalls silently blocks the `await` forever with no
        // error to catch. Race everything network-facing against a hard timeout.
        const withTimeout = (promise, ms, label) => {
            // Swallow a late rejection from the real call after we've already timed
            // out and moved on, so it doesn't surface as an unhandled rejection later.
            promise.catch(() => { });
            let timer;
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            });
            return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
        };
        const DB_SAVE_TIMEOUT_MS = 15000;
        const EDIT_TIMEOUT_MS = 10000;

        // cache: false is critical for large scans. Discord.js caches every fetched
        // message in channel.messages.cache by default and never evicts it during
        // this loop. Across ~900K messages that cache grows unbounded until GC
        // thrashes (looks exactly like a freeze) or the process OOMs outright — we
        // only need each page's data long enough to tally it, not to keep it around.
        const fetchPageWithTimeout = (channel, before) =>
            withTimeout(channel.messages.fetch({ limit: 100, before, cache: false }), FETCH_TIMEOUT_MS, `Fetch in #${channel.name}`);

        // Posts a throttled progress + ETA update. Uses pagesFetched (not just completed
        // channels) as the unit of progress, so a single channel with a huge history still
        // produces visible movement instead of the message sitting still until it's done.
        const postProgress = async ({ currentChannelName, force = false } = {}) => {
            const now = Date.now();
            if (!force && now - lastProgressEditAt < 5000) return;
            lastProgressEditAt = now;

            const elapsedSoFar = now - syncStartedAt;
            const avgPerChannel = channelsDone > 0 ? elapsedSoFar / channelsDone : null;
            const channelsRemaining = totalChannelsToScan - channelsDone;
            const percent = Math.floor((channelsDone / totalChannelsToScan) * 100);

            // Until we've finished at least one full channel we don't have a reliable
            // per-channel average yet, so show "Calculating..." instead of a guess.
            const etaLine = avgPerChannel === null
                ? `**ETA remaining: Calculating...**`
                : `**ETA remaining: ~${formatDuration(avgPerChannel * channelsRemaining)}**`;

            const scanningLine = currentChannelName
                ? `Currently scanning: **#${currentChannelName}** (page ${pagesFetched})\n`
                : '';

            try {
                await withTimeout(
                    interaction.editReply(
                        `🔍 **Syncing Universe System...** ${modeText}\n` +
                        `Scanned **${channelsDone}/${totalChannelsToScan}** channels (${percent}%) — full history.\n` +
                        scanningLine +
                        `${etaLine}\n` +
                        `💬 Staff messages found so far: **${allTimeScannedCount}** all-time / **${scannedCount}** this week.`
                    ),
                    EDIT_TIMEOUT_MS,
                    'Progress editReply'
                );
            } catch (editErr) {
                // A stalled/failed progress update should never block the scan itself —
                // log it and keep going; the next tick will just catch us up.
                console.error(`⚠️ syncstats: progress editReply failed/stalled: ${editErr.message}`);
            }
        };

        // --- CHECKPOINT / RESUME ---
        // Every MESSAGE_CHECKPOINT messages scanned (across the whole sync, all
        // authors — not just staff hits), pause and post a "Continue" button rather
        // than blasting through a potentially huge full-history scan in one go. This
        // gives staff a natural point to bail out or step away without losing work,
        // and keeps a single sync from monopolizing the interaction/rate limits for
        // an unbounded stretch. Progress is saved to the DB before pausing.
        const MESSAGE_CHECKPOINT = 10000;
        let totalMessagesProcessed = 0;
        let nextCheckpoint = MESSAGE_CHECKPOINT;

        const pauseForContinue = async () => {
            try {
                await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() at checkpoint');
            } catch (saveErr) {
                console.error("❌ syncstats: checkpoint save failed/stalled:", saveErr.message);
            }

            const continueId = `syncstats_continue_${interaction.id}_${nextCheckpoint}`;
            const continueRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(continueId)
                    .setLabel('▶️ Continue Scan')
                    .setStyle(ButtonStyle.Primary)
            );

            let checkpointMsg;
            try {
                checkpointMsg = await withTimeout(
                    interaction.followUp({
                        content:
                            `⏸️ **Checkpoint reached — ${totalMessagesProcessed.toLocaleString()} messages scanned so far.**\n` +
                            `Progress has been saved (**${allTimeScannedCount}** staff messages all-time / **${scannedCount}** this week found so far).\n` +
                            `Click below to continue scanning.`,
                        components: [continueRow]
                    }),
                    EDIT_TIMEOUT_MS,
                    'Checkpoint followUp'
                );
            } catch (followUpErr) {
                // Couldn't post the checkpoint message at all — don't hang the whole
                // scan waiting on a button nobody can see. Log it and keep scanning;
                // progress up to this point is already saved above.
                console.error(`⚠️ syncstats: checkpoint followUp failed/stalled, skipping this pause: ${followUpErr.message}`);
                return;
            }

            try {
                const clickInteraction = await checkpointMsg.awaitMessageComponent({
                    filter: (btn) => btn.user.id === interaction.user.id && btn.customId === continueId,
                    time: 24 * 60 * 60 * 1000 // 24h — give staff plenty of time to come back and click
                });
                await clickInteraction.update({
                    content: `▶️ **Resuming scan...** (${totalMessagesProcessed.toLocaleString()} messages scanned so far)`,
                    components: []
                });
            } catch (err) {
                // No click received in time — stop the scan cleanly instead of hanging forever.
                await checkpointMsg.edit({
                    content:
                        `⏹️ **Scan paused and abandoned** — no continue click received in time.\n` +
                        `Progress up to **${totalMessagesProcessed.toLocaleString()}** messages was saved; re-run \`/syncstats\` to continue rebuilding stats.`,
                    components: []
                }).catch(() => { });
                const abandonError = new Error('Sync paused and abandoned (no continue click received).');
                abandonError.syncPausedAbandoned = true;
                throw abandonError;
            }
        };

        for (const [id, channel] of channelsToScan) {
            let lastId = null;
            let fetching = true;
            let retriesLeft = MAX_RETRIES_PER_PAGE;
            while (fetching) {
                try {
                    const messages = await fetchPageWithTimeout(channel, lastId);
                    retriesLeft = MAX_RETRIES_PER_PAGE; // reset once a page actually succeeds
                    pagesFetched++;
                    if (messages.size === 0) break;
                    for (const msg of messages.values()) {
                        totalMessagesProcessed++;
                        if (staffIds.includes(msg.author.id)) {
                            db.stats[msg.author.id].allTime++;
                            allTimeScannedCount++;
                            if (msg.createdTimestamp >= startTimestamp) {
                                db.stats[msg.author.id].count++;
                                scannedCount++;
                            }
                        }
                    }
                    lastId = messages.last()?.id;
                    if (messages.size < 100) fetching = false;
                } catch (err) {
                    if (retriesLeft > 0) {
                        retriesLeft--;
                        console.error(`⚠️ syncstats: fetch failed in #${channel.name} (${retriesLeft} retries left): ${err.message}`);
                        continue; // retry the same page
                    }
                    console.error(`❌ syncstats: giving up on #${channel.name} after repeated failures/timeouts: ${err.message}`);
                    skippedChannels.push(channel.name);
                    fetching = false;
                }

                // Progress ticks here too (throttled inside postProgress), so a single
                // channel with thousands of pages still visibly updates while it works.
                await postProgress({ currentChannelName: channel.name });

                // Checkpoint: pause every MESSAGE_CHECKPOINT messages and wait for a
                // continue click. A single page (100 messages) can never cross more
                // than one checkpoint boundary, but loop just in case a checkpoint
                // straddles a retry/skip.
                while (totalMessagesProcessed >= nextCheckpoint) {
                    await pauseForContinue();
                    nextCheckpoint += MESSAGE_CHECKPOINT;
                }
            }

            channelsDone++;

            // Belt-and-suspenders: even with cache:false on the fetch itself, messages
            // can still land in the cache via live gateway events firing in this
            // channel while we're scanning it. Clear it once we're done with the
            // channel so nothing lingers for the rest of the (possibly hours-long) scan.
            channel.messages.cache.clear();

            // Cluster save: persist whatever we've accumulated so far every
            // CLUSTER_SIZE channels, rather than waiting for the entire scan to
            // finish. Failures here are logged but don't abort the scan — we'll
            // just retry on the next cluster boundary (or the final save below).
            if (channelsDone % CLUSTER_SIZE === 0 || channelsDone === totalChannelsToScan) {
                try {
                    await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() cluster save');
                    lastSaveError = null;
                    console.log(`💾 syncstats: persisted progress after ${channelsDone}/${totalChannelsToScan} channels (${allTimeScannedCount} all-time messages so far).`);
                } catch (saveErr) {
                    lastSaveError = saveErr;
                    console.error(`❌ syncstats: cluster save failed/stalled at ${channelsDone}/${totalChannelsToScan} channels:`, saveErr.message);
                }
            }
        }

        await postProgress({ force: true });

        // Final safety-net save in case the last cluster boundary didn't line up
        // exactly with totalChannelsToScan, or the last cluster save failed.
        try {
            await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() final save');
            lastSaveError = null;
        } catch (saveErr) {
            lastSaveError = saveErr;
            console.error("❌ syncstats: final save failed/stalled:", saveErr.message);
        }

        // 4. Final Output Construction
        // Updated text to reflect Monday
        const elapsedMs = Date.now() - syncStartedAt;
        const elapsedString = formatDuration(elapsedMs);

        let finalReport = `✅ **Sync Complete!** (took **${elapsedString}**)\nFound **${scannedCount}** staff messages since **Monday, ${lastMonday.toDateString()}**.\n📚 Found **${allTimeScannedCount}** staff messages **all-time** (full channel history).\n🔎 Scanned **${totalMessagesProcessed.toLocaleString()}** messages total (all authors).\n👑 **Current Owner ID:** \`${guild.ownerId}\``;

        if (skippedChannels.length > 0) {
            finalReport += `\n⚠️ **Skipped ${skippedChannels.length} channel(s)** after repeated fetch timeouts (their all-time counts may be incomplete): \`${skippedChannels.join(', ')}\``;
        }

        if (lastSaveError) {
            finalReport += `\n⚠️ **Warning:** the final database save failed (\`${lastSaveError.message}\`). Stats were persisted through the last successful cluster save, but the very latest counts may not be saved — consider re-running.`;
        }

        if (isDebug) {
            finalReport += `\n⚙️ **Debug (Sample Ages):** \`${auditLog.debugAges.join(', ')}\``;
        }

        if (isDryRun) {
            const list = auditLog.flagged.length > 0 ?
                `\n🧪 **Dry Run:** Found **${auditLog.flagged.length}** accounts under 7 days: \`${auditLog.flagged.slice(0, 10).join(', ')}\`` :
                "\n🧪 **Dry Run:** No underage accounts found.";
            finalReport += list;
        } else if (runAudit) {
            finalReport += `\n🛡️ **Audit:** Kicked **${auditLog.kicked}** accounts. (Failed: ${auditLog.failed})`;
        }

        return await interaction.editReply(finalReport);

    } catch (error) {
        if (error.syncPausedAbandoned) {
            // Already reported to the user via the checkpoint message edit — no need
            // to also overwrite the deferred reply with a scary "Sync Failed" message.
            return;
        }
        console.error("SyncStats Error:", error);
        return await interaction.editReply(`❌ **Sync Failed:** ${error.message}`);
    }
}

async function staffstatsAll({ interaction, db }) {
    if (db.staffToolsEnabled === false) return interaction.editReply('🚫 The Staff Tools module is currently disabled.');
    // 1. Permission Check
    const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
    // Use interaction.member to ensure it's defined
    const hasPerms = interaction.member.roles.cache.some(r => adminRoles.includes(r.id)) ||
        interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasPerms) {
        return interaction.editReply("❌ You do not have permission to view global staff stats.");
    }

    const requirements = [
        { roleId: '771423764511981599', name: 'Owner', min: 0, promo: 100 },
        { roleId: '1511810524818440243', name: 'Co-Owner', min: 0, promo: 100 },
        { roleId: '850513944329191445', name: 'Head Administrator', min: 750, promo: 99999 },
        { roleId: '850513087399329823', name: 'Administrator', min: 500, promo: 1250 },
        { roleId: '801828933800296478', name: 'Head Moderator', min: 300, promo: 750 },
        { roleId: '772558550555295794', name: 'Moderator', min: 175, promo: 500 },
        { roleId: '826829037136510986', name: 'Trial Moderator', min: 100, promo: 400 }
    ];

    const statsEmbed = new EmbedBuilder()
        .setTitle('📊 Global Staff Performance')
        .setDescription('Loading stats...') // Placeholder for empty results
        .setFooter({ text: 'Stats synced weekly starting every Monday' }) // Clarify the start day
        .setColor(0x3498DB)
        .setTimestamp();

    let description = "";
    const allMembers = await interaction.guild.members.fetch();

    // Loop through database stats
    for (const [userId, stats] of Object.entries(db.stats || {})) {
        const staffMember = allMembers.get(userId);
        if (!staffMember) continue;

        // Find highest matching role
        const req = requirements.find(r => staffMember.roles.cache.has(r.roleId));
        if (!req) continue;

        const msgCount = stats.count || 0;
        const allTimeCount = stats.allTime || 0;

        // Progress Calculations
        const minPercent = req.min === 0 ? 100 : Math.min(Math.round((msgCount / req.min) * 100), 100);
        const promoPercent = Math.min(Math.round((msgCount / req.promo) * 100), 100);

        // Visual progress indicator (Optional but looks great)
        const progressEmoji = minPercent >= 100 ? '✅' : '⚠️';

        description += `${progressEmoji} **${staffMember.user.username}** (${req.name})\n`;
        description += `💬 \`${msgCount}\` | 📚 All-Time: \`${allTimeCount}\` | 📉 Min: \`${minPercent}%\` | 🚀 Promo: \`${promoPercent}%\` \n\n`;
    }

    statsEmbed.setDescription(description || "No staff activity recorded since last Monday.");

    return interaction.editReply({ embeds: [statsEmbed] });
}

async function staffstatsView({ interaction, options, db }) {
    const staffRoles = [
        '826829037136510986', // Trial
        '772558550555295794', // Mod
        '801828933800296478', // Head Mod
        '850513087399329823', // Admin
        '850513944329191445', // Head Admin
        '1511810524818440243', // Co-Owner
        '771423764511981599'  // Owner
    ];

    const isStaff = interaction.member.roles.cache.some(r => staffRoles.includes(r.id));
    if (!isStaff) return interaction.editReply("❌ This command is for OsQarek's Universe Staff only.");

    try {
        const targetMember = interaction.options.getMember('staff') || interaction.member;

        if (!db.stats) db.stats = {};
        const msgCount = db.stats[targetMember.id]?.count || 0;
        const allTimeCount = db.stats[targetMember.id]?.allTime || 0;

        const requirements = [
            { roleId: '771423764511981599', name: 'Owner', min: 0, promo: 100 },
            { roleId: '1511810524818440243', name: 'Co-Owner', min: 0, promo: 100 },
            { roleId: '850513944329191445', name: 'Head Administrator', min: 750, promo: 99999 },
            { roleId: '850513087399329823', name: 'Administrator', min: 500, promo: 1250 },
            { roleId: '801828933800296478', name: 'Head Moderator', min: 300, promo: 750 },
            { roleId: '772558550555295794', name: 'Moderator', min: 175, promo: 500 },
            { roleId: '826829037136510986', name: 'Trial Moderator', min: 100, promo: 400 }
        ];

        const currentReq = requirements.find(r => targetMember.roles.cache.has(r.roleId)) || { name: 'Staff', min: 1, promo: 1 };

        // Calculation logic
        const minGoal = currentReq.min || 1;
        const promoGoal = currentReq.promo || 1;
        const minProgress = Math.min(((msgCount / minGoal) * 100), 100).toFixed(1);
        const promoProgress = Math.min(((msgCount / promoGoal) * 100), 100).toFixed(1);

        const embed = {
            title: `📊 Weekly Stats: ${targetMember.user.username}`, // Using username for modern Discord compatibility
            description: `Tracking activity for the current cycle.`,
            color: msgCount >= currentReq.min ? 0x2ECC71 : 0xE74C3C,
            fields: [
                { name: '💬 Messages Sent (This Cycle)', value: `**${msgCount}**`, inline: true },
                { name: '📚 All-Time Messages', value: `**${allTimeCount}**`, inline: true },
                {
                    name: '📉 Weekly Minimum',
                    value: `${msgCount >= currentReq.min ? '✅' : '❌'} (${msgCount}/${minGoal}) — **${minProgress}%**`,
                    inline: true
                },
                {
                    name: '📈 Promotion Goal',
                    value: `${msgCount >= currentReq.promo ? '✅' : '❌'} (${msgCount}/${promoGoal}) — **${promoProgress}%**`,
                    inline: true
                }
            ],
            footer: { text: `Rank: ${currentReq.name} | Cycle starts every Monday` },
            timestamp: new Date()
        };

        return interaction.editReply({ embeds: [embed] });

    } catch (err) {
        console.error("❌ StaffStats Error:", err);
        return interaction.editReply(`❌ **Error:** Could not retrieve stats.`);
    }
}

async function staffstatsLeaderboard({ interaction, db }) {
    await interaction.deferReply();

    // 1. Aggregate Staff Actions (Matching your "type" and "moderator" fields)
    const staffActions = {};

    db.cases.forEach(c => {
        const mod = c.moderator; // Your JSON uses "moderator" (name) not "moderatorId"
        if (!mod || mod === "System") return;

        if (!staffActions[mod]) {
            staffActions[mod] = { warns: 0, kicks: 0, bans: 0, total: 0 };
        }

        // Matching your type format: "👢 KICK", "⚠️ WARN", etc.
        const type = c.type.toUpperCase();
        if (type.includes('WARN')) staffActions[mod].warns++;
        if (type.includes('KICK')) staffActions[mod].kicks++;
        if (type.includes('BAN')) staffActions[mod].bans++;

        staffActions[mod].total++;
    });

    // 2. Sort Weekly Messages (Top 5)
    // Note: Since db.stats might use User IDs, keep the <@ID> format
    const topWeekly = Object.entries(db.stats || {})
        .sort(([, a], [, b]) => (b.count || 0) - (a.count || 0))
        .slice(0, 5)
        .map(([id, stats], i) => `**${i + 1}.** <@${id}>: \`${stats.count || 0}\``)
        .join('\n') || '*No message data recorded*';

    // 2b. Sort All-Time Messages (Top 5)
    const topAllTime = Object.entries(db.stats || {})
        .sort(([, a], [, b]) => (b.allTime || 0) - (a.allTime || 0))
        .slice(0, 5)
        .map(([id, stats], i) => `**${i + 1}.** <@${id}>: \`${stats.allTime || 0}\``)
        .join('\n') || '*No message data recorded*';

    // 3. Sort All-Time Actions
    const topMods = Object.entries(staffActions)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, 5)
        .map(([name, stats], i) => {
            // Since "name" is a string like "cydo_15", we display it directly
            return `**${i + 1}.** **${name}**: \`${stats.total}\` (W: ${stats.warns} | K: ${stats.kicks} | B: ${stats.bans})`;
        })
        .join('\n') || '*No moderation cases found*';

    // 4. Warnings (Most "offensive" users)
    const topWarns = Object.entries(db.notes || {})
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([id, count], i) => `**${i + 1}.** <@${id}>: \`${count}\` warnings`)
        .join('\n') || '*Clear record across the board*';

    const embed = new EmbedBuilder()
        .setTitle('📊 OsQarek’s Universe - Staff Leaderboard')
        .setColor(0x2b2d31) // Modern Discord dark theme color
        .addFields(
            { name: '✉️ Top Weekly Activity', value: topWeekly, inline: false },
            { name: '📚 Top All-Time Activity', value: topAllTime, inline: false },
            { name: '🛡️ Top Moderators (Total Actions)', value: topMods, inline: false },
            { name: '⚠️ User Watchlist (Most Warnings)', value: topWarns, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `OsQarek's Universe • ${db.cases.length} Total Cases` });

    await interaction.editReply({ embeds: [embed] });
}

async function staffstats(ctx) {
    const subcommand = ctx.options.getSubcommand();
    if (subcommand === 'all') return staffstatsAll(ctx);
    if (subcommand === 'view') return staffstatsView(ctx);
    if (subcommand === 'leaderboard') return staffstatsLeaderboard(ctx);
    return ctx.interaction.editReply('❌ Unknown staffstats subcommand.');
}

async function messagereset({ interaction, guild, isAtLeastAdmin, logAction, db }) {
    if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Administrator+** to use this.');
    // 1. Reset only the WEEKLY counts; all-time totals are preserved.
    if (!db.stats) db.stats = {};
    for (const id of Object.keys(db.stats)) {
        db.stats[id].count = 0;
    }
    await db.save();

    // 2. Log the action with a timestamp for the audit trail
    // Using user.username for modern Discord compatibility
    logAction(guild, '♻️ Stats Reset', `All weekly message counts have been reset by ${interaction.user.username} (all-time totals untouched)`, 0xFF0000);

    // 3. Inform the admin with a clear confirmation message
    return interaction.editReply("✅ **Weekly message counts have been reset to 0 for all staff.**\n📅 The new tracking cycle has officially started.\n📚 All-time totals were not affected.");
}

async function loaRequest({ interaction, options, guild, user, db }) {
const durationInput = options.getString('duration');
const reason = options.getString('reason') || 'No reason provided';
const dateRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

    if (!dateRegex.test(durationInput)) {
        return interaction.editReply({ content: "❌ **Invalid Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
    }

    const parts = durationInput.split(/[- :]/);
    const dateObj = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);

    if (isNaN(dateObj.getTime()) || dateObj < new Date()) {
        return interaction.editReply({ content: "❌ **Invalid Date!** Must be in the future.", flags: MessageFlags.Ephemeral });
    }

    const startInput = options.getString('start'); // optional — preset a future start
    if (startInput) {
        if (!dateRegex.test(startInput)) {
            return interaction.editReply({ content: "❌ **Invalid Start Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
        }
        const startParts = startInput.split(/[- :]/);
        const startDateObj = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);
        if (isNaN(startDateObj.getTime())) {
            return interaction.editReply({ content: "❌ **Invalid Start Date!**", flags: MessageFlags.Ephemeral });
        }
        if (startDateObj >= dateObj) {
            return interaction.editReply({ content: "❌ **Start date must be before the end date.**", flags: MessageFlags.Ephemeral });
        }
    }

    if (!db.loaChannel) return interaction.editReply("❌ LOA channel is not set up.");
    const loaChan = guild.channels.cache.get(db.loaChannel);

    const loaEmbed = new EmbedBuilder()
        .setTitle('📂 New LOA Request')
        .setColor(0xFFA500)
        .addFields(
            { name: 'Staff Member', value: `<@${user.id}>`, inline: true },
            ...(startInput ? [{ name: 'Start Date/Time', value: `🕓 ${startInput}`, inline: true }] : []),
            { name: 'End Date/Time', value: `📅 ${durationInput}`, inline: true },
            { name: 'Reason', value: reason }
        );

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`loa_approve_${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`loa_deny_${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
    );

    await loaChan.send({ embeds: [loaEmbed], components: [buttons] });
    return interaction.editReply(
        startInput
            ? `✅ Your LOA request has been submitted, preset to start \`${startInput}\`.`
            : `✅ Your LOA request has been submitted.`
    );
}

async function loaList({ interaction, db }) {
    const entries = Object.entries(db.loa || {});
    if (entries.length === 0) return interaction.editReply({ content: "📋 No active staff LOAs." });

    const list = entries.map(([id, data]) => {
        // 🛡️ FALLBACK: If duration or reason is missing, show a clean message
        const duration = data.duration || "Not Recorded";
        const reason = data.reason || "No reason provided";
        const statusLine = data.status === 'Scheduled'
            ? `🕓 **Scheduled** — starts <t:${data.startDate}:f>`
            : `✅ **Active**`;

        return `👤 <@${id}>\n${statusLine}\n⏳ **Ends:** ${duration}\n📄 **Reason:** ${reason}\n──────────────`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('📋 Current Staff LOAs')
        .setDescription(list)
        .setColor(0x3498DB);

    return interaction.editReply({ embeds: [embed] });
}

async function loaEnd({ interaction, options, guild, member, user, logAction, db }) {
    const targetUser = options.getMember('staff') || member;
    const isSelf = targetUser.id === user.id;
    const roles = { admin: '850513087399329823', owner: '771423764511981599', coOwner: '1511810524818440243' };
    const hasManagementPerms = member.roles.cache.has(roles.admin) || member.roles.cache.has(roles.owner) || member.roles.cache.has(roles.coOwner) || member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isSelf && !hasManagementPerms) return interaction.editReply("❌ Permission denied.");
    if (!db.loa[targetUser.id]) return interaction.editReply("❌ No active LOA found.");

    delete db.loa[targetUser.id];
    await db.save();
    if (typeof logAction === 'function') {
        logAction(guild, '📂 LOA Ended', `**Staff:** ${targetUser.user.tag}\n**Ended By:** ${user.tag}`, 0x00FF00);
    }
    return interaction.editReply(`✅ Successfully ended the LOA for **${targetUser.user.tag}**.`);
}

async function loaAdminset({ interaction, options, guild, member, user, logAction, db }) {
    const hasManagementPerms = member.roles.cache.has('850513087399329823') || 
                   member.roles.cache.has('771423764511981599') || 
                   member.roles.cache.has('1511810524818440243') || 
                   member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasManagementPerms) return interaction.editReply({ content: "❌ Permission denied.", flags: MessageFlags.Ephemeral });

    const targetMember = options.getMember('user');
    if (!targetMember) return interaction.editReply({ content: "❌ Could not find that user.", flags: MessageFlags.Ephemeral });

    const durationInput = options.getString('duration');
    const startInput = options.getString('start'); // optional — YYYY-MM-DD HH:mm, preset a future LOA
    const reason = options.getString('reason') || 'No reason provided';
    const dateRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

    if (!dateRegex.test(durationInput)) {
        return interaction.editReply({ content: "❌ **Invalid Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
    }

    const parts = durationInput.split(/[- :]/);
    const dateObj = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);

    if (isNaN(dateObj.getTime()) || dateObj < new Date()) {
        return interaction.editReply({ content: "❌ **Invalid Date!** Must be in the future.", flags: MessageFlags.Ephemeral });
    }

    let startDateObj = new Date(); // defaults to "now" if no start given, same as old behavior
    if (startInput) {
        if (!dateRegex.test(startInput)) {
return interaction.editReply({ content: "❌ **Invalid Start Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
        }
        const startParts = startInput.split(/[- :]/);
        startDateObj = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);

        if (isNaN(startDateObj.getTime())) {
return interaction.editReply({ content: "❌ **Invalid Start Date!**", flags: MessageFlags.Ephemeral });
        }
        if (startDateObj >= dateObj) {
return interaction.editReply({ content: "❌ **Start date must be before the end date.**", flags: MessageFlags.Ephemeral });
        }
    }

    const isScheduled = startDateObj > new Date();

    db.loa[targetMember.id] = {
        status: isScheduled ? 'Scheduled' : 'Approved',
        timestamp: Math.floor(Date.now() / 1000),
        startDate: Math.floor(startDateObj.getTime() / 1000),
        duration: durationInput,
        reason: reason
    };
    await db.save();

    if (typeof logAction === 'function') {
        logAction(
guild,
isScheduled ? '📂 LOA Pre-Scheduled' : '📂 LOA Admin Set',
`**Staff:** ${targetMember.user.tag}\n${isScheduled ? `**Starts:** ${startInput}\n` : ''}**End Date:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`,
0xFFA500
        );
    }

    // Let the staff member know their LOA was set on their behalf, rather than them finding out cold
    try {
        const dmMessage = isScheduled
? `📂 **LOA Scheduled:** An admin has pre-scheduled a Leave of Absence for you in **${guild.name}**.\n**Starts:** ${startInput}\n**Ends:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`
: `📂 **LOA Set:** An admin has placed you on Leave of Absence in **${guild.name}**, effective immediately.\n**Ends:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`;

        await targetMember.send(dmMessage);
    } catch (err) {
        console.log(`Could not DM ${targetMember.user.tag} about their admin-set LOA (DMs likely closed).`);
    }

    return interaction.editReply(
        isScheduled
? `✅ LOA has been **pre-scheduled** for **${targetMember.user.tag}**, starting \`${startInput}\` until \`${durationInput}\`.`
: `✅ LOA has been set for **${targetMember.user.tag}** until \`${durationInput}\`.`
    );
}

async function loa(ctx) {
    const subcommand = ctx.options.getSubcommand();
    if (subcommand === 'request') return loaRequest(ctx);
    if (subcommand === 'list') return loaList(ctx);
    if (subcommand === 'end') return loaEnd(ctx);
    if (subcommand === 'adminset') return loaAdminset(ctx);
    return ctx.interaction.editReply('❌ Unknown loa subcommand.');
}

module.exports = {
    staffdm,
    apply,
    notes,
    loa,
    staffstats,
    'ping-all-staff': pingAllStaff,
    messagereset,
    syncstats,
    strike,
    strikes,
};
