// Raid protection: sliding-window join-burst detection + raid mode.
const { PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, formatDuration, ts, truncate } = require('./util');

const INCIDENT_CAP = 50;
const joins = []; // in-memory sliding window: { id, ts }

function data() {
    const { db } = context.get();
    return store(db, 'raid', { state: { active: false }, incidents: [], nextIncidentId: 1 });
}

function pruneWindow(windowMs, now = Date.now()) {
    while (joins.length && now - joins[0].ts > windowMs) joins.shift();
}

function currentIncident() {
    const d = data();
    return d.incidents.find((i) => i.id === d.state.incidentId) || null;
}

function accountAgeDays(user, now = Date.now()) {
    return (now - user.createdTimestamp) / 86400000;
}

// Decides what to do with one join while raid mode is on.
async function handleRaidJoin(member, cfg, incident) {
    const guild = member.guild;
    if (cfg.action === 'alert') return 'alerted';

    const young = cfg.youngAccountDays <= 0 || accountAgeDays(member.user) < cfg.youngAccountDays;
    if (!young) {
        incident.flaggedOnly = (incident.flaggedOnly || 0) + 1;
        return 'skipped-old';
    }

    const result = await actions.applyAction({
        guild,
        userId: member.id,
        member,
        action: cfg.action,
        timeoutMs: cfg.timeoutMinutes * 60000,
        reason: `Raid protection: joined during raid mode (account ${Math.floor(accountAgeDays(member.user))}d old)`,
        caseType: cfg.action === 'ban' ? '🔨 RAID BAN' : cfg.action === 'kick' ? '👢 RAID KICK' : '🔇 RAID MUTE',
        moderator: 'Raid Protection',
    });
    if (result.ok) {
        incident.actioned = (incident.actioned || 0) + 1;
        return result.outcome;
    }
    if (!result.skipped) {
        incident.failed = (incident.failed || 0) + 1;
        incident.lastError = truncate(result.error, 200);
    }
    return 'failed';
}

async function pauseInvites(guild, d) {
    try {
        if (guild.features?.includes('INVITES_DISABLED')) return false;
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return false;
        await guild.disableInvites(true);
        d.state.invitesPaused = true;
        return true;
    } catch (err) {
        console.error('❌ Raid: could not pause invites:', err.message);
        return false;
    }
}

async function resumeInvites(guild, d) {
    if (!d.state.invitesPaused) return;
    try { await guild.disableInvites(false); } catch (err) { console.error('❌ Raid: could not resume invites:', err.message); }
    d.state.invitesPaused = false;
}

async function startRaidMode(guild, { manual = false, minutes = null, startedBy = null, trigger = [] } = {}) {
    const { db } = context.get();
    const cfg = getConfig(db, 'raid');
    const d = data();
    const now = Date.now();
    const lengthMs = (minutes || cfg.raidModeMinutes) * 60000;

    if (d.state.active) {
        // Already on: just extend.
        d.state.until = Math.max(d.state.until, now + lengthMs);
        return { already: true, state: d.state };
    }

    const incident = {
        id: d.nextIncidentId++,
        startedAt: now,
        endedAt: null,
        trigger: manual ? 'manual' : 'auto',
        startedBy: startedBy || null,
        joinsAtTrigger: trigger.length,
        joins: trigger.length,
        actioned: 0,
        flaggedOnly: 0,
        failed: 0,
        action: cfg.action,
    };
    d.incidents.unshift(incident);
    if (d.incidents.length > INCIDENT_CAP) d.incidents.length = INCIDENT_CAP;

    d.state = { active: true, since: now, until: now + lengthMs, manual, incidentId: incident.id, invitesPaused: false };
    if (cfg.pauseInvites) await pauseInvites(guild, d);

    const sample = trigger.slice(0, 10).map((j) => {
        const u = guild.members.cache.get(j.id)?.user;
        return u ? `• ${u.tag} (${Math.floor(accountAgeDays(u))}d old)` : `• <@${j.id}>`;
    }).join('\n');

    const embed = brandEmbed({
        title: manual ? '🚨 Raid mode enabled (manual)' : '🚨 Raid mode activated',
        color: 0xFF0000,
        description: manual
            ? `Raid mode was switched on by ${startedBy || 'staff'}.`
            : `**${trigger.length}** members joined within **${cfg.windowSeconds}s** (threshold ${cfg.joinThreshold}).`,
        fields: [
            { name: 'Action on new joins', value: cfg.action === 'alert' ? 'Alert only' : `${cfg.action}${cfg.action === 'timeout' ? ` (${cfg.timeoutMinutes}m)` : ''}${cfg.youngAccountDays > 0 ? ` — accounts under ${cfg.youngAccountDays}d` : ''}`, inline: true },
            { name: 'Ends', value: ts(d.state.until), inline: true },
            { name: 'Invites', value: d.state.invitesPaused ? 'Paused' : 'Unchanged', inline: true },
            ...(sample ? [{ name: 'Recent joiners', value: sample }] : []),
        ],
    });
    await actions.notify(guild, cfg.alertChannel, { embed, pingRoleId: cfg.pingRole });
    recordEvent(db, 'raid', manual ? `Raid mode enabled by ${startedBy || 'staff'}` : `Raid mode triggered by ${trigger.length} joins in ${cfg.windowSeconds}s`);
    context.bus.emit('raid:start', incident);

    // Act on the joins that tripped the threshold.
    if (!manual && cfg.actOnTriggerJoins) {
        for (const j of trigger) {
            const m = guild.members.cache.get(j.id) || await guild.members.fetch(j.id).catch(() => null);
            if (m && !m.user.bot) await handleRaidJoin(m, cfg, incident);
        }
    }
    await context.get().safeSave();
    return { already: false, state: d.state, incident };
}

async function endRaidMode(guild, { by = 'timer' } = {}) {
    const { db } = context.get();
    const cfg = getConfig(db, 'raid');
    const d = data();
    if (!d.state.active) return false;
    const incident = currentIncident();
    if (incident) incident.endedAt = Date.now();
    await resumeInvites(guild, d);
    d.state = { active: false };
    joins.length = 0;

    if (incident) {
        const embed = brandEmbed({
            title: '✅ Raid mode ended',
            color: 0x2ECC71,
            description: `Ended (${by}) after ${formatDuration(incident.endedAt - incident.startedAt)}.`,
            fields: [
                { name: 'Joins seen', value: String(incident.joins), inline: true },
                { name: `${cfg.action === 'alert' ? 'Alerted' : 'Actioned'}`, value: String(incident.actioned), inline: true },
                { name: 'Flagged only (old accounts)', value: String(incident.flaggedOnly || 0), inline: true },
                ...(incident.failed ? [{ name: 'Failed', value: `${incident.failed}${incident.lastError ? ` — ${incident.lastError}` : ''}`, inline: true }] : []),
            ],
        });
        await actions.notify(guild, cfg.alertChannel, { embed });
    }
    recordEvent(db, 'raid', `Raid mode ended (${by})`);
    context.bus.emit('raid:end', incident);
    await context.get().safeSave();
    return true;
}

async function onJoin(member) {
    const { db } = context.get();
    const cfg = getConfig(db, 'raid');
    if (!cfg.enabled) return;
    const guild = member.guild;
    if (guild.id !== (actions.getGuild()?.id)) return;
    if (member.user.bot) return;

    const now = Date.now();
    joins.push({ id: member.id, ts: now });
    pruneWindow(cfg.windowSeconds * 1000, now);

    const d = data();
    if (d.state.active) {
        const incident = currentIncident();
        if (incident) {
            incident.joins++;
            if (!d.state.manual) d.state.until = Math.max(d.state.until, now + cfg.raidModeMinutes * 60000);
            await handleRaidJoin(member, cfg, incident);
        }
        return;
    }
    if (joins.length >= cfg.joinThreshold) {
        await startRaidMode(guild, { trigger: joins.slice() });
    }
}

// Called by the scheduler every few seconds.
async function tick() {
    const d = data();
    if (!d.state.active) return;
    if (Date.now() >= d.state.until) {
        const guild = actions.getGuild();
        if (guild) await endRaidMode(guild, { by: 'timer' });
    }
}

function status() {
    const d = data();
    return { state: d.state, incident: currentIncident(), incidents: d.incidents, recentJoins: joins.length };
}

// ---------- slash command ----------
const commands = {
    async raid({ interaction, options, guild, user, isMod, isAtLeastAdmin }) {
        const { db } = context.get();
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        const sub = options.getSubcommand();
        const cfg = getConfig(db, 'raid');

        if (sub === 'status') {
            const s = status();
            const lines = [
                `**Feature:** ${cfg.enabled ? '✅ enabled' : '⛔ disabled'} — trigger: **${cfg.joinThreshold}** joins / **${cfg.windowSeconds}s**, action **${cfg.action}**`,
                `**Raid mode:** ${s.state.active ? `🚨 ACTIVE since ${ts(s.state.since)}, ends ${ts(s.state.until)}${s.state.manual ? ' (manual)' : ''}` : '🟢 off'}`,
                `**Joins in current window:** ${s.recentJoins}`,
            ];
            if (s.incidents.length) {
                lines.push('', '**Recent incidents**');
                for (const i of s.incidents.slice(0, 5)) {
                    lines.push(`#${i.id} ${ts(i.startedAt, 'f')} — ${i.trigger}, ${i.joins} joins, ${i.actioned} actioned${i.endedAt ? `, lasted ${formatDuration(i.endedAt - i.startedAt)}` : ' (ongoing)'}`);
                }
            }
            return interaction.editReply({ embeds: [brandEmbed({ title: '🚨 Raid Protection', description: lines.join('\n') })] });
        }

        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
        if (sub === 'start') {
            const minutes = options.getInteger('minutes');
            const r = await startRaidMode(guild, { manual: true, minutes, startedBy: user.tag });
            return interaction.editReply(r.already ? `⚠️ Raid mode was already on — extended to end ${ts(r.state.until)}.` : `🚨 Raid mode is **on** until ${ts(r.state.until)}. New joins will be handled with: **${cfg.action}**.${cfg.enabled ? '' : '\n⚠️ The Raid Protection feature is disabled in settings, so joins are *not* being actioned until you run `/feature enable raid`.'}`);
        }
        if (sub === 'end') {
            const ended = await endRaidMode(guild, { by: user.tag });
            return interaction.editReply(ended ? '✅ Raid mode ended.' : 'ℹ️ Raid mode is not active.');
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'raid',
        description: 'Raid protection status and manual control',
        options: [
            { name: 'status', description: 'Show raid mode status and recent incidents', type: 1 },
            { name: 'start', description: 'Turn raid mode on manually (Admin+)', type: 1, options: [{ name: 'minutes', description: 'How long to keep it on (default from settings)', type: 4, required: false, min_value: 1, max_value: 1440 }] },
            { name: 'end', description: 'Turn raid mode off (Admin+)', type: 1 },
        ],
    },
];

module.exports = { onJoin, tick, status, startRaidMode, endRaidMode, commands, definitions, _joins: joins };
