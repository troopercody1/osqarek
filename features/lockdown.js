// Drills + lockdowns.
//   /drill raid|lockdown [minutes]  – posts a clearly-labelled DRILL message in the server's channels AND locks the
//                                      server for the drill. When it ends (timer or /drill end) the server is unlocked
//                                      and the drill messages are deleted.
//   /drill end                       – ends a running drill early
//   /mod lockdown scope:Server       – really locks / unlocks every text channel for @everyone (every role's saved perms are restored)
//   /mod lockdown scope:Channel      – really locks / unlocks one channel (the `channel` option, default: the current one)
// Everything is implemented as core functions so the slash commands and the dashboard share the same code.
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { store, brandEmbed, recordEvent, truncate, ts, formatDuration } = require('./util');

const DEFAULT_DRILL_MINUTES = 5;
const MAX_DRILL_MINUTES = 60;
const SEND_DELAY_MS = 400; // gentle pacing so we don't hammer the API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false; // one drill/lockdown operation at a time

// Permissions switched off for @everyone while locked.
const LOCK_PERMS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const LOCKABLE_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

// ---------- drill messages ----------
const DRILLS = {
    raid: {
        label: 'Raid drill',
        color: 0xF1C40F,
        title: '🚨 RAID DRILL — THIS IS ONLY A DRILL',
        intro: [
            '**This is a practice raid drill run by the staff team. There is no real raid.**',
            '',
            'Staff are rehearsing how we lock the server down when a wave of fake accounts joins.',
        ],
        footer: "OsQarek's Universe • Raid drill",
        tips: 'In a *real* raid: don\'t click links or answer DMs from people you don\'t know, and ping a staff member if you see mass spam or lots of new accounts.',
    },
    lockdown: {
        label: 'Server lockdown drill',
        color: 0xE67E22,
        title: '🔒 SERVER LOCKDOWN DRILL — THIS IS ONLY A DRILL',
        intro: [
            '**This is a practice server lockdown drill run by the staff team. There is no real emergency.**',
            '',
            'Staff are rehearsing how we shut the server down quickly when something goes wrong.',
        ],
        footer: "OsQarek's Universe • Lockdown drill",
        tips: 'In a *real* lockdown: stay calm, don\'t DM staff, and wait for an announcement here.',
    },
};

function drillDescription(kind, endsAt) {
    const d = DRILLS[kind];
    return [
        ...d.intro,
        '',
        '**What this means for you:**',
        '• The server is **temporarily locked** (read-only) while the drill runs — that is part of the drill.',
        `• Everything is restored automatically **${ts(endsAt)}** and **this message will be deleted** when the drill ends.`,
        `• ${d.tips}`,
        '',
        '*Drill only — nothing is permanent.*',
    ].join('\n');
}

function drillEmbed(kind, endsAt) {
    const d = DRILLS[kind];
    return brandEmbed({ title: d.title, description: drillDescription(kind, endsAt), color: d.color, footer: d.footer });
}

// Plain-text copy (what gets DMed to whoever ran the drill).
function drillText(kind, endsAt) {
    const d = DRILLS[kind];
    return `**${d.title}**\n\n${drillDescription(kind, endsAt)}\n\n_${d.footer}_`;
}

// ---------- state ----------
function data() {
    const { db } = context.get();
    return store(db, 'lockdown', { server: { active: false }, channels: {}, last: null });
}

function status() {
    const d = data();
    return { server: d.server, channels: d.channels, last: d.last, busy };
}

const mention = (ch) => `<#${ch.id}>`;
const isLockable = (ch) => LOCKABLE_TYPES.has(ch.type);
const byPosition = (a, b) => a.rawPosition - b.rawPosition;

function lockableChannels(guild) {
    return [...guild.channels.cache.filter(isLockable).values()].sort(byPosition);
}

function postableChannels(guild) {
    const me = guild.members.me;
    return lockableChannels(guild).filter((ch) => {
        const p = ch.permissionsFor(me);
        return p?.has(PermissionFlagsBits.ViewChannel) && p.has(PermissionFlagsBits.SendMessages) && p.has(PermissionFlagsBits.EmbedLinks);
    });
}

// ---------- permission helpers ----------
// Full backup of EVERY permission overwrite on a channel — @everyone, every role and any member-specific one —
// with all allow/deny bits. Bitfields are stored as strings (JSON-safe in the db).
//   { v: 3, ows: [{ id, type, allow: '<bits>', deny: '<bits>' }, ...] }   (type: 0 = role, 1 = member)
function snapshotOverwrite(ch) {
    return {
        v: 3,
        ows: [...ch.permissionOverwrites.cache.values()].map((ow) => ({ id: ow.id, type: ow.type, allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() })),
    };
}

// True when @everyone is currently denied Send Messages on the channel (i.e. it looks locked).
function isSendDenied(ch, everyone) {
    const ow = ch.permissionOverwrites.cache.get(everyone.id);
    return !!ow?.deny.has(PermissionFlagsBits.SendMessages);
}

const LOCKED_PATCH = Object.fromEntries(LOCK_PERMS.map((p) => [p, false]));

async function lockOne(ch, everyone, reason) {
    const prev = snapshotOverwrite(ch, everyone);
    await ch.permissionOverwrites.edit(everyone, LOCKED_PATCH, { reason });
    return prev;
}

async function restoreOne(ch, everyone, prev, reason) {
    if (prev && prev.v === 3) {
        // Put the channel's overwrites back exactly as backed up: every role/member overwrite with its allow/deny bits.
        // Overwrites added while locked are removed. Roles/members that no longer exist are skipped (Discord rejects unknown ids).
        const list = [];
        for (const o of prev.ows) {
            const exists = o.type === 0
                ? ch.guild.roles.cache.has(o.id)
                : !!(ch.guild.members.cache.get(o.id) || await ch.guild.members.fetch(o.id).catch(() => null));
            if (exists) list.push({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
        }
        await ch.permissionOverwrites.set(list, reason);
        return;
    }
    const ow0 = ch.permissionOverwrites.cache.get(everyone.id);
    if (prev && prev.v === 2) {
        // Older backup (only @everyone's overwrite) — still restorable.
        if (!prev.had) {
            if (ow0) await ow0.delete(reason);
            return;
        }
        const allow = BigInt(prev.allow);
        const deny = BigInt(prev.deny);
        const patch = {};
        for (const [name, flag] of Object.entries(PermissionFlagsBits)) patch[name] = (allow & flag) ? true : (deny & flag) ? false : null;
        await ch.permissionOverwrites.edit(everyone, patch, { reason });
    } else {
        // Oldest saved state (only the lock permissions, as true/false/null).
        await ch.permissionOverwrites.edit(everyone, prev, { reason });
    }
    // Tidy up: drop the overwrite entirely if it ended up empty.
    const ow = ch.permissionOverwrites.cache.get(everyone.id);
    if (ow && ow.allow.bitfield === 0n && ow.deny.bitfield === 0n) await ow.delete(reason).catch(() => { });
}

// Locks every lockable channel, recording previous perms into `saved` as it goes (so a crash mid-way is recoverable).
async function lockAll(guild, saved, reason) {
    const d = data();
    const everyone = guild.roles.everyone;
    let locked = 0, skipped = 0;
    const failed = [];
    for (const ch of lockableChannels(guild)) {
        if (d.channels[ch.id]) { skipped++; continue; } // individually locked already — leave it (and its saved state) alone
        if (!ch.manageable) { failed.push(`${mention(ch)} (no permission)`); continue; }
        try {
            saved[ch.id] = await lockOne(ch, everyone, reason);
            locked++;
        } catch (err) {
            failed.push(`${mention(ch)} (${truncate(err.message, 50)})`);
        }
    }
    return { locked, skipped, failed };
}

async function unlockAll(guild, saved, reason) {
    const d = data();
    const everyone = guild.roles.everyone;
    let restored = 0;
    const failed = [];
    for (const [id, prev] of Object.entries(saved || {})) {
        if (d.channels[id]) continue; // since individually locked — that's /lockdown channel's job
        const ch = guild.channels.cache.get(id);
        if (!ch) continue; // deleted meanwhile
        try {
            await restoreOne(ch, everyone, prev, reason);
            restored++;
        } catch (err) {
            failed.push(`${mention(ch)} (${truncate(err.message, 50)})`);
        }
    }
    return { restored, failed };
}

function needManageChannels(guild) {
    const me = guild.members.me;
    return !(me?.permissions.has(PermissionFlagsBits.ManageChannels) || me?.permissions.has(PermissionFlagsBits.Administrator));
}

const busyResult = () => ({ ok: false, msg: '⏳ Another drill / lockdown action is still running — try again in a moment.' });

// ---------- drills ----------
async function startDrill({ guild, kind, minutes, actor, dm = null }) {
    const { logAction, db } = context.get();
    if (!DRILLS[kind]) return { ok: false, msg: '❌ Unknown drill.' };
    if (busy) return busyResult();
    if (needManageChannels(guild)) return { ok: false, msg: '❌ I need the **Manage Channels** permission to lock channels for a drill.' };
    const d = data();
    if (d.server.active) {
        return { ok: false, msg: d.server.drill ? `🧪 A ${DRILLS[d.server.drill.kind].label.toLowerCase()} is already running (ends ${ts(d.server.drill.endsAt)}). End it with \`/drill end\`.` : `🔒 The server is already locked down (since ${ts(d.server.since)}). Unlock it first.` };
    }
    const targets = postableChannels(guild);
    if (!targets.length) return { ok: false, msg: '❌ I can\'t post in any channel here (need View Channel, Send Messages and Embed Links).' };

    busy = true;
    try {
        const mins = Math.min(MAX_DRILL_MINUTES, Math.max(1, Math.round(minutes || DEFAULT_DRILL_MINUTES)));
        const endsAt = Date.now() + mins * 60000;
        const embed = drillEmbed(kind, endsAt);
        const label = DRILLS[kind].label;
        const auditReason = truncate(`${label} started by ${actor.tag}`, 400);

        // 1. Post the drill message everywhere (before locking, so the bot can always post).
        const messages = {};
        const postFailed = [];
        for (const ch of targets) {
            try {
                const m = await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
                messages[ch.id] = m.id;
            } catch (err) {
                postFailed.push(`${mention(ch)} (${truncate(err.message, 60)})`);
            }
            await sleep(SEND_DELAY_MS);
        }

        // 2. Lock the server. State is persisted first so a restart mid-drill can still end it.
        d.server = { active: true, since: Date.now(), by: actor.tag, reason: label, saved: {}, drill: { kind, endsAt, minutes: mins, messages } };
        await context.get().safeSave();
        const lock = await lockAll(guild, d.server.saved, auditReason);

        const sent = Object.keys(messages).length;
        d.last = { type: 'drill', kind, label, at: Date.now(), by: actor.tag, endsAt, sent, total: targets.length, locked: lock.locked, failed: [...postFailed, ...lock.failed].slice(0, 20), text: drillText(kind, endsAt), ended: false };
        recordEvent(db, 'drill', `${label} started by ${actor.tag} — posted to ${sent}/${targets.length} channels, locked ${lock.locked}, ends in ${mins}m`);
        logAction(guild, `🧪 ${label} started`, `**Run by:** ${actor.tag}\n**Posted to:** ${sent}/${targets.length} channels\n**Channels locked:** ${lock.locked}\n**Ends:** ${ts(endsAt)} — server unlocks and drill messages are deleted automatically`, DRILLS[kind].color);
        context.bus.emit('drill:start', { kind });
        await context.get().safeSave();

        // 3. Send the person who ran it exactly what it says.
        let dmOk = false;
        if (dm) dmOk = await dm.send({ content: `Here is what the **${label.toLowerCase()}** said in **${guild.name}** (posted to ${sent} channels):\n\n${truncate(d.last.text, 1800)}`, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);

        const lines = [
            `🧪 **${label} running.** Posted to **${sent}/${targets.length}** channels and locked **${lock.locked}** channels.`,
            `⏱️ Ends ${ts(endsAt)} — the server unlocks and the drill messages are deleted automatically (or run \`/drill end\`).`,
            postFailed.length || lock.failed.length ? `⚠️ Problems: ${truncate([...postFailed, ...lock.failed].join(', '), 700)}` : '',
            dm ? (dmOk ? '📬 I also DMed you a copy of the message.' : '⚠️ I couldn\'t DM you a copy (DMs closed).') : '',
        ].filter(Boolean);
        return { ok: true, msg: lines.join('\n'), embed, text: d.last.text, sent, total: targets.length, locked: lock.locked, endsAt };
    } finally {
        busy = false;
    }
}

async function endDrill({ guild, by = 'timer' }) {
    const { logAction, db } = context.get();
    const d = data();
    if (!d.server.active || !d.server.drill) return { ok: false, msg: 'ℹ️ No drill is running.' };
    if (busy) return busyResult();
    busy = true;
    try {
        const { kind, messages } = d.server.drill;
        const label = DRILLS[kind]?.label || 'Drill';
        const auditReason = truncate(`${label} ended (${by})`, 400);

        // 1. Unlock everything.
        const un = await unlockAll(guild, d.server.saved, auditReason);

        // 2. Delete the drill messages.
        let deleted = 0;
        for (const [chId, msgId] of Object.entries(messages || {})) {
            const ch = guild.channels.cache.get(chId);
            if (!ch) continue;
            try { await ch.messages.delete(msgId); deleted++; } catch { /* already deleted / no access */ }
            await sleep(250);
        }

        d.server = { active: false };
        if (d.last && d.last.type === 'drill') { d.last.ended = true; d.last.endedAt = Date.now(); d.last.endedBy = by; d.last.deleted = deleted; }
        recordEvent(db, 'drill', `${label} ended (${by}) — unlocked ${un.restored} channels, deleted ${deleted} messages`);
        logAction(guild, `✅ ${label} ended`, `**Ended by:** ${by}\n**Channels unlocked:** ${un.restored}\n**Drill messages deleted:** ${deleted}`, 0x2ECC71);
        await context.get().safeSave();
        return { ok: true, msg: `✅ **${label} ended.** Unlocked **${un.restored}** channels and deleted **${deleted}** drill messages.${un.failed.length ? `\n⚠️ Couldn't restore: ${truncate(un.failed.join(', '), 700)}` : ''}` };
    } finally {
        busy = false;
    }
}

// Scheduler hook (every 10s): ends a drill whose time is up. Survives restarts because the state lives in the db.
async function tick() {
    const d = data();
    const dr = d.server.active && d.server.drill;
    if (!dr || Date.now() < dr.endsAt) return;
    const guild = actions.getGuild();
    if (guild) await endDrill({ guild, by: 'timer' });
}

// ---------- real server lockdown ----------
async function lockServer({ guild, actor, reason }) {
    const { logAction, db } = context.get();
    if (busy) return busyResult();
    if (needManageChannels(guild)) return { ok: false, msg: '❌ I need the **Manage Channels** permission to lock channels.' };
    const d = data();
    if (d.server.active) {
        return { ok: false, msg: d.server.drill ? `🧪 A ${DRILLS[d.server.drill.kind].label.toLowerCase()} is running (ends ${ts(d.server.drill.endsAt)}). End it with \`/drill end\` first.` : `🔒 The server is already locked down (since ${ts(d.server.since)} by ${d.server.by}). Unlock it to lift it.` };
    }
    busy = true;
    try {
        const auditReason = truncate(`Server lockdown by ${actor}${reason ? `: ${reason}` : ''}`, 400);
        d.server = { active: true, since: Date.now(), by: actor, reason: reason || null, saved: {} };
        await context.get().safeSave();
        const r = await lockAll(guild, d.server.saved, auditReason);
        recordEvent(db, 'lockdown', `Server locked down by ${actor} (${r.locked} channels)${reason ? ` — ${reason}` : ''}`);
        logAction(guild, '🔒 Server Lockdown', `**Moderator:** ${actor}\n**Channels locked:** ${r.locked}${r.skipped ? ` (+${r.skipped} were already locked)` : ''}${reason ? `\n**Reason:** ${reason}` : ''}`, 0xE74C3C);
        context.bus.emit('lockdown:start', { scope: 'server' });
        d.last = { type: 'lockdown', label: 'Server lockdown', at: Date.now(), by: actor, locked: r.locked, failed: r.failed.slice(0, 20), ended: false };
        await context.get().safeSave();
        return { ok: true, msg: [
            `🔒 **Server locked down.** ${r.locked} channel${r.locked === 1 ? '' : 's'} locked for @everyone${r.skipped ? `, ${r.skipped} were already locked` : ''}.`,
            r.failed.length ? `⚠️ Couldn't lock: ${truncate(r.failed.join(', '), 900)}` : '',
            'Roles with their own "Send Messages" allow on a channel can still talk there. Unlock with `/mod lockdown scope:Server status:False`.',
        ].filter(Boolean).join('\n') };
    } finally {
        busy = false;
    }
}

async function unlockServer({ guild, actor }) {
    const { logAction, db } = context.get();
    const d = data();
    if (!d.server.active) return { ok: false, msg: 'ℹ️ The server isn\'t locked down.' };
    if (d.server.drill) return endDrill({ guild, by: actor }); // lifting a drill lock also ends the drill + deletes its messages
    if (busy) return busyResult();
    busy = true;
    try {
        const un = await unlockAll(guild, d.server.saved, truncate(`Server unlocked by ${actor}`, 400));
        d.server = { active: false };
        if (d.last && d.last.type === 'lockdown') { d.last.ended = true; d.last.endedAt = Date.now(); d.last.endedBy = actor; }
        recordEvent(db, 'lockdown', `Server unlocked by ${actor} (${un.restored} channels)`);
        logAction(guild, '🔓 Server Unlock', `**Moderator:** ${actor}\n**Channels restored:** ${un.restored}`, 0x2ECC71);
        await context.get().safeSave();
        return { ok: true, msg: [
            `🔓 **Server unlocked.** ${un.restored} channel${un.restored === 1 ? '' : 's'} restored to their exact previous permissions (all roles).`,
            un.failed.length ? `⚠️ Couldn't restore: ${truncate(un.failed.join(', '), 900)}` : '',
        ].filter(Boolean).join('\n') };
    } finally {
        busy = false;
    }
}

// ---------- real channel lockdown ----------
async function lockChannel({ guild, channel, actor, reason }) {
    const { logAction, db } = context.get();
    if (!isLockable(channel)) return { ok: false, msg: '❌ I can only lock text and announcement channels.' };
    if (!channel.manageable) return { ok: false, msg: `❌ I don't have permission to change permissions in ${mention(channel)}.` };
    const d = data();
    if (d.channels[channel.id]) return { ok: false, msg: `🔒 ${mention(channel)} is already locked.` };
    try {
        const everyone = guild.roles.everyone;
        // If a server lockdown/drill already locked it, reuse that saved state so unlocking restores the original.
        const prev = d.server.active && d.server.saved?.[channel.id] ? d.server.saved[channel.id] : snapshotOverwrite(channel, everyone);
        await channel.permissionOverwrites.edit(everyone, LOCKED_PATCH, { reason: truncate(`Channel lockdown by ${actor}${reason ? `: ${reason}` : ''}`, 400) });
        d.channels[channel.id] = { prev, by: actor, since: Date.now(), reason: reason || null };
        recordEvent(db, 'lockdown', `#${channel.name} locked by ${actor}${reason ? ` — ${reason}` : ''}`);
        logAction(guild, '🔒 Channel Lockdown', `**Channel:** ${mention(channel)}\n**Moderator:** ${actor}${reason ? `\n**Reason:** ${reason}` : ''}`, 0xE74C3C);
        context.bus.emit('lockdown:start', { scope: 'channel' });
        await context.get().safeSave();
        return { ok: true, msg: `🔒 ${mention(channel)} is now locked for @everyone.` };
    } catch (err) {
        return { ok: false, msg: `❌ Couldn't change ${mention(channel)}: ${truncate(err.message, 200)}` };
    }
}

async function unlockChannel({ guild, channel, actor }) {
    const { logAction, db } = context.get();
    if (!isLockable(channel)) return { ok: false, msg: '❌ I can only unlock text and announcement channels.' };
    if (!channel.manageable) return { ok: false, msg: `❌ I don't have permission to change permissions in ${mention(channel)}.` };
    const d = data();
    const everyone = guild.roles.everyone;
    const reason = truncate(`Channel unlock by ${actor}`, 400);
    try {
        const rec = d.channels[channel.id];
        if (!rec) {
            // Not locked by us — still allow clearing a lock set by hand / by the older /mod lockdown.
            if (!isSendDenied(channel, everyone)) return { ok: false, msg: `ℹ️ ${mention(channel)} doesn't look locked.` };
            await restoreOne(channel, everyone, Object.fromEntries(LOCK_PERMS.map((p) => [p, null])), reason);
        } else {
            await restoreOne(channel, everyone, rec.prev, reason);
            delete d.channels[channel.id];
            if (d.server.active && d.server.saved) delete d.server.saved[channel.id];
        }
        recordEvent(db, 'lockdown', `#${channel.name} unlocked by ${actor}`);
        logAction(guild, '🔓 Channel Unlock', `**Channel:** ${mention(channel)}\n**Moderator:** ${actor}`, 0x2ECC71);
        await context.get().safeSave();
        return { ok: true, msg: `🔓 ${mention(channel)} is unlocked.` };
    } catch (err) {
        return { ok: false, msg: `❌ Couldn't change ${mention(channel)}: ${truncate(err.message, 200)}` };
    }
}

// ---------- slash commands ----------
const commands = {
    async drill({ interaction, options, guild, user, isAtLeastAdmin }) {
        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to run drills.');
        const sub = options.getSubcommand();
        if (sub === 'end') {
            const r = await endDrill({ guild, by: user.tag });
            return interaction.editReply(r.msg);
        }
        await interaction.editReply(`🧪 Starting the **${DRILLS[sub].label.toLowerCase()}** — posting the notice and locking the server. This can take a little while…`);
        const r = await startDrill({ guild, kind: sub, minutes: options.getInteger('minutes'), actor: { tag: user.tag }, dm: user });
        return interaction.editReply(r.embed ? { content: r.msg, embeds: [r.embed] } : r.msg);
    },
};

const minutesOpt = { name: 'minutes', description: `How long the drill lasts (default ${DEFAULT_DRILL_MINUTES}, max ${MAX_DRILL_MINUTES})`, type: 4, required: false, min_value: 1, max_value: MAX_DRILL_MINUTES };

const definitions = [
    {
        name: 'drill',
        description: 'Run a staff drill: post a DRILL notice, lock the server, then restore it (Admin+)',
        options: [
            { name: 'raid', description: 'Raid drill: notice in every channel + temporary server lock', type: 1, options: [minutesOpt] },
            { name: 'lockdown', description: 'Server lockdown drill: notice in every channel + temporary server lock', type: 1, options: [minutesOpt] },
            { name: 'end', description: 'End the running drill now (unlock + delete the notices)', type: 1 },
        ],
    },
];

module.exports = {
    commands, definitions, tick, status,
    startDrill, endDrill, lockServer, unlockServer, lockChannel, unlockChannel,
    lockableChannels, DRILLS, drillText, DEFAULT_DRILL_MINUTES, MAX_DRILL_MINUTES,
};
