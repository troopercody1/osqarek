// Analytics: compact per-day counters (no message content, no per-user history).
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, dayKey, truncate } = require('./util');
const { searchCases, caseTime } = require('./cases');

const todaySets = { key: null, users: new Set() };
const CHANNELS_KEPT_PER_DAY = 30;

function data() {
    const { db } = context.get();
    return store(db, 'analytics', { days: {} });
}

function newDay() {
    return { m: 0, hm: 0, a: 0, j: 0, l: 0, b: 0, r: 0, dr: 0, lk: 0, h: Array(24).fill(0), ch: {}, mc: null };
}

function day(key = dayKey()) {
    const d = data();
    if (!d.days[key]) d.days[key] = newDay();
    const rec = d.days[key];
    if (!Array.isArray(rec.h) || rec.h.length !== 24) rec.h = Array(24).fill(0);
    if (!rec.ch) rec.ch = {};
    return rec;
}

function enabled() {
    return getConfig(context.get().db, 'analytics').enabled;
}

function touch() { context.get().saveLater?.(); }

function onMessage(message) {
    if (!enabled() || !message.guild) return;
    if (message.guild.id !== actions.getGuild()?.id) return;
    const cfg = getConfig(context.get().db, 'analytics');
    const key = dayKey();
    if (todaySets.key !== key) { todaySets.key = key; todaySets.users = new Set(); }
    const rec = day(key);
    const human = !message.author.bot;
    rec.m++; // all messages (bot + human)
    if (human) rec.hm = (rec.hm || 0) + 1; // human messages only
    rec.h[new Date().getHours()]++;
    if (cfg.trackChannels) rec.ch[message.channel.id] = (rec.ch[message.channel.id] || 0) + 1;
    if (human) {
        todaySets.users.add(message.author.id);
        rec.a = Math.max(rec.a, todaySets.users.size); // survives restarts as a floor
    }
    touch();
}

function onJoin(member) {
    if (!enabled() || member.user.bot) return;
    const rec = day(); rec.j++; rec.mc = member.guild.memberCount; touch();
}
function onLeave(member) {
    if (!enabled() || member.user?.bot) return;
    const rec = day(); rec.l++; rec.mc = member.guild.memberCount; touch();
}
function onBan() { if (!enabled()) return; day().b++; touch(); }
function onRaid() { if (!enabled()) return; day().r++; touch(); }
function onDrill() { if (!enabled()) return; day().dr = (day().dr || 0) + 1; touch(); }
function onLockdown() { if (!enabled()) return; day().lk = (day().lk || 0) + 1; touch(); }

// ---------- startup-sync backfill ----------
// The startup stats sync already pages through every message in the server. This collector rides along on that
// scan (no extra API calls), tallies per-day / per-hour / per-channel message counts, and when the sync finishes
// merges them into the analytics store. Merging takes the larger of "live count" and "scanned count" per field,
// so it's idempotent and never double-counts messages the bot also saw live. Bot messages count toward the all-messages total but not the human total or active users, same as live.
function createHistoryCollector() {
    const cfg = getConfig(context.get().db, 'analytics');
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - cfg.retentionDays);
    const cutoffMs = cutoff.getTime();
    const days = {};
    let counted = 0;

    return {
        add(msg) {
            try {
                if (!cfg.enabled || msg.createdTimestamp < cutoffMs) return;
                const key = dayKey(msg.createdTimestamp);
                const rec = days[key] || (days[key] = { m: 0, hm: 0, h: Array(24).fill(0), ch: {}, users: new Set() });
                const human = !msg.author?.bot;
                rec.m++;
                if (human) { rec.hm++; rec.users.add(msg.author.id); }
                rec.h[new Date(msg.createdTimestamp).getHours()]++;
                if (cfg.trackChannels) rec.ch[msg.channelId] = (rec.ch[msg.channelId] || 0) + 1;
                counted++;
            } catch { /* never let analytics break the sync */ }
        },
        // Merge into the store. Returns { enabled, days, messages } for the sync summary.
        async apply(guild) {
            if (!cfg.enabled) return { enabled: false, days: 0, messages: 0 };
            const live = data();
            for (const [key, scanned] of Object.entries(days)) {
                const rec = day(key);
                rec.m = Math.max(rec.m || 0, scanned.m);
                rec.hm = Math.max(rec.hm || 0, scanned.hm);
                rec.a = Math.max(rec.a || 0, scanned.users.size);
                scanned.h.forEach((n, i) => { rec.h[i] = Math.max(rec.h[i] || 0, n); });
                for (const [id, n] of Object.entries(scanned.ch)) rec.ch[id] = Math.max(rec.ch[id] || 0, n);
                const entries = Object.entries(rec.ch);
                if (key < dayKey() && entries.length > CHANNELS_KEPT_PER_DAY) rec.ch = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, CHANNELS_KEPT_PER_DAY));
            }
            snapshot(guild);
            live.lastSync = { at: Date.now(), days: Object.keys(days).length, messages: counted };
            await (context.get().saveLater?.flush ? context.get().saveLater.flush() : context.get().safeSave());
            return { enabled: true, days: live.lastSync.days, messages: counted };
        },
    };
}

function snapshot(guild) {
    if (!enabled() || !guild) return;
    day().mc = guild.memberCount;
}

// Called by the scheduler: trims old days and old per-channel tails.
let lastPrune = '';
function tick() {
    const key = dayKey();
    if (lastPrune === key) return;
    lastPrune = key;
    const cfg = getConfig(context.get().db, 'analytics');
    const d = data();
    const cutoff = dayKey(Date.now() - cfg.retentionDays * 86400000);
    for (const k of Object.keys(d.days)) {
        if (k < cutoff) { delete d.days[k]; continue; }
        if (k < key) {
            const entries = Object.entries(d.days[k].ch || {});
            if (entries.length > CHANNELS_KEPT_PER_DAY) d.days[k].ch = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, CHANNELS_KEPT_PER_DAY));
        }
    }
    snapshot(actions.getGuild());
    touch();
}

// ---------- reporting ----------
function lastNDayKeys(n) {
    const keys = [];
    for (let i = n - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
    return keys;
}

// Older/partial saved lastSync objects may lack fields; never hand the template undefined numbers.
function normalizeLastSync(ls) {
    if (!ls || typeof ls !== 'object') return null;
    const messages = Number(ls.messages ?? ls.counted ?? ls.total ?? ls.scanned);
    return {
        at: Number(ls.at) || null,
        days: Number(ls.days) || 0,
        messages: Number.isFinite(messages) ? messages : 0,
    };
}

function report(days = 7) {
    const { db } = context.get();
    const d = data();
    const keys = lastNDayKeys(days);
    const empty = newDay();
    const recs = keys.map((k) => d.days[k] || empty);
    const sum = (f) => recs.reduce((a, r) => a + (f(r) || 0), 0);

    const hourly = Array(24).fill(0);
    const channels = {};
    for (const r of recs) {
        (r.h || []).forEach((n, i) => { hourly[i] += n; });
        for (const [id, n] of Object.entries(r.ch || {})) channels[id] = (channels[id] || 0) + n;
    }

    // Moderation activity comes straight from the case list.
    const sinceMs = Date.now() - days * 86400000;
    const caseRes = searchCases(db.cases, { sinceMs, pageSize: 1 });
    const casesPerDay = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const c of db.cases || []) {
        const t = caseTime(c);
        if (t && t >= sinceMs) { const k = dayKey(t); if (k in casesPerDay) casesPerDay[k]++; }
    }

    // Member count: last known snapshot at or before each day (carry forward).
    let carry = null;
    const members = recs.map((r) => { if (r.mc != null) carry = r.mc; return carry; });

    const peakHour = hourly.some((n) => n > 0) ? hourly.indexOf(Math.max(...hourly)) : null;
    return {
        days, keys,
        messages: recs.map((r) => r.m || 0), // bot + human
        humanMessages: recs.map((r) => r.hm ?? r.m ?? 0), // legacy days (before bot counting) only had human counts in m
        active: recs.map((r) => r.a || 0),
        joins: recs.map((r) => r.j || 0),
        leaves: recs.map((r) => r.l || 0),
        bans: recs.map((r) => r.b || 0),
        raids: recs.map((r) => r.r || 0),
        drills: recs.map((r) => r.dr || 0),
        lockdowns: recs.map((r) => r.lk || 0),
        lastSync: normalizeLastSync(d.lastSync),
        modActions: keys.map((k) => casesPerDay[k]),
        members,
        hourly,
        peakHour,
        topChannels: Object.entries(channels).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ id, count })),
        casesByType: caseRes.byType,
        totals: { messages: sum((r) => r.m), humanMessages: sum((r) => r.hm ?? r.m), joins: sum((r) => r.j), leaves: sum((r) => r.l), bans: sum((r) => r.b), raids: sum((r) => r.r), drills: sum((r) => r.dr), lockdowns: sum((r) => r.lk), cases: caseRes.total },
        trackedDays: keys.filter((k) => d.days[k]).length,
    };
}

const SPARK = '▁▂▃▄▅▆▇█';
function spark(values) {
    const max = Math.max(...values, 0);
    if (!max) return '▁'.repeat(values.length);
    return values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]).join('');
}

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

const commands = {
    async analytics({ interaction, options, guild, isMod }) {
        const { db } = context.get();
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        if (!getConfig(db, 'analytics').enabled) return interaction.editReply('🚫 Analytics is disabled (`/feature enable analytics`).');
        const days = options.getInteger('days') || 7;
        const r = report(days);
        if (!r.trackedDays) return interaction.editReply('ℹ️ No data collected yet — stats build up from the moment this feature is enabled.');
        const net = r.totals.joins - r.totals.leaves;
        const chans = r.topChannels.slice(0, 5).map((c) => `<#${c.id}> — ${c.count.toLocaleString()}`).join('\n') || '*not tracked*';
        return interaction.editReply({
            embeds: [brandEmbed({
                title: `📈 Server analytics — last ${days} day${days === 1 ? '' : 's'}`,
                description: `\`${spark(r.messages)}\` bot + human messages per day\n\`${spark(r.humanMessages)}\` human messages per day`,
                fields: [
                    { name: 'Messages (bot + human)', value: r.totals.messages.toLocaleString(), inline: true },
                    { name: 'Human messages', value: r.totals.humanMessages.toLocaleString(), inline: true },
                    { name: 'Members', value: `${guild.memberCount.toLocaleString()} (${net >= 0 ? '+' : ''}${net})`, inline: true },
                    { name: 'Joins / Leaves', value: `${r.totals.joins} / ${r.totals.leaves}`, inline: true },
                    { name: 'Bans', value: String(r.totals.bans), inline: true },
                    { name: 'Mod cases', value: String(r.totals.cases), inline: true },
                    { name: 'Raid incidents', value: String(r.totals.raids), inline: true },
                    { name: 'Drills / Lockdowns', value: `${r.totals.drills} / ${r.totals.lockdowns}`, inline: true },
                    { name: 'Voice time', value: (() => { try { return require('./voice').fmt(require('./voice').report(days).totalMs); } catch { return '—'; } })(), inline: true },
                    { name: 'Busiest hour', value: r.peakHour === null ? '—' : `${hourLabel(r.peakHour)}–${hourLabel((r.peakHour + 1) % 24)}`, inline: true },
                    { name: 'Top channels', value: chans },
                ],
                footer: `${r.trackedDays}/${days} days have data • Dashboard has full charts`,
            })],
        });
    },
};

const definitions = [
    {
        name: 'analytics',
        description: 'Server analytics summary (Moderator+)',
        options: [{ name: 'days', description: 'Days to cover (default 7)', type: 4, required: false, min_value: 1, max_value: 90 }],
    },
];

module.exports = { onMessage, onJoin, onLeave, onBan, onRaid, onDrill, onLockdown, createHistoryCollector, snapshot, tick, report, spark, hourLabel, commands, definitions };
