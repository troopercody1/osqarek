// Voice time stats: how long members spend in voice channels.
//   - Tracks sessions from voiceStateUpdate (join / move / leave); time is credited to the day it happened.
//   - Live sessions are persisted and credited every minute, so a restart or crash loses at most ~1 minute,
//     and a self-healing reconcile keeps the in-memory picture in sync with who is really in voice.
//   - Stores counts only: per-user totals, per-day totals (per user + per channel). No audio, no content.
//   - Bots are ignored; the server's AFK channel is excluded by default.
// Slash: /vc stats [user] | /vc top [days] | /vc server [days] | /vc now
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, dayKey, formatDuration, truncate } = require('./util');

const FLUSH_EVERY_MS = 60 * 1000;
const RECONCILE_EVERY_MS = 10 * 60 * 1000;
const STALE_RESUME_MS = 3 * 60 * 1000; // after a restart, only credit the gap if it was shorter than this
let lastFlush = 0;
let lastReconcile = 0;
let lastPrune = '';

function data() {
    const { db } = context.get();
    return store(db, 'voice', { users: {}, days: {}, active: {}, beat: 0 });
}
const cfgNow = () => getConfig(context.get().db, 'voice');
const touch = () => context.get().saveLater?.();

// "3h 12m"; anything under a minute reads "<1m".
function fmt(ms) {
    if (!ms || ms < 1000) return '0m';
    if (ms < 60000) return '<1m';
    return formatDuration(ms);
}
const hours = (ms) => Math.round((ms / 3600000) * 100) / 100;

function userRec(d, uid) {
    const u = d.users[uid] || (d.users[uid] = { total: 0, sessions: 0, longest: 0, last: 0, ch: {} });
    if (!u.ch) u.ch = {};
    return u;
}

function nextMidnight(ts) {
    const x = new Date(ts);
    x.setHours(24, 0, 0, 0);
    return x.getTime();
}

function addMs(d, uid, ch, key, ms) {
    const day = d.days[key] || (d.days[key] = { ms: 0, ch: {}, u: {} });
    day.ms += ms;
    day.ch[ch] = (day.ch[ch] || 0) + ms;
    day.u[uid] = (day.u[uid] || 0) + ms;
}

// Credits [s.since, now] to the right day(s) (split at local midnight) and advances s.since.
function credit(d, uid, s, now) {
    let from = s.since;
    if (!(now > from)) return;
    s.since = now;
    if (s.afk) return;
    const u = userRec(d, uid);
    while (from < now) {
        const end = Math.min(now, nextMidnight(from));
        const ms = end - from;
        u.total += ms;
        u.ch[s.ch] = (u.ch[s.ch] || 0) + ms;
        s.counted = (s.counted || 0) + ms;
        addMs(d, uid, s.ch, dayKey(from), ms);
        from = end;
    }
    u.last = now;
}

function closeSession(d, uid, s) {
    const u = userRec(d, uid);
    if ((s.counted || 0) > u.longest) u.longest = s.counted;
    delete d.active[uid];
}

const isAfk = (guild, chId, cfg) => !!(cfg.excludeAfk && guild.afkChannelId && guild.afkChannelId === chId);

function openSession(d, guild, uid, chId, now, cfg) {
    d.active[uid] = { ch: chId, start: now, since: now, counted: 0, afk: isAfk(guild, chId, cfg) };
    userRec(d, uid).sessions++;
}

// Credits everyone currently in voice up to `now`. Cheap (in-memory).
function flushAll(now = Date.now()) {
    const d = data();
    for (const [uid, s] of Object.entries(d.active)) credit(d, uid, s, now);
    d.beat = now;
    lastFlush = now;
}

// ---------- events ----------
function onVoiceState(oldS, newS) {
    const cfg = cfgNow();
    if (!cfg.enabled) return;
    const member = newS.member || oldS.member;
    const guild = newS.guild || oldS.guild;
    if (!member || member.user?.bot || !guild) return;
    if (guild.id !== actions.getGuild()?.id) return;
    if (oldS.channelId === newS.channelId) return; // mute / deafen / stream changes: not a channel change

    const d = data();
    const uid = member.id;
    const now = Date.now();
    const s = d.active[uid];
    if (s) credit(d, uid, s, now);

    if (!newS.channelId) { // left voice
        if (s) closeSession(d, uid, s);
    } else if (s) { // moved between channels: same session, new channel
        s.ch = newS.channelId;
        s.afk = isAfk(guild, newS.channelId, cfg);
    } else { // joined voice
        openSession(d, guild, uid, newS.channelId, now, cfg);
    }
    touch();
}

// Syncs saved sessions with who is actually in voice right now (startup + every 10 minutes).
// `resume: true` is for startup only: if we were down longer than STALE_RESUME_MS the gap isn't credited.
function reconcile(guild, { resume = false } = {}) {
    const cfg = cfgNow();
    if (!cfg.enabled || !guild) return;
    const d = data();
    const now = Date.now();
    const inVc = new Map();
    for (const [id, vs] of guild.voiceStates.cache) {
        if (vs.channelId && !vs.member?.user?.bot) inVc.set(id, vs.channelId);
    }
    for (const [uid, s] of Object.entries(d.active)) {
        if (!inVc.has(uid)) closeSession(d, uid, s); // left while we weren't watching: no credit for the gap
    }
    for (const [uid, chId] of inVc) {
        const s = d.active[uid];
        if (!s) { openSession(d, guild, uid, chId, now, cfg); continue; }
        if (resume && now - s.since > STALE_RESUME_MS) s.since = now; // we were down too long to trust the gap
        credit(d, uid, s, now);
        if (s.ch !== chId) { s.ch = chId; s.afk = isAfk(guild, chId, cfg); }
    }
    lastReconcile = now;
    touch();
}

// Scheduler hook (every 10s).
function tick() {
    const cfg = cfgNow();
    const d = data();
    const now = Date.now();
    if (!cfg.enabled) { if (Object.keys(d.active).length) d.active = {}; return; }

    if (now - lastFlush >= FLUSH_EVERY_MS) { flushAll(now); touch(); }
    if (now - lastReconcile >= RECONCILE_EVERY_MS) reconcile(actions.getGuild());

    const key = dayKey();
    if (lastPrune !== key) {
        lastPrune = key;
        const cutoff = dayKey(now - cfg.retentionDays * 86400000);
        for (const k of Object.keys(d.days)) if (k < cutoff) delete d.days[k];
        touch();
    }
}

// ---------- reporting ----------
function lastNDayKeys(n) {
    const keys = [];
    for (let i = n - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
    return keys;
}

function topOf(map, n) {
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, ms]) => ({ id, ms }));
}

// Server-wide report for the last `days` days.
function report(days = 7) {
    flushAll();
    const d = data();
    const keys = lastNDayKeys(days);
    const users = {};
    const channels = {};
    const perDay = keys.map((k) => {
        const day = d.days[k];
        if (!day) return 0;
        for (const [id, ms] of Object.entries(day.u)) users[id] = (users[id] || 0) + ms;
        for (const [id, ms] of Object.entries(day.ch)) channels[id] = (channels[id] || 0) + ms;
        return day.ms;
    });
    const totalMs = perDay.reduce((a, b) => a + b, 0);
    const uniqueUsers = Object.keys(users).length;
    return {
        days, keys, perDay, totalMs, uniqueUsers,
        avgPerUser: uniqueUsers ? totalMs / uniqueUsers : 0,
        topUsers: topOf(users, 10),
        topChannels: topOf(channels, 10),
        liveNow: Object.keys(d.active).length,
        trackedDays: keys.filter((k) => d.days[k]).length,
        trackedUsers: Object.keys(d.users).length,
    };
}

// Leaderboard: days = null for all-time.
function leaderboard(days = null, limit = 10) {
    flushAll();
    const d = data();
    if (!days) return Object.entries(d.users).filter(([, u]) => u.total > 0).sort((a, b) => b[1].total - a[1].total).slice(0, limit).map(([id, u]) => ({ id, ms: u.total }));
    const users = {};
    for (const k of lastNDayKeys(days)) for (const [id, ms] of Object.entries(d.days[k]?.u || {})) users[id] = (users[id] || 0) + ms;
    return topOf(users, limit);
}

function userStats(uid) {
    flushAll();
    const d = data();
    const u = d.users[uid];
    const range = (n) => lastNDayKeys(n).reduce((a, k) => a + (d.days[k]?.u?.[uid] || 0), 0);
    const activeDays = Object.values(d.days).filter((day) => day.u?.[uid]).length;
    const favourite = topOf(u?.ch || {}, 1)[0] || null;
    const ranked = Object.entries(d.users).filter(([, x]) => x.total > 0).sort((a, b) => b[1].total - a[1].total);
    const rank = ranked.findIndex(([id]) => id === uid) + 1;
    const live = d.active[uid] || null;
    return {
        total: u?.total || 0, sessions: u?.sessions || 0, longest: u?.longest || 0, last: u?.last || 0,
        d7: range(7), d30: range(30), activeDays, favourite,
        rank: rank || null, ranked: ranked.length,
        live: live && { ch: live.ch, start: live.start, afk: live.afk },
    };
}

// Who is in voice right now, grouped by channel.
function liveNow() {
    flushAll();
    const d = data();
    const by = {};
    for (const [uid, s] of Object.entries(d.active)) (by[s.ch] || (by[s.ch] = [])).push({ uid, since: s.start, afk: s.afk });
    return by;
}

// ---------- slash command ----------
const MEDALS = ['🥇', '🥈', '🥉'];
const rankLine = (e, i) => `${MEDALS[i] || `**${i + 1}.**`} <@${e.id}> — ${fmt(e.ms)}`;

const commands = {
    async vc({ interaction, options, guild, user, isMod }) {
        const { db } = context.get();
        if (!getConfig(db, 'voice').enabled) return interaction.editReply('🚫 Voice stats are disabled (`/feature enable voice`).');
        const sub = options.getSubcommand();

        if (sub === 'stats') {
            const target = options.getUser('user') || user;
            if (target.id !== user.id && !isMod) return interaction.editReply('❌ You need **Moderator+** to view someone else\'s voice stats.');
            if (target.bot) return interaction.editReply('🤖 Bots aren\'t tracked.');
            const s = userStats(target.id);
            if (!s.total && !s.live) return interaction.editReply(`ℹ️ No voice time recorded for **${target.username}** yet — stats start from when voice tracking was turned on.`);
            return interaction.editReply({ embeds: [brandEmbed({
                title: `🎙️ Voice stats — ${target.username}`,
                fields: [
                    { name: 'All-time', value: fmt(s.total), inline: true },
                    { name: 'Last 7 days', value: fmt(s.d7), inline: true },
                    { name: 'Last 30 days', value: fmt(s.d30), inline: true },
                    { name: 'Sessions', value: String(s.sessions), inline: true },
                    { name: 'Longest session', value: fmt(s.longest), inline: true },
                    { name: 'Average session', value: s.sessions ? fmt(s.total / s.sessions) : '—', inline: true },
                    { name: 'Rank', value: s.rank ? `#${s.rank} of ${s.ranked}` : '—', inline: true },
                    { name: 'Active days', value: String(s.activeDays), inline: true },
                    { name: 'Favourite channel', value: s.favourite ? `<#${s.favourite.id}> (${fmt(s.favourite.ms)})` : '—', inline: true },
                    ...(s.live ? [{ name: 'Right now', value: `In <#${s.live.ch}> for ${fmt(Date.now() - s.live.start)}${s.live.afk ? ' (AFK — not counted)' : ''}` }] : []),
                ],
                footer: 'Voice time is counted from when tracking started • AFK channel excluded',
            })] });
        }

        if (sub === 'top') {
            const days = options.getInteger('days');
            const rows = leaderboard(days || null, 10);
            if (!rows.length) return interaction.editReply('ℹ️ No voice time recorded yet.');
            return interaction.editReply({ embeds: [brandEmbed({
                title: `🏆 Voice leaderboard — ${days ? `last ${days} day${days === 1 ? '' : 's'}` : 'all-time'}`,
                description: rows.map(rankLine).join('\n'),
            })] });
        }

        if (sub === 'server') {
            if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
            const days = options.getInteger('days') || 7;
            const r = report(days);
            if (!r.totalMs && !r.liveNow) return interaction.editReply('ℹ️ No voice time recorded in that period yet.');
            const { spark } = require('./analytics');
            return interaction.editReply({ embeds: [brandEmbed({
                title: `🎙️ Voice — last ${days} day${days === 1 ? '' : 's'}`,
                description: `\`${spark(r.perDay)}\` voice time per day`,
                fields: [
                    { name: 'Total voice time', value: fmt(r.totalMs), inline: true },
                    { name: 'Unique members', value: String(r.uniqueUsers), inline: true },
                    { name: 'Avg per member', value: fmt(r.avgPerUser), inline: true },
                    { name: 'In voice now', value: String(r.liveNow), inline: true },
                    { name: 'Top members', value: r.topUsers.slice(0, 5).map(rankLine).join('\n') || '—' },
                    { name: 'Top channels', value: r.topChannels.slice(0, 5).map((c) => `<#${c.id}> — ${fmt(c.ms)}`).join('\n') || '—' },
                ],
                footer: `${r.trackedDays}/${days} days have data • Dashboard → Analytics has charts`,
            })] });
        }

        if (sub === 'now') {
            const by = liveNow();
            const entries = Object.entries(by);
            if (!entries.length) return interaction.editReply('🔇 Nobody is in a voice channel right now.');
            const lines = entries.map(([ch, list]) => `**<#${ch}>**\n${list.map((m) => `• <@${m.uid}> — ${fmt(Date.now() - m.since)}${m.afk ? ' (AFK)' : ''}`).join('\n')}`);
            return interaction.editReply({ embeds: [brandEmbed({ title: '🎙️ In voice right now', description: truncate(lines.join('\n\n'), 3800) })] });
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const daysOpt = (desc, req = false) => ({ name: 'days', description: desc, type: 4, required: req, min_value: 1, max_value: 365 });
const definitions = [
    {
        name: 'vc',
        description: 'Voice channel time stats',
        options: [
            { name: 'stats', description: 'Voice time for you (or another member — Moderator+)', type: 1, options: [{ name: 'user', description: 'Member (Moderator+ to view others)', type: 6, required: false }] },
            { name: 'top', description: 'Voice time leaderboard', type: 1, options: [daysOpt('Last N days (leave empty for all-time)')] },
            { name: 'server', description: 'Server-wide voice summary (Moderator+)', type: 1, options: [daysOpt('Days to cover (default 7)')] },
            { name: 'now', description: 'Who is in voice right now', type: 1 },
        ],
    },
];

module.exports = { onVoiceState, reconcile, tick, report, leaderboard, userStats, liveNow, flushAll, fmt, hours, commands, definitions };
