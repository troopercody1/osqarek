// Security: staff-login lockout, Discord OTP unlock, support-team tools and anti-abuse.
//
//  1. ACCOUNT LOCKOUT
//     3 failed dashboard logins (staff accounts in db.adminUsers) lock the account. The account owner
//     gets a DM (via the Discord ID saved on the account). A locked account stays locked until the
//     bot support team unlocks it (/security unlock) or the owner unlocks it with a Discord OTP.
//
//  2. OTP UNLOCK
//     /auth/unlock on the website -> enter username -> a 6-digit code is DM'd to the account's Discord
//     -> enter it -> account unlocked (you still have to log in with your password afterwards).
//     Codes are stored hashed, expire after 10 min, allow 5 tries, 60s resend cooldown, 3 sends/hour.
//     Turn it off with SECURITY_OTP_UNLOCK=false (then only the support team can unlock).
//
//  3. ANTI-ABUSE
//     - Per-IP rate limits on the website (login/unlock, form posts, everything else). Repeated
//       breaches escalate into temporary IP blocks (15m -> 1h -> 24h) that survive restarts.
//     - Repeated failed staff logins from one IP block that IP.
//     - Discord slash-command spam gets a short, escalating cooldown.
//
// Who is the "bot support team"? The Bot Owner (botowner.js) plus every Discord ID in
//   SECURITY_SUPPORT_IDS=id1,id2,id3       (optional, comma separated)
// Optional env:
//   SECURITY_IP_ALLOWLIST=1.2.3.4,5.6.7.8  IPs that are never rate limited or blocked
//   SECURITY_MAX_FAILED_LOGINS=3           failed attempts before a lock
//   SECURITY_FAIL_WINDOW_HOURS=24          failed attempts older than this are forgotten
//   SECURITY_RATE_GENERAL / _POST / _AUTH  requests per window (see LIMITS below)
const crypto = require('crypto');
const context = require('./context');
const { store, recordEvent, formatDuration, ts, truncate, brandEmbed } = require('./util');
const { isBotOwner, BOT_OWNER_ID } = require('../botowner');

// ---------- config ----------
const num = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
const list = (name) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_FAILED = Math.floor(num('SECURITY_MAX_FAILED_LOGINS', 3));
const FAIL_WINDOW_MS = num('SECURITY_FAIL_WINDOW_HOURS', 24) * 3600000;
const OTP_ENABLED = String(process.env.SECURITY_OTP_UNLOCK || 'true').toLowerCase() !== 'false';
const OTP_TTL_MS = 10 * 60000;
const OTP_MAX_TRIES = 5;
const OTP_RESEND_MS = 60000;
const OTP_MAX_SENDS_PER_HOUR = 3;

// Website rate limits (per IP, sliding window).
const LIMITS = {
    auth: { windowMs: 10 * 60000, max: Math.floor(num('SECURITY_RATE_AUTH', 12)) },     // POST /auth/verify-admin, /auth/unlock/*
    post: { windowMs: 60000, max: Math.floor(num('SECURITY_RATE_POST', 40)) },          // every other POST/PUT/PATCH/DELETE
    general: { windowMs: 60000, max: Math.floor(num('SECURITY_RATE_GENERAL', 600)) },   // GET/HEAD
};
// Strikes (rate-limit breaches) -> block length. Strikes are forgotten after 24h.
const BLOCK_STEPS = [{ strikes: 3, ms: 15 * 60000 }, { strikes: 5, ms: 3600000 }, { strikes: 8, ms: 24 * 3600000 }];
const STRIKE_DECAY_MS = 24 * 3600000;
const LOGIN_FAILS_PER_IP = { windowMs: 15 * 60000, max: 8, blockMs: 3600000 };

// Discord slash-command spam: 8 commands in 15s -> cooldown 1m, then 5m, then 30m.
const CMD_WINDOW_MS = 15000;
const CMD_MAX = 8;
const CMD_COOLDOWNS = [60000, 5 * 60000, 30 * 60000];
const CMD_STRIKE_DECAY_MS = 3600000;

const LOCKED_MESSAGE = 'This account is locked. Contact the bot support team, or unlock it with a code sent to your Discord.';

// ---------- helpers ----------
const ctxOrNull = () => (context.ready() ? context.get() : null);
const now = () => Date.now();

function normIp(ip) {
    let s = String(ip || '').trim();
    if (s.startsWith('::ffff:')) s = s.slice(7);
    return s;
}
function maskIp(ip) {
    const s = normIp(ip);
    if (!s || s === 'unknown') return 'unknown';
    if (s.includes('.')) { const p = s.split('.'); return `${p[0]}.${p[1]}.*.*`; }
    return s.split(':').slice(0, 2).join(':') + ':*';
}
const allowlist = () => new Set(list('SECURITY_IP_ALLOWLIST').map(normIp));
const supportIds = () => new Set([BOT_OWNER_ID, ...list('SECURITY_SUPPORT_IDS')]);
const isSupportTeam = (userId) => isBotOwner(userId) || supportIds().has(String(userId));

function sec(account) {
    if (!account.security || typeof account.security !== 'object') account.security = {};
    const s = account.security;
    if (typeof s.failed !== 'number') s.failed = 0;
    if (typeof s.locked !== 'boolean') s.locked = false;
    return s;
}
const findAccount = (username) => {
    const c = ctxOrNull();
    if (!c?.getAdminUsers) return null;
    const u = String(username || '').trim();
    if (!u) return null;
    return c.getAdminUsers().find((a) => a.username === u) || null;
};
const persist = async () => { const c = ctxOrNull(); if (c) await c.safeSave(); };

async function dmUser(discordId, payload) {
    const c = ctxOrNull();
    if (!c || !discordId) return false;
    try {
        const user = await c.client.users.fetch(String(discordId));
        await user.send(payload);
        return true;
    } catch (err) {
        console.error(`⚠️ [security] Could not DM ${discordId}:`, err.message);
        return false;
    }
}
async function notifySupport(payload) {
    for (const id of supportIds()) await dmUser(id, payload);
}
function logToModLog(title, description, color) {
    const c = ctxOrNull();
    if (!c) return;
    try {
        const guild = c.client.guilds.cache.get(c.GUILD_ID) || c.client.guilds.cache.first();
        if (guild && c.logAction) c.logAction(guild, title, description, color);
    } catch (err) { console.error('⚠️ [security] mod log failed:', err.message); }
}
function event(text) {
    const c = ctxOrNull();
    if (c) { try { recordEvent(c.db, 'security', text); } catch { /* ignore */ } }
}

// ---------- IP blocks (persisted) + rate limiting (in memory) ----------
const hits = new Map();        // `${bucket}:${ip}` -> [timestamps]
const strikes = new Map();     // ip -> { n, last }
const strikeCooldown = new Map(); // `${bucket}:${ip}` -> last strike ts (one strike per window)
const loginFails = new Map();  // ip -> [timestamps]
const memBlocks = new Map();   // ip -> { until, reason } (used until the db is available)

function blockStore() {
    const c = ctxOrNull();
    return c ? store(c.db, 'security', { ipBlocks: {} }).ipBlocks : null;
}
function getBlock(ip) {
    const t = now();
    const mem = memBlocks.get(ip);
    if (mem) { if (mem.until > t) return mem; memBlocks.delete(ip); }
    const b = blockStore()?.[ip];
    if (b) { if (b.until > t) return b; delete blockStore()[ip]; }
    return null;
}
function blockIp(ip, ms, reason) {
    if (!ip || ip === 'unknown' || allowlist().has(ip)) return;
    const entry = { until: now() + ms, reason: truncate(reason, 120), at: now() };
    memBlocks.set(ip, entry);
    const bs = blockStore();
    if (bs) { bs[ip] = entry; const c = ctxOrNull(); c?.saveLater?.(); }
    event(`IP ${maskIp(ip)} blocked for ${formatDuration(ms)}: ${reason}`);
    console.warn(`🛡️ [security] Blocked ${ip} for ${formatDuration(ms)}: ${reason}`);
}
function addStrike(ip, reason) {
    const t = now();
    const s = strikes.get(ip) || { n: 0, last: 0 };
    if (t - s.last > STRIKE_DECAY_MS) s.n = 0;
    s.n += 1; s.last = t;
    strikes.set(ip, s);
    let ms = 0;
    for (const step of BLOCK_STEPS) if (s.n >= step.strikes) ms = step.ms;
    if (ms) blockIp(ip, ms, `${reason} (${s.n} strikes)`);
}
function hit(key, windowMs) {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length;
}
function bucketFor(req) {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'general';
    if (req.path === '/auth/verify-admin' || req.path.startsWith('/auth/unlock')) return 'auth';
    return 'post';
}
function tooMany(req, res, seconds, message) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(seconds))));
    const wantsJson = req.is?.('application/json') || (req.get?.('accept') || '').includes('application/json');
    if (wantsJson) return res.status(429).json({ error: message });
    return res.status(429).type('text/plain').send(message);
}

// Express middleware. Register it first thing in index.js (right after trust proxy is set).
function middleware(req, res, next) {
    const ip = normIp(req.ip);
    if (!ip || ip === 'unknown' || allowlist().has(ip)) return next();

    const block = getBlock(ip);
    if (block) return tooMany(req, res, (block.until - now()) / 1000, `Too many requests. You are temporarily blocked (${formatDuration(block.until - now())} left).`);

    const bucket = bucketFor(req);
    const { windowMs, max } = LIMITS[bucket];
    const key = `${bucket}:${ip}`;
    if (hit(key, windowMs) > max) {
        const t = now();
        if (t - (strikeCooldown.get(key) || 0) > windowMs) { // one strike per window, not one per request
            strikeCooldown.set(key, t);
            addStrike(ip, `Rate limit exceeded (${bucket})`);
        }
        return tooMany(req, res, windowMs / 1000, 'Too many requests. Slow down and try again shortly.');
    }
    next();
}

// ---------- Discord command spam ----------
const cmdHits = new Map();   // userId -> [timestamps]
const cmdState = new Map();  // userId -> { strikes, last, until, notified }

// Returns true when the interaction was refused (the caller must stop).
function checkInteraction(interaction) {
    if (!interaction?.isChatInputCommand?.()) return false;
    const userId = interaction.user?.id;
    if (!userId || isSupportTeam(userId)) return false;

    const t = now();
    const st = cmdState.get(userId) || { strikes: 0, last: 0, until: 0, notified: 0 };
    const refuse = (msg) => {
        if (t - st.notified > 5000) { // don't answer every single spam click
            st.notified = t;
            interaction.reply({ content: msg, flags: 64 }).catch(() => { });
        }
        cmdState.set(userId, st);
        return true;
    };

    if (st.until > t) return refuse(`⏳ Slow down — you can use commands again <t:${Math.ceil(st.until / 1000)}:R>.`);

    const arr = (cmdHits.get(userId) || []).filter((x) => t - x < CMD_WINDOW_MS);
    arr.push(t);
    cmdHits.set(userId, arr);
    if (arr.length <= CMD_MAX) return false;

    if (t - st.last > CMD_STRIKE_DECAY_MS) st.strikes = 0;
    st.strikes += 1; st.last = t;
    st.until = t + CMD_COOLDOWNS[Math.min(st.strikes, CMD_COOLDOWNS.length) - 1];
    cmdHits.set(userId, []);
    event(`Command spam from ${interaction.user.tag || userId} (${userId}); cooldown ${formatDuration(st.until - t)} (strike ${st.strikes}).`);
    return refuse(`⏳ You're sending commands too fast. Cooldown until <t:${Math.ceil(st.until / 1000)}:R>.`);
}

// ---------- login lockout ----------
// Called before the password is checked. Returns an error string if the login must be refused.
function preLogin(req, account) {
    if (account && sec(account).locked) return LOCKED_MESSAGE;
    return null;
}

async function lockAccount(account, { reason, by = 'System', ip } = {}) {
    const s = sec(account);
    s.locked = true;
    s.lockedAt = now();
    s.lockedReason = truncate(reason || 'Locked', 200);
    s.lockedBy = by;
    s.lockedIp = ip ? maskIp(ip) : null;
    s.failed = 0;
    s.otp = null;
    event(`Staff login "${account.username}" locked (${s.lockedReason}).`);
    logToModLog('🔒 Staff Account Locked', `Dashboard login **${account.username}** (${account.rank}) was locked.\n**Reason:** ${s.lockedReason}\n**Source IP:** ${s.lockedIp || 'n/a'}`, 0xED4245);
    await persist();

    const c = ctxOrNull();
    const unlockUrl = `${c?.baseUrl || ''}/auth/unlock`;
    const embed = brandEmbed({
        title: '🔒 Your dashboard account was locked',
        description: `The staff login **${account.username}** was locked: ${s.lockedReason}.\n\n` +
            `It stays locked until the **bot support team** unlocks it` +
            (OTP_ENABLED ? `, or you can unlock it yourself with a one-time code sent to this DM: ${unlockUrl}` : '.') +
            `\n\n**If this wasn't you**, tell the support team and change your password right after you get back in.`,
        color: 0xED4245,
        fields: [
            { name: 'Time', value: ts(s.lockedAt, 'F'), inline: true },
            { name: 'Source IP', value: s.lockedIp || 'unknown', inline: true },
        ],
    });
    const delivered = await dmUser(account.discordId, { embeds: [embed] });
    if (!delivered) {
        await notifySupport({ embeds: [brandEmbed({
            title: '⚠️ Locked account, owner could not be DM\'d',
            description: `Staff login **${account.username}** was locked (${s.lockedReason}) but ${account.discordId ? 'its owner has DMs closed' : 'it has no Discord ID saved'}. Use \`/security unlock username:${account.username}\` once you've verified them.`,
            color: 0xFEE75C,
        })] });
    }
    return delivered;
}

async function unlockAccount(account, { by, method }) {
    const s = sec(account);
    s.locked = false;
    s.failed = 0;
    s.otp = null;
    s.unlockedAt = now();
    s.unlockedBy = by;
    event(`Staff login "${account.username}" unlocked by ${by} (${method}).`);
    logToModLog('🔓 Staff Account Unlocked', `Dashboard login **${account.username}** was unlocked by ${by} (${method}).`, 0x57F287);
    await persist();
    await dmUser(account.discordId, { embeds: [brandEmbed({
        title: '🔓 Your dashboard account was unlocked',
        description: `The staff login **${account.username}** was unlocked (${method}). You can log in again.\nIf you didn't ask for this, contact the bot support team.`,
        color: 0x57F287,
    })] });
}

// Called after every failed password check. Returns the message to show on the login page.
async function onLoginFailure(req, username, account) {
    const ip = normIp(req.ip);
    const generic = 'Invalid Username or Password'; // same text whether or not the username exists

    // Too many failures from one IP (any username) -> block the IP.
    if (ip && ip !== 'unknown') {
        const t = now();
        const arr = (loginFails.get(ip) || []).filter((x) => t - x < LOGIN_FAILS_PER_IP.windowMs);
        arr.push(t);
        loginFails.set(ip, arr);
        if (arr.length >= LOGIN_FAILS_PER_IP.max) {
            loginFails.delete(ip);
            blockIp(ip, LOGIN_FAILS_PER_IP.blockMs, 'Repeated failed staff logins');
        }
    }
    if (!account) return generic;

    const s = sec(account);
    const t = now();
    if (t - (s.lastFailedAt || 0) > FAIL_WINDOW_MS) s.failed = 0;
    s.failed += 1;
    s.lastFailedAt = t;
    s.lastFailedIp = maskIp(ip);

    if (s.failed >= MAX_FAILED) {
        await lockAccount(account, { reason: `${MAX_FAILED} failed login attempts`, by: 'System', ip });
        return LOCKED_MESSAGE;
    }
    await persist();
    return generic;
}

function onLoginSuccess(req, account) {
    const s = sec(account);
    if (s.failed || s.lastFailedAt) { s.failed = 0; s.lastFailedAt = 0; }
    loginFails.delete(normIp(req.ip));
    const c = ctxOrNull();
    c?.saveLater?.();
}

// ---------- OTP unlock ----------
const otpHash = (accountId, code) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'fallback-secret').update(`${accountId}:${code}`).digest('hex');

// result.ok false + reason: 'disabled' | 'not_locked' | 'no_discord' | 'cooldown' | 'limit' | 'dm_failed'
async function sendUnlockOtp(account, ip) {
    if (!OTP_ENABLED) return { ok: false, reason: 'disabled' };
    const s = sec(account);
    if (!s.locked) return { ok: false, reason: 'not_locked' };
    if (!account.discordId) return { ok: false, reason: 'no_discord' };
    const t = now();
    if (s.otp && t - (s.otp.sentAt || 0) < OTP_RESEND_MS) return { ok: false, reason: 'cooldown' };
    s.otpSends = (s.otpSends || []).filter((x) => t - x < 3600000);
    if (s.otpSends.length >= OTP_MAX_SENDS_PER_HOUR) return { ok: false, reason: 'limit' };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    s.otp = { hash: otpHash(account.id, code), exp: t + OTP_TTL_MS, tries: 0, sentAt: t };
    const delivered = await dmUser(account.discordId, { embeds: [brandEmbed({
        title: '🔑 Account unlock code',
        description: `Someone (IP \`${maskIp(ip)}\`) asked to unlock the dashboard login **${account.username}**.\n\n` +
            `Your code: **\`${code}\`**\nIt expires ${ts(t + OTP_TTL_MS, 'R')} and works once.\n\n` +
            `**If this wasn't you, ignore this message.** Never share this code with anyone, not even the bot support team.`,
        color: 0x5865F2,
    })] });
    if (!delivered) { s.otp = null; await persist(); return { ok: false, reason: 'dm_failed' }; }
    s.otpSends.push(t);
    event(`Unlock code sent for "${account.username}" (IP ${maskIp(ip)}).`);
    await persist();
    return { ok: true };
}

// result.reason: 'invalid' | 'expired' | 'too_many'
async function verifyUnlockOtp(account, code) {
    const s = sec(account);
    const t = now();
    if (!s.locked) return { ok: false, reason: 'expired' };
    if (!s.otp || s.otp.exp < t) { s.otp = null; return { ok: false, reason: 'expired' }; }
    s.otp.tries += 1;
    const expected = Buffer.from(s.otp.hash, 'hex');
    const actual = Buffer.from(otpHash(account.id, String(code)), 'hex');
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (match) {
        await unlockAccount(account, { by: 'the account owner', method: 'Discord one-time code' });
        return { ok: true };
    }
    if (s.otp.tries >= OTP_MAX_TRIES) { s.otp = null; await persist(); return { ok: false, reason: 'too_many' }; }
    await persist();
    return { ok: false, reason: 'invalid' };
}

// ---------- website routes (/auth/unlock) ----------
function register(ctx) {
    const { app } = ctx;
    const page = (res, data) => res.render('unlock', { stage: 'request', error: null, msg: null, otpEnabled: OTP_ENABLED, ...data });

    app.get('/auth/unlock', (req, res) => {
        if (req.session) delete req.session.unlockFor;
        page(res, {});
    });

    // Step 1: username -> DM a code. The answer never reveals whether the account exists / is locked.
    app.post('/auth/unlock/request', async (req, res) => {
        if (!OTP_ENABLED) return page(res, { error: 'Unlocking with a Discord code is turned off. Please contact the bot support team.' });
        const username = String(req.body.username || '').trim().slice(0, 64);
        const account = findAccount(username);
        req.session.unlockFor = null;
        if (account && sec(account).locked && account.discordId) {
            req.session.unlockFor = account.id;
            try { await sendUnlockOtp(account, req.ip); } catch (err) { console.error('❌ [security] OTP send failed:', err.message); }
        }
        page(res, { stage: 'verify', msg: 'If that account is locked and linked to a Discord account, a 6-digit code was just sent to its DMs (make sure your DMs are open). It expires in 10 minutes.' });
    });

    // Step 2: code -> unlock.
    app.post('/auth/unlock/verify', async (req, res) => {
        const code = String(req.body.code || '').replace(/\s+/g, '');
        const fail = (error) => page(res, { stage: 'verify', error });
        const accountId = req.session?.unlockFor;
        const account = accountId ? (ctx.getAdminUsers().find((a) => a.id === accountId) || null) : null;
        if (!account || !/^\d{6}$/.test(code)) {
            addStrikeSoft(normIp(req.ip));
            return fail('Invalid or expired code.');
        }
        let result;
        try { result = await verifyUnlockOtp(account, code); } catch (err) { console.error('❌ [security] OTP verify failed:', err.message); return fail('Something went wrong. Please try again.'); }
        if (result.ok) {
            delete req.session.unlockFor;
            return res.redirect('/auth/admin?msg=' + encodeURIComponent('Account unlocked. You can log in now.'));
        }
        addStrikeSoft(normIp(req.ip));
        if (result.reason === 'too_many') { delete req.session.unlockFor; return page(res, { error: 'Too many wrong codes. Request a new code to try again.' }); }
        return fail('Invalid or expired code.');
    });
}
// A wrong OTP counts as a failed login for the IP (so guessing codes also gets the IP blocked).
function addStrikeSoft(ip) {
    if (!ip || ip === 'unknown') return;
    const t = now();
    const arr = (loginFails.get(ip) || []).filter((x) => t - x < LOGIN_FAILS_PER_IP.windowMs);
    arr.push(t);
    loginFails.set(ip, arr);
    if (arr.length >= LOGIN_FAILS_PER_IP.max) { loginFails.delete(ip); blockIp(ip, LOGIN_FAILS_PER_IP.blockMs, 'Repeated failed unlock codes'); }
}

// ---------- /security (bot support team only) ----------
const maskedDiscord = (a) => (a.discordId ? `<@${a.discordId}>` : '*not linked*');
function describe(a) {
    const s = sec(a);
    return `**${a.username}** (${a.rank}) — ${s.locked ? '🔒 **locked**' : '🔓 active'}\n` +
        `Discord: ${maskedDiscord(a)}\nFailed attempts: ${s.failed}/${MAX_FAILED}` +
        (s.lastFailedAt ? ` (last ${ts(s.lastFailedAt)}, IP ${s.lastFailedIp || 'unknown'})` : '') +
        (s.locked ? `\nLocked ${ts(s.lockedAt)} by ${s.lockedBy || 'System'} — ${s.lockedReason || 'no reason'}` : '') +
        (s.unlockedAt ? `\nLast unlocked ${ts(s.unlockedAt)} by ${s.unlockedBy || 'unknown'}` : '');
}

const commands = {
    async security({ interaction, options, user }) {
        const c = context.get();
        if (!isSupportTeam(user.id)) return interaction.editReply('❌ Only the **bot support team** can use `/security`.');
        const sub = options.getSubcommand();
        const accounts = c.getAdminUsers();
        const byName = (n) => accounts.find((a) => a.username.toLowerCase() === String(n || '').trim().toLowerCase());

        if (sub === 'locked') {
            const locked = accounts.filter((a) => sec(a).locked);
            if (!locked.length) return interaction.editReply('✅ No locked accounts.');
            return interaction.editReply({ embeds: [brandEmbed({ title: `🔒 Locked accounts (${locked.length})`, description: locked.map(describe).join('\n\n'), color: 0xED4245 })] });
        }
        if (sub === 'status') {
            const a = byName(options.getString('username'));
            if (!a) return interaction.editReply('❌ No staff login with that username.');
            return interaction.editReply({ embeds: [brandEmbed({ title: '🛡️ Account security', description: describe(a) })] });
        }
        if (sub === 'unlock') {
            const a = byName(options.getString('username'));
            if (!a) return interaction.editReply('❌ No staff login with that username.');
            if (!sec(a).locked) {
                sec(a).failed = 0;
                await persist();
                return interaction.editReply(`ℹ️ **${a.username}** isn't locked. (Failed-attempt counter reset to 0.)`);
            }
            await unlockAccount(a, { by: `${user.tag} (support)`, method: '/security unlock' });
            return interaction.editReply(`🔓 Unlocked **${a.username}**. ${a.discordId ? 'The owner was DM\'d.' : 'They have no Discord ID saved, so nobody was DM\'d.'}`);
        }
        if (sub === 'lock') {
            const a = byName(options.getString('username'));
            if (!a) return interaction.editReply('❌ No staff login with that username.');
            if (sec(a).locked) return interaction.editReply(`ℹ️ **${a.username}** is already locked.`);
            await lockAccount(a, { reason: options.getString('reason') || 'Locked by the support team', by: `${user.tag} (support)` });
            return interaction.editReply(`🔒 Locked **${a.username}**.`);
        }
        if (sub === 'blocked') {
            const bs = blockStore() || {};
            const rows = Object.entries(bs).filter(([, b]) => b.until > now());
            if (!rows.length) return interaction.editReply('✅ No IPs are blocked right now.');
            return interaction.editReply({ embeds: [brandEmbed({ title: `🚫 Blocked IPs (${rows.length})`, description: truncate(rows.map(([ip, b]) => `\`${ip}\` — ${b.reason} — ends ${ts(b.until)}`).join('\n'), 3800) })] });
        }
        if (sub === 'unblock') {
            const ip = normIp(options.getString('ip'));
            const bs = blockStore() || {};
            const had = !!bs[ip] || memBlocks.has(ip);
            delete bs[ip]; memBlocks.delete(ip); strikes.delete(ip); loginFails.delete(ip);
            for (const k of [...hits.keys()]) if (k.endsWith(`:${ip}`)) hits.delete(k);
            await persist();
            return interaction.editReply(had ? `✅ Unblocked \`${ip}\`.` : `ℹ️ \`${ip}\` wasn't blocked (its strikes and counters were cleared).`);
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const userOpt = { name: 'username', description: 'Dashboard staff username', type: 3, required: true, max_length: 64 };
const definitions = [{
    name: 'security',
    description: 'Locked staff accounts and blocked IPs (bot support team only)',
    options: [
        { name: 'locked', description: 'List locked dashboard accounts', type: 1 },
        { name: 'status', description: 'Security status of one dashboard account', type: 1, options: [userOpt] },
        { name: 'unlock', description: 'Unlock a locked dashboard account', type: 1, options: [userOpt] },
        { name: 'lock', description: 'Lock a dashboard account', type: 1, options: [userOpt, { name: 'reason', description: 'Why', type: 3, required: false, max_length: 200 }] },
        { name: 'blocked', description: 'List blocked IPs', type: 1 },
        { name: 'unblock', description: 'Unblock an IP', type: 1, options: [{ name: 'ip', description: 'IP address', type: 3, required: true, max_length: 64 }] },
    ],
}];

// ---------- housekeeping (called by the shared 10s scheduler) ----------
let lastPrune = 0;
async function tick() {
    const t = now();
    if (t - lastPrune < 60000) return;
    lastPrune = t;
    const longest = Math.max(LIMITS.auth.windowMs, LIMITS.post.windowMs, LIMITS.general.windowMs);
    for (const [k, arr] of hits) { const f = arr.filter((x) => t - x < longest); if (f.length) hits.set(k, f); else hits.delete(k); }
    for (const [k, v] of strikeCooldown) if (t - v > longest) strikeCooldown.delete(k);
    for (const [k, v] of strikes) if (t - v.last > STRIKE_DECAY_MS) strikes.delete(k);
    for (const [k, arr] of loginFails) { const f = arr.filter((x) => t - x < LOGIN_FAILS_PER_IP.windowMs); if (f.length) loginFails.set(k, f); else loginFails.delete(k); }
    for (const [k, arr] of cmdHits) { const f = arr.filter((x) => t - x < CMD_WINDOW_MS); if (f.length) cmdHits.set(k, f); else cmdHits.delete(k); }
    for (const [k, v] of cmdState) if (v.until < t && t - v.last > CMD_STRIKE_DECAY_MS) cmdState.delete(k);
    for (const [k, b] of memBlocks) if (b.until <= t) memBlocks.delete(k);
    const bs = blockStore();
    if (bs) for (const ip of Object.keys(bs)) if (bs[ip].until <= t) delete bs[ip];
    // Hard cap so a distributed flood can't grow memory without bound.
    if (hits.size > 50000) hits.clear();
}

function init(ctx) { register(ctx); }

module.exports = {
    // feature-module shape (features/index.js)
    definitions, commands, tick, init,
    // hooks used by index.js
    middleware, checkInteraction, preLogin, onLoginFailure, onLoginSuccess,
    // exposed for other modules / tests
    lockAccount, unlockAccount, sendUnlockOtp, verifyUnlockOtp, isSupportTeam, LOCKED_MESSAGE,
};
