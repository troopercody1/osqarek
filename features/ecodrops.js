// Eco drops.
//   - Scheduled drops: 3-6 random drops per day (ET), each with a random amount, sent to a random drop channel.
//   - Manual drops from the dashboard (Eco Drops page): pick the amount, channel, an optional expiry date and an
//     optional repeat interval.
//   - Every drop has a Claim button. The first person to press it wins and the button is switched off.
//     Drops do NOT expire on their own; the only expiry is the optional "expires" date on a manual drop (for a
//     repeating drop it is also when the repeating stops).
//   - Nothing is paid out by the bot: it only records who claimed what, and can log it (Features -> Eco Drops ->
//     "Log eco drops", or the Eco Drops page) so staff know who to pay.
//
// Data (db.features.ecodrops): { drops: [...], series: [...], nextId, nextSeriesId }.
// The daily plan of scheduled drops lives in db.features.seasonal.drop (unchanged, so a restart or update never
// re-plans or repeats today's drops).
// Button ids are stateless: eco:c:<dropId>.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, formatDuration, ts } = require('./util');
const { et } = require('./seasonal');

const KEEP_FINISHED = 200;
const MIN_REPEAT_MS = 5 * 60 * 1000;
const MAX_REPEAT_MS = 30 * 86400000;
const MAX_AMOUNT_M = 1000000;

const data = () => store(context.get().db, 'ecodrops', { drops: [], series: [], nextId: 1, nextSeriesId: 1 });
const plan = () => store(context.get().db, 'seasonal', { drop: { day: '', times: [], done: [] }, fact: { day: '' } }).drop;
const touch = () => context.get().saveLater?.();
const find = (id) => data().drops.find((d) => d.id === id) || null;
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const fmtAmount = (n) => `${Number.isInteger(n) ? n : Number(n.toFixed(2))}M`;

async function getChannel(id) {
    if (!id) return null;
    const { client } = context.get();
    return client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
}

// ---------- rendering ----------
function render(d, { ping = '' } = {}) {
    const head = `💸 **ECO DROP!** **${fmtAmount(d.amount)}**`;
    if (d.status === 'claimed') return `${head} was claimed by <@${d.claimedBy}>! 🎉`;
    if (d.status === 'expired') return `${head} expired before anyone claimed it. ⌛`;
    if (d.status === 'cancelled') return `${head} was cancelled. 🚫`;
    return `${ping}${head} has dropped!${d.expiresAt ? `\nClaim it before ${ts(d.expiresAt, 'f')} (${ts(d.expiresAt)}).` : ''}`;
}
function rows(d) {
    const open = d.status === 'open';
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`eco:c:${d.id}`).setStyle(open ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('💸')
            .setLabel(open ? 'Claim' : (d.status === 'claimed' ? 'Claimed' : (d.status === 'expired' ? 'Expired' : 'Cancelled'))).setDisabled(!open),
    )];
}
async function refresh(d) {
    const ch = await getChannel(d.channelId);
    const msg = ch?.messages ? await ch.messages.fetch(d.messageId).catch(() => null) : null;
    if (msg) await msg.edit({ content: render(d), components: rows(d), allowedMentions: { parse: [] } }).catch((err) => console.error('❌ [ecodrops] edit failed:', err.message));
}

// ---------- logging ----------
const WHAT = { dropped: '💸 Eco drop posted', claimed: '✅ Eco drop claimed', expired: '⌛ Eco drop expired', cancelled: '🚫 Eco drop cancelled', series: '🔁 Repeating eco drop', 'series-end': '🔁 Repeating eco drop ended' };
async function log(kind, d, extra = {}) {
    try {
        const cfg = getConfig(context.get().db, 'ecodrops');
        if (!cfg.logEnabled) return;
        if (kind === 'dropped' && !cfg.logDrops) return;
        if (kind === 'claimed' && !cfg.logClaims) return;
        const guild = actions.getGuild();
        if (!guild) return;
        const link = d.messageId ? `https://discord.com/channels/${guild.id}/${d.channelId}/${d.messageId}` : null;
        const fields = [
            { name: 'Amount', value: fmtAmount(d.amount), inline: true },
            { name: 'Channel', value: `<#${d.channelId}>`, inline: true },
        ];
        if (d.id && kind !== 'series' && kind !== 'series-end') fields.push({ name: 'Drop', value: `#${d.id}${link ? ` — [jump](${link})` : ''}`, inline: true });
        if (kind === 'dropped') fields.push({ name: 'Source', value: d.source === 'auto' ? 'Scheduled' : (d.source === 'repeat' ? `Repeat of series #${d.seriesId}` : `Manual (${d.by})`), inline: true });
        if (kind === 'claimed') {
            fields.push({ name: 'Claimed by', value: `<@${d.claimedBy}> (${d.claimedBy})`, inline: true });
            fields.push({ name: 'Time to claim', value: formatDuration(d.claimedAt - d.createdAt), inline: true });
        }
        if (extra.by) fields.push({ name: 'By', value: extra.by, inline: true });
        if (extra.text) fields.push({ name: 'Details', value: extra.text });
        await actions.notify(guild, cfg.logChannel, { embed: brandEmbed({ title: WHAT[kind] || 'Eco drop', fields, color: kind === 'claimed' ? 0x2ECC71 : (kind === 'dropped' ? 0xF1C40F : 0x95A5A6) }) });
    } catch (err) { console.error('❌ [ecodrops] log failed:', err.message); }
}

// ---------- posting ----------
function prune(d) {
    const finished = d.drops.filter((x) => x.status !== 'open');
    if (finished.length > KEEP_FINISHED) {
        const drop = new Set(finished.sort((a, b) => a.createdAt - b.createdAt).slice(0, finished.length - KEEP_FINISHED).map((x) => x.id));
        d.drops = d.drops.filter((x) => !drop.has(x.id));
    }
    d.series = d.series.filter((s) => s.status === 'active' || Date.now() - (s.endedAt || 0) < 14 * 86400000);
}

async function postDrop({ channelId, amount, source = 'auto', by = 'scheduler', seriesId = null, expiresAt = null, ping = '' }) {
    const d = data();
    const ch = await getChannel(channelId);
    if (!ch?.send || !ch.isTextBased()) return { ok: false, error: 'I can\'t find that text channel.' };
    const me = ch.guild?.members.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (perms && (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages))) return { ok: false, error: `I need View Channel and Send Messages in #${ch.name}.` };
    const drop = { id: d.nextId++, channelId: ch.id, messageId: null, amount, source, by, seriesId, createdAt: Date.now(), expiresAt, status: 'open', claimedBy: null, claimedAt: null };
    const roleId = ping && /^\d{15,25}$/.test(ping) ? ping : null;
    const msg = await ch.send({ content: render(drop, { ping: roleId ? `<@&${roleId}> ` : '' }), components: rows(drop), allowedMentions: roleId ? { roles: [roleId] } : { parse: [] } })
        .catch((err) => { console.error('❌ [ecodrops] send failed:', err.message); return null; });
    if (!msg) { d.nextId--; return { ok: false, error: 'Discord refused the message.' }; }
    drop.messageId = msg.id;
    d.drops.push(drop);
    prune(d);
    recordEvent(context.get().db, 'ecodrop', `Eco drop #${drop.id} (${fmtAmount(amount)}) posted in #${ch.name} — ${source}${source === 'auto' ? '' : ` by ${by}`}`);
    await context.get().safeSave();
    await log('dropped', drop);
    return { ok: true, drop, msg };
}

// A scheduled drop: random channel from the configured pool, random amount.
async function sendScheduled(cfg) {
    const pool = cfg.channels.filter((x) => /^\d{15,25}$/.test(x));
    if (!pool.length) return;
    const lo = Math.min(cfg.minAmount, cfg.maxAmount), hi = Math.max(cfg.minAmount, cfg.maxAmount);
    const r = await postDrop({ channelId: pool[randInt(0, pool.length - 1)], amount: randInt(lo, hi), source: 'auto', ping: cfg.pingRole });
    if (!r.ok) console.error('❌ [ecodrops] scheduled drop failed:', r.error);
}

// ---------- manual drops (dashboard) ----------
// opts: { channelId, amount (millions), expiresAt (ms|null), repeatMs (ms|null), ping (bool), by }
async function createManual(opts) {
    const { db } = context.get();
    const cfg = getConfig(db, 'ecodrops');
    const err = (error) => ({ ok: false, error });
    const amount = Number(opts.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_M) return err(`Amount must be between 0 and ${MAX_AMOUNT_M.toLocaleString()} (in millions).`);
    const expiresAt = opts.expiresAt || null;
    if (expiresAt && expiresAt <= Date.now() + 60000) return err('The expire date must be at least a minute from now.');
    const repeatMs = opts.repeatMs || null;
    if (repeatMs && (repeatMs < MIN_REPEAT_MS || repeatMs > MAX_REPEAT_MS)) return err('Repeat interval must be between 5 minutes and 30 days.');
    const ping = opts.ping ? cfg.pingRole : '';

    let seriesId = null;
    const d = data();
    if (repeatMs) {
        seriesId = d.nextSeriesId++;
        d.series.push({ id: seriesId, channelId: opts.channelId, amount: Math.round(amount * 100) / 100, everyMs: repeatMs, nextAt: Date.now() + repeatMs, expiresAt, ping, by: opts.by, createdAt: Date.now(), status: 'active', posted: 0 });
    }
    const r = await postDrop({ channelId: opts.channelId, amount: Math.round(amount * 100) / 100, source: repeatMs ? 'repeat' : 'manual', by: opts.by, seriesId, expiresAt, ping });
    if (!r.ok) {
        if (seriesId) { d.series = d.series.filter((s) => s.id !== seriesId); d.nextSeriesId--; }
        return r;
    }
    if (seriesId) {
        d.series.find((s) => s.id === seriesId).posted = 1;
        await log('series', r.drop, { by: opts.by, text: `Every ${formatDuration(repeatMs)}${expiresAt ? `, until ${ts(expiresAt, 'f')}` : ', until stopped'}.` });
        await context.get().safeSave();
    }
    return { ...r, seriesId };
}

async function cancelDrop(id, by) {
    const drop = find(id);
    if (!drop || drop.status !== 'open') return { ok: false, error: 'That drop is not open.' };
    drop.status = 'cancelled';
    recordEvent(context.get().db, 'ecodrop', `Eco drop #${drop.id} cancelled by ${by}`);
    await refresh(drop);
    await context.get().safeSave();
    await log('cancelled', drop, { by });
    return { ok: true, drop };
}

async function endSeries(id, by) {
    const s = data().series.find((x) => x.id === id);
    if (!s || s.status !== 'active') return { ok: false, error: 'That repeat is not active.' };
    s.status = 'ended'; s.endedAt = Date.now();
    recordEvent(context.get().db, 'ecodrop', `Repeating eco drop #${s.id} stopped by ${by}`);
    await context.get().safeSave();
    await log('series-end', { amount: s.amount, channelId: s.channelId }, { by, text: `Series #${s.id} posted ${s.posted} drop(s).` });
    return { ok: true, series: s };
}

// ---------- the claim button ----------
async function handleButton(interaction) {
    const id = parseInt(interaction.customId.split(':')[2], 10);
    const drop = find(id);
    const eph = { flags: MessageFlags.Ephemeral };
    if (!drop) return interaction.reply({ content: '❌ This drop isn\'t tracked any more.', ...eph });
    if (drop.status === 'open' && drop.expiresAt && drop.expiresAt <= Date.now()) { drop.status = 'expired'; touch(); await refresh(drop); await log('expired', drop); }
    if (drop.status === 'claimed') return interaction.reply({ content: `😕 Too late — <@${drop.claimedBy}> already claimed this one.`, allowedMentions: { parse: [] }, ...eph });
    if (drop.status !== 'open') return interaction.reply({ content: `⌛ This drop is ${drop.status}.`, ...eph });

    // State changes before any await, so two near-simultaneous clicks can never both win.
    drop.status = 'claimed';
    drop.claimedBy = interaction.user.id;
    drop.claimedAt = Date.now();
    recordEvent(context.get().db, 'ecodrop', `Eco drop #${drop.id} (${fmtAmount(drop.amount)}) claimed by ${interaction.user.tag}`);
    await interaction.update({ content: render(drop), components: rows(drop), allowedMentions: { parse: [] } }).catch(() => refresh(drop));
    await context.get().safeSave();
    await log('claimed', drop);
}

// ---------- scheduler ----------
function planTimes(count, from, to, gap = 20, existing = []) {
    const times = [];
    for (let tries = 0; times.length < count && tries < 500; tries++) {
        const m = randInt(from, to - 1);
        if (times.every((x) => Math.abs(x - m) >= gap) && existing.every((x) => Math.abs(x - m) >= gap)) times.push(m);
    }
    return times.sort((a, b) => a - b);
}

async function tickScheduled(t) {
    const cfg = getConfig(context.get().db, 'ecodrops');
    if (!cfg.enabled || !cfg.channels.length) return;
    const p = plan();
    const from = Math.min(cfg.startHour, cfg.endHour - 1) * 60;
    const to = Math.max(cfg.endHour, cfg.startHour + 1) * 60;
    const hi = Math.max(1, cfg.maxPerDay);
    const lo = Math.min(cfg.minPerDay, hi);

    if (p.day !== t.key) {
        const times = planTimes(randInt(lo, hi), from, to);
        Object.assign(p, { day: t.key, times, done: times.map(() => false) });
        touch();
    }
    // Top-off if the minimum was raised mid-day.
    const missing = lo - p.times.length;
    if (missing > 0 && t.minutes + 1 < to) {
        const extra = planTimes(missing, Math.max(from, t.minutes + 1), to, 20, p.times);
        if (extra.length) {
            const pairs = p.times.map((m, i) => [m, p.done[i]]).concat(extra.map((m) => [m, false])).sort((x, y) => x[0] - y[0]);
            p.times = pairs.map((x) => x[0]);
            p.done = pairs.map((x) => x[1]);
            touch();
        }
    }
    for (let i = 0; i < p.times.length; i++) {
        if (p.done[i] || t.minutes < p.times[i]) continue;
        p.done[i] = true; // mark first so a failure can never spam
        touch();
        if (t.minutes - p.times[i] > 15) continue; // missed by >15 min (bot was down): skip rather than send late
        await sendScheduled(cfg);
        break; // at most one per tick
    }
}

async function tickRepeats() {
    const d = data();
    const now = Date.now();
    for (const s of d.series) {
        if (s.status !== 'active') continue;
        if (s.expiresAt && now >= s.expiresAt) { s.status = 'ended'; s.endedAt = now; touch(); await log('series-end', { amount: s.amount, channelId: s.channelId }, { text: `Series #${s.id} reached its expire date after ${s.posted} drop(s).` }); continue; }
        if (s.nextAt > now) continue;
        while (s.nextAt <= now) s.nextAt += s.everyMs; // never burst-post after downtime
        s.posted++;
        touch();
        const r = await postDrop({ channelId: s.channelId, amount: s.amount, source: 'repeat', by: s.by, seriesId: s.id, expiresAt: s.expiresAt, ping: s.ping });
        if (!r.ok) console.error(`❌ [ecodrops] repeat #${s.id} failed: ${r.error}`);
    }
}

async function tickExpiry() {
    const now = Date.now();
    let edits = 0;
    for (const drop of data().drops) {
        if (drop.status !== 'open' || !drop.expiresAt || drop.expiresAt > now || edits >= 5) continue;
        drop.status = 'expired';
        edits++;
        recordEvent(context.get().db, 'ecodrop', `Eco drop #${drop.id} expired unclaimed`);
        await refresh(drop);
        await log('expired', drop);
        touch();
    }
}

async function tick() {
    if (!context.ready()) return;
    await tickScheduled(et()).catch((err) => console.error('❌ [ecodrops] scheduled:', err.message));
    await tickRepeats().catch((err) => console.error('❌ [ecodrops] repeats:', err.message));
    await tickExpiry().catch((err) => console.error('❌ [ecodrops] expiry:', err.message));
}

// ---------- dashboard view ----------
function view() {
    const d = data();
    const sorted = [...d.drops].sort((a, b) => b.id - a.id);
    return {
        drops: sorted.slice(0, 40),
        series: d.series.filter((s) => s.status === 'active'),
        stats: { open: d.drops.filter((x) => x.status === 'open').length, claimed: d.drops.filter((x) => x.status === 'claimed').length, total: d.drops.length, activeRepeats: d.series.filter((s) => s.status === 'active').length },
        fmtAmount,
    };
}

module.exports = { tick, handleButton, createManual, cancelDrop, endSeries, view, fmtAmount, data, find };
