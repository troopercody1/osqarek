// Ban-evasion flags: score every new joiner against the people we've banned.
const axios = require('axios');
const sharp = require('sharp');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, fold, similarity, truncate, ts } = require('./util');

const BANNED_CAP = 2000;
const FLAG_CAP = 200;
const JOININFO_CAP = 1500;

const inviteCache = new Map(); // code -> { uses, inviterId }
let inviteTracking = true;
let inviteWarned = false;

function data() {
    const { db } = context.get();
    return store(db, 'evasion', { banned: {}, flags: [], nextFlagId: 1, joinInfo: {} });
}

// ---------- avatar perceptual hash (64-bit dHash, hex) ----------
async function dhashFromUrl(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000, maxContentLength: 5 * 1024 * 1024 });
    const px = await sharp(Buffer.from(res.data)).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
}

function hamming(hexA, hexB) {
    if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
    let d = 0;
    for (let i = 0; i < hexA.length; i++) {
        let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
        while (x) { d += x & 1; x >>= 1; }
    }
    return d;
}

// ---------- invite tracking ----------
async function cacheInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        inviteCache.clear();
        invites.forEach((inv) => inviteCache.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id || null }));
        inviteTracking = true;
    } catch (err) {
        inviteTracking = false;
        if (!inviteWarned) { console.warn(`⚠️ Ban evasion: invite tracking unavailable (${err.message}). Needs Manage Server.`); inviteWarned = true; }
    }
}

// Which invite did the newest member use? Best effort: null when unclear.
async function detectInvite(guild) {
    if (!inviteTracking) return null;
    try {
        const invites = await guild.invites.fetch();
        const bumped = [];
        const seen = new Set();
        invites.forEach((inv) => {
            seen.add(inv.code);
            const before = inviteCache.get(inv.code);
            if ((inv.uses ?? 0) > (before?.uses ?? 0)) bumped.push({ code: inv.code, inviterId: inv.inviter?.id || null });
            inviteCache.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id || null });
        });
        for (const code of [...inviteCache.keys()]) if (!seen.has(code)) inviteCache.delete(code);
        return bumped.length === 1 ? bumped[0] : null;
    } catch {
        return null;
    }
}

function rememberJoin(userId, invite) {
    const d = data();
    d.joinInfo[userId] = { c: invite?.code || null, i: invite?.inviterId || null, t: Date.now() };
    const keys = Object.keys(d.joinInfo);
    if (keys.length > JOININFO_CAP + 100) for (const k of keys.slice(0, keys.length - JOININFO_CAP)) delete d.joinInfo[k];
    context.get().saveLater?.();
}

// ---------- scoring ----------
function userNames(user, member) {
    return [...new Set([user.username, user.globalName, member?.nickname].filter(Boolean).map((n) => ({ raw: n, folded: fold(n) })).filter((n) => n.folded).map((n) => JSON.stringify(n)))].map((s) => JSON.parse(s));
}

function scoreCandidate({ user, member, invite, dhash, createdTimestamp }, banned, cfg) {
    let total = 0;
    const reasons = [];

    if (cfg.checkUsername) {
        let best = 0; let why = '';
        for (const n of userNames(user, member)) {
            for (const b of banned.names || []) {
                if (!b.folded) continue;
                let pts = 0;
                if (n.folded === b.folded) pts = n.folded.length >= 4 ? 60 : 15;
                else if (Math.min(n.folded.length, b.folded.length) >= 4) {
                    const sim = similarity(n.folded, b.folded);
                    pts = sim >= 0.9 ? 40 : sim >= 0.8 ? 25 : 0;
                }
                if (pts > best) { best = pts; why = `Name "${truncate(n.raw, 40)}" ${pts >= 60 ? 'matches' : 'resembles'} banned user "${truncate(b.raw, 40)}"`; }
            }
        }
        if (best) { total += best; reasons.push(`${why} (+${best})`); }
    }

    if (cfg.checkAvatar && user.avatar && banned.avatar) {
        if (user.avatar === banned.avatar) { total += 50; reasons.push('Same avatar file as the banned user (+50)'); }
        else if (dhash && banned.dhash) {
            const dist = hamming(dhash, banned.dhash);
            if (dist <= 5) { total += 40; reasons.push(`Near-identical avatar image (difference ${dist}/64) (+40)`); }
            else if (dist <= 10) { total += 20; reasons.push(`Visually similar avatar (difference ${dist}/64) (+20)`); }
        }
    }

    if (cfg.checkInvite && invite) {
        if (invite.inviterId && invite.inviterId === banned.id) { total += 30; reasons.push('Invited by the banned user (+30)'); }
        else if (invite.code && banned.invite?.c && invite.code === banned.invite.c) { total += 10; reasons.push(`Used the same invite (\`${invite.code}\`) as the banned user (+10)`); }
    }

    if (cfg.checkTiming && banned.bannedAt && createdTimestamp > banned.bannedAt) {
        const days = (createdTimestamp - banned.bannedAt) / 86400000;
        if (days <= cfg.timingWindowDays) { total += 15; reasons.push(`Account created ${days < 1 ? 'less than a day' : `${Math.floor(days)}d`} after the ban (+15)`); }
    }

    return { score: Math.min(100, total), reasons };
}

// Best match across every banned record.
function scoreAgainstAll(subject, cfg) {
    const d = data();
    let best = { score: 0, reasons: [], banned: null };
    for (const banned of Object.values(d.banned)) {
        if (banned.id === subject.user.id) continue;
        const r = scoreCandidate(subject, banned, cfg);
        if (r.score > best.score) best = { ...r, banned };
    }
    return best;
}

// ---------- recording bans ----------
async function recordBan(user, reason) {
    const d = data();
    if (!user) return;
    const names = [user.username, user.globalName].filter(Boolean).map((raw) => ({ raw, folded: fold(raw) })).filter((n) => n.folded);
    const rec = {
        id: user.id,
        tag: user.tag,
        names,
        avatar: user.avatar || null,
        avatarUrl: user.avatar ? user.displayAvatarURL({ extension: 'png', size: 128 }) : null,
        dhash: user.avatar ? null : '',
        bannedAt: Date.now(),
        reason: truncate(reason || '', 200),
        invite: d.joinInfo[user.id] || null,
    };
    d.banned[user.id] = rec;
    const ids = Object.keys(d.banned);
    if (ids.length > BANNED_CAP) {
        ids.sort((a, b) => (d.banned[a].bannedAt || 0) - (d.banned[b].bannedAt || 0));
        for (const id of ids.slice(0, ids.length - BANNED_CAP)) delete d.banned[id];
    }
    context.get().saveLater?.();
    fillDhash(rec).catch(() => { });
}

async function fillDhash(rec) {
    if (rec.dhash !== null || !rec.avatarUrl) return;
    try { rec.dhash = await dhashFromUrl(rec.avatarUrl); } catch { rec.dhash = ''; }
}

function forgetBan(userId) {
    const d = data();
    if (d.banned[userId]) { delete d.banned[userId]; context.get().saveLater?.(); }
}

async function backfillBans(guild) {
    const d = data();
    try {
        let after;
        let added = 0;
        for (let page = 0; page < 10; page++) {
            const bans = await guild.bans.fetch({ limit: 1000, after });
            if (!bans.size) break;
            bans.forEach((ban) => {
                if (!d.banned[ban.user.id]) {
                    const u = ban.user;
                    d.banned[u.id] = {
                        id: u.id, tag: u.tag,
                        names: [u.username, u.globalName].filter(Boolean).map((raw) => ({ raw, folded: fold(raw) })).filter((n) => n.folded),
                        avatar: u.avatar || null,
                        avatarUrl: u.avatar ? u.displayAvatarURL({ extension: 'png', size: 128 }) : null,
                        dhash: u.avatar ? null : '',
                        bannedAt: null, // unknown for bans made before tracking started
                        reason: truncate(ban.reason || '', 200),
                        invite: d.joinInfo[u.id] || null,
                    };
                    added++;
                }
            });
            if (bans.size < 1000) break;
            after = bans.last().user.id;
        }
        if (added) { console.log(`🕵️ Ban evasion: loaded ${added} existing bans.`); context.get().saveLater?.(); }
    } catch (err) {
        console.warn(`⚠️ Ban evasion: couldn't read the ban list (${err.message}). Needs Ban Members.`);
    }
}

// Scheduler hook: compute a couple of missing avatar hashes per tick.
async function tick() {
    const d = data();
    let n = 0;
    for (const rec of Object.values(d.banned)) {
        if (rec.dhash === null && rec.avatarUrl) {
            await fillDhash(rec);
            if (++n >= 2) break;
        }
    }
}

// ---------- join handling ----------
function flagButtons(flagId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ev:d:${flagId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`ev:k:${flagId}`).setLabel('Kick').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`ev:b:${flagId}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
}

function flagEmbed(flag, member, { statusLine } = {}) {
    return brandEmbed({
        title: '🕵️ Possible ban evasion',
        color: flag.score >= 85 ? 0xFF0000 : 0xFF9900,
        description: `**${flag.tag}** (<@${flag.userId}>) scored **${flag.score}/100** against banned user **${flag.matchTag}** (\`${flag.matchId}\`).`,
        fields: [
            { name: 'Why', value: flag.reasons.map((r) => `• ${r}`).join('\n') },
            { name: 'Account created', value: member?.user ? ts(member.user.createdTimestamp, 'R') : 'Unknown', inline: true },
            { name: 'Flag', value: `#${flag.id}`, inline: true },
            ...(statusLine ? [{ name: 'Status', value: statusLine }] : []),
        ],
    });
}

async function onJoin(member) {
    const { db } = context.get();
    const cfg = getConfig(db, 'evasion');
    if (!cfg.enabled || member.user.bot) return;
    const guild = member.guild;
    if (guild.id !== actions.getGuild()?.id) return;

    const invite = cfg.checkInvite ? await detectInvite(guild) : null;
    rememberJoin(member.id, invite);

    const d = data();
    if (!Object.keys(d.banned).length) return;

    let dhash = null;
    if (cfg.checkAvatar && member.user.avatar) {
        try { dhash = await dhashFromUrl(member.user.displayAvatarURL({ extension: 'png', size: 128 })); } catch { /* best effort */ }
    }

    const res = scoreAgainstAll({ user: member.user, member, invite, dhash, createdTimestamp: member.user.createdTimestamp }, cfg);
    if (res.score < cfg.flagScore) return;

    const flag = {
        id: d.nextFlagId++,
        userId: member.id,
        tag: member.user.tag,
        score: res.score,
        reasons: res.reasons,
        matchId: res.banned.id,
        matchTag: res.banned.tag,
        createdAt: Date.now(),
        status: 'open',
        handledBy: null,
        action: null,
    };
    d.flags.unshift(flag);
    if (d.flags.length > FLAG_CAP) d.flags.length = FLAG_CAP;
    recordEvent(db, 'evasion', `Flagged ${flag.tag} (${flag.score}/100) as a possible alt of ${flag.matchTag}`, { userId: member.id });
    context.bus.emit('evasion:flag', flag);

    let statusLine;
    if (cfg.autoAction !== 'flag' && res.score >= cfg.autoActionScore) {
        const r = await actions.applyAction({
            guild, userId: member.id, member, action: cfg.autoAction,
            timeoutMs: cfg.timeoutMinutes * 60000,
            reason: `Possible ban evasion (score ${res.score}, matches ${res.banned.tag})`,
            caseType: cfg.autoAction === 'ban' ? '🔨 EVASION BAN' : cfg.autoAction === 'kick' ? '👢 EVASION KICK' : '🔇 EVASION MUTE',
            moderator: 'Ban Evasion Guard',
        });
        if (r.ok) { flag.status = 'actioned'; flag.action = cfg.autoAction; flag.handledBy = 'automatic'; statusLine = `Automatically ${r.outcome}.`; }
        else statusLine = `Automatic ${cfg.autoAction} failed: ${r.error}`;
    }

    const msg = await actions.notify(guild, cfg.flagChannel, {
        embed: flagEmbed(flag, member, { statusLine }),
        pingRoleId: cfg.pingRole,
        components: flag.status === 'open' ? [flagButtons(flag.id)] : [],
    });
    void msg;
    await context.get().safeSave();
}

// Buttons: ev:d:<id> dismiss, ev:k:<id> kick, ev:b:<id> ban
async function handleButton(interaction) {
    const [, kind, idStr] = interaction.customId.split(':');
    const flagId = parseInt(idStr, 10);
    const d = data();
    const flag = d.flags.find((f) => f.id === flagId);
    const eph = { flags: MessageFlags.Ephemeral };
    if (!flag) return interaction.reply({ content: '❌ That flag no longer exists.', ...eph });
    if (flag.status !== 'open') return interaction.reply({ content: `ℹ️ Already handled (${flag.status}${flag.handledBy ? ` by ${flag.handledBy}` : ''}).`, ...eph });
    const isBan = kind === 'b';
    const allowed = isBan ? actions.memberIsAdmin(interaction.member) : actions.memberIsMod(interaction.member);
    if (!allowed) return interaction.reply({ content: `❌ You need **${isBan ? 'Admin+' : 'Moderator+'}** for that.`, ...eph });

    const guild = interaction.guild;
    let statusLine;
    if (kind === 'd') {
        flag.status = 'dismissed'; flag.handledBy = interaction.user.tag;
        statusLine = `Dismissed by ${interaction.user.tag}.`;
    } else {
        const action = isBan ? 'ban' : 'kick';
        const r = await actions.applyAction({
            guild, userId: flag.userId, action,
            reason: `Ban evasion (flag #${flag.id}, score ${flag.score}) — by ${interaction.user.tag}`,
            caseType: isBan ? '🔨 EVASION BAN' : '👢 EVASION KICK',
            moderator: interaction.user.tag,
        });
        if (!r.ok) return interaction.reply({ content: `❌ Couldn't ${action}: ${r.error}`, ...eph });
        flag.status = 'actioned'; flag.action = action; flag.handledBy = interaction.user.tag;
        statusLine = `${action === 'ban' ? 'Banned' : 'Kicked'} by ${interaction.user.tag}.`;
    }
    await context.get().safeSave();
    const member = guild.members.cache.get(flag.userId) || null;
    return interaction.update({ embeds: [flagEmbed(flag, member, { statusLine })], components: [flagButtons(flag.id, true)] });
}

// ---------- services (slash command AND dashboard) ----------
async function checkUser(guild, userId) {
    const { db, client } = context.get();
    const cfg = getConfig(db, 'evasion');
    const d = data();
    const target = await client.users.fetch(userId).catch(() => null);
    if (!target) return { ranked: [], tracked: Object.keys(d.banned).length, target: { tag: userId } };
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    let dhash = null;
    if (target.avatar) { try { dhash = await dhashFromUrl(target.displayAvatarURL({ extension: 'png', size: 128 })); } catch { /* best effort */ } }
    const ji = d.joinInfo[userId];
    const subject = { user: target, member, invite: ji ? { code: ji.c, inviterId: ji.i } : null, dhash, createdTimestamp: target.createdTimestamp };
    const ranked = Object.values(d.banned)
        .filter((b) => b.id !== userId)
        .map((b) => ({ b, ...scoreCandidate(subject, b, { ...cfg, checkInvite: true }) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    return { ranked, tracked: Object.keys(d.banned).length, target };
}

async function syncAll(guild) {
    const d = data();
    const before = Object.keys(d.banned).length;
    await backfillBans(guild);
    await cacheInvites(guild);
    const total = Object.keys(d.banned).length;
    return { total, added: total - before, inviteTracking };
}

// ---------- slash command ----------
const commands = {
    async evasion({ interaction, options, guild, isMod, isAtLeastAdmin, user: invoker }) {
        const { db } = context.get();
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        const d = data();
        const cfg = getConfig(db, 'evasion');
        const sub = options.getSubcommand();

        if (sub === 'check') {
            const target = options.getUser('user');
            const r = await checkUser(guild, target.id);
            const body = r.ranked.length
                ? r.ranked.map((x) => `**${x.score}/100** vs **${x.b.tag}** (\`${x.b.id}\`)\n${x.reasons.map((y) => `• ${y}`).join('\n')}`).join('\n\n')
                : `No similarities found against ${r.tracked} tracked bans.`;
            return interaction.editReply({ embeds: [brandEmbed({ title: `🕵️ Evasion check — ${r.target.tag}`, description: body, footer: `Flag threshold: ${cfg.flagScore}${cfg.enabled ? '' : ' • feature is disabled'}` })] });
        }

        if (sub === 'flags') {
            const status = options.getString('status') || 'open';
            const list = d.flags.filter((f) => status === 'all' || f.status === status).slice(0, 10);
            if (!list.length) return interaction.editReply(`ℹ️ No ${status === 'all' ? '' : status + ' '}flags.`);
            const lines = list.map((f) => `**#${f.id}** ${ts(f.createdAt)} — <@${f.userId}> (${f.tag}) **${f.score}/100** vs ${f.matchTag} — *${f.status}${f.action ? ` (${f.action})` : ''}*`);
            return interaction.editReply({ embeds: [brandEmbed({ title: `🕵️ Evasion flags (${status})`, description: lines.join('\n') })] });
        }

        if (sub === 'dismiss') {
            const id = options.getInteger('id');
            const flag = d.flags.find((f) => f.id === id);
            if (!flag) return interaction.editReply('❌ No flag with that ID.');
            if (flag.status !== 'open') return interaction.editReply(`ℹ️ Flag #${id} is already ${flag.status}.`);
            flag.status = 'dismissed'; flag.handledBy = invoker.tag;
            await context.get().safeSave();
            return interaction.editReply(`✅ Flag #${id} dismissed.`);
        }

        if (sub === 'sync') {
            if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
            const r = await syncAll(guild);
            return interaction.editReply(`✅ Synced. Tracking **${r.total}** bans (${r.added} new). Invite tracking: ${r.inviteTracking ? 'working' : 'unavailable (needs Manage Server)'}.`);
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'evasion',
        description: 'Ban-evasion flags',
        options: [
            { name: 'check', description: 'Compare a user against everyone we have banned', type: 1, options: [{ name: 'user', description: 'User to check', type: 6, required: true }] },
            { name: 'flags', description: 'List recent flags', type: 1, options: [{ name: 'status', description: 'Which flags (default: open)', type: 3, required: false, choices: [{ name: 'open', value: 'open' }, { name: 'dismissed', value: 'dismissed' }, { name: 'actioned', value: 'actioned' }, { name: 'all', value: 'all' }] }] },
            { name: 'dismiss', description: 'Dismiss a flag', type: 1, options: [{ name: 'id', description: 'Flag number', type: 4, required: true, min_value: 1 }] },
            { name: 'sync', description: 'Re-read the server ban list and invites (Admin+)', type: 1 },
        ],
    },
];

module.exports = {
    checkUser, syncAll, onJoin, recordBan, forgetBan, backfillBans, cacheInvites, tick, handleButton,
    cacheInvite: (inv) => inviteCache.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id || null }),
    dropInvite: (code) => inviteCache.delete(code),
    data, commands, definitions,
    _internals: { scoreCandidate, hamming, dhashFromUrl, scoreAgainstAll },
};
