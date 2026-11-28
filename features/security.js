// Security: staff-login lockout, Discord OTP unlock, support-team tools and anti-abuse.
//
//  1. ACCOUNT LOCKOUT
//     3 failed dashboard logins (staff accounts in db.adminUsers) lock the account. The account owner
//     gets a DM (via the Discord ID saved on the account). A locked account stays locked until the
//     bot support team unlocks it (/security unlock) or the owner unlocks it with a Discord OTP.
//
//  2. OTP UNLOCK
//     /auth/unlock on the website -> enter username -> a 6-digit code is DM'd to the account's Discord
//     -> enter it -> account unlocked. However an account is unlocked (OTP, /security unlock or the
//     dashboard), the staff member must set a NEW password at their next login.
//     Codes are stored hashed, expire after 10 min, 60s resend cooldown, 3 sends/hour. Only 3 wrong
//     codes are allowed: after that code-unlock is disabled for that account and the owner has to
//     contact the bot support team (they unlock it with /security unlock or /settings/security).
//     Turn it off with SECURITY_OTP_UNLOCK=false (then only the support team can unlock).
//
//  3. ANTI-ABUSE
//     - Per-IP rate limits on the website (login/unlock, form posts, everything else). Repeated
//       breaches escalate into temporary IP blocks (15m -> 1h -> 24h) that survive restarts.
//     - Repeated failed staff logins from one IP block that IP.
//     - Discord slash-command spam gets a short, escalating cooldown.
//
//  4. SUPPORT TICKETS (SEC-XXXXXX)
//     The unlock-code screen has a "Contact support" button -> /support/security (a locked staff member
//     describes the problem; no login needed). That opens ticket SEC-XXXXXX and puts the account on a
//     support HOLD: Discord-code unlock is switched off and the account stays suspended until a
//     dashboard owner (or the bot support team) unlocks it. The requester gets a private link (also
//     DM'd to their Discord) to read replies and answer. Owners read, answer, solve, lock and unlock
//     from /settings/security, and can also start a conversation with any staff login.
//
// 5. STAFF IDs
//     The username is public (it is only used to log in). The Staff ID (format 12345-ABCDEF-1234, assigned in
//     index.js when the login is ranked in the dashboard) is PRIVATE and is the recovery secret: it is required
//     to request an unlock code (/auth/unlock) and to open a SEC- request, and on its own it lists a login's
//     SEC- requests ("Find my requests"). It is stored encrypted (+ a hash for checking). Dashboard owners see the full
//     ID in Settings -> Staff Access and on SEC- tickets; the ticket's own user only sees it masked (•••••-••••••-1234)
//     because their private ticket link must never reveal the recovery secret. Owners can reissue an ID.
//     Owners can also delete SEC- requests.
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
const OTP_MAX_TRIES = 3; // wrong codes allowed in total; after that code-unlock is off for the account until support unlocks it
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

const OTP_BLOCKED_MESSAGE = 'Too many wrong codes. Unlocking with a code is disabled for this account — please contact the bot support team.';
const HOLD_MESSAGE = 'Your account is suspended while a support request is open. A dashboard owner has to unlock it. Use the link from your support request (it was also sent to your Discord).';
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
// Staff IDs are stored encrypted + hashed (features/staffid.js). Typed IDs are checked against the hash.
const idTools = () => ctxOrNull()?.staffIdTools || null;
const normStaffId = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '');
const staffIdOk = (account, value) => { const t = idTools(); return !!(t && account && t.matches(account, value)); };
const maskedStaffId = (account) => { const t = idTools(); return t && account ? t.mask(account) : 'not issued'; };
const findByStaffId = (value) => {
    const c = ctxOrNull(); const t = idTools();
    return c?.getAdminUsers && t ? t.findAccount(c.getAdminUsers(), value) : null;
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

const secStore = () => { const c = ctxOrNull(); return c ? store(c.db, 'security', { ipBlocks: {}, tickets: {} }) : null; };
function blockStore() { return secStore()?.ipBlocks || null; }
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
    if (req.path === '/auth/verify-admin' || req.path.startsWith('/auth/unlock') || req.path.startsWith('/support/security')) return 'auth';
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
    s.otpBlocked = false; // support/OTP unlock re-enables code-unlock
    s.supportHold = null;
    s.otpSends = [];
    // Force a new password: the existing login flow sends any account with passwordChanged !== true to
    // /auth/change-password before it can do anything else (and the new one must differ from the old).
    account.passwordChanged = false;
    // End any session still open on this login (they were issued before the lock).
    account.sessionEpoch = (account.sessionEpoch || 0) + 1;
    s.unlockedAt = now();
    s.unlockedBy = by;
    closeTicketsFor(account, `Account unlocked by ${by}. The login must set a new password next time it signs in.`);
    event(`Staff login "${account.username}" unlocked by ${by} (${method}).`);
    logToModLog('🔓 Staff Account Unlocked', `Dashboard login **${account.username}** was unlocked by ${by} (${method}).`, 0x57F287);
    await persist();
    await dmUser(account.discordId, { embeds: [brandEmbed({
        title: '🔓 Your dashboard account was unlocked',
        description: `The staff login **${account.username}** was unlocked (${method}). You can log in again, but you'll have to **set a new password** first.\nIf you didn't ask for this, contact the bot support team.`,
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

// result.ok false + reason: 'disabled' | 'not_locked' | 'support_hold' | 'otp_blocked' | 'no_discord' | 'cooldown' | 'limit' | 'dm_failed'
async function sendUnlockOtp(account, ip) {
    if (!OTP_ENABLED) return { ok: false, reason: 'disabled' };
    const s = sec(account);
    if (!s.locked) return { ok: false, reason: 'not_locked' };
    if (s.supportHold) return { ok: false, reason: 'support_hold' };
    if (s.otpBlocked) return { ok: false, reason: 'otp_blocked' };
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
    if (s.supportHold) { s.otp = null; return { ok: false, reason: 'support_hold' }; }
    if (!s.otp || s.otp.exp < t) { s.otp = null; return { ok: false, reason: 'expired' }; }
    s.otp.tries += 1;
    const expected = Buffer.from(s.otp.hash, 'hex');
    const actual = Buffer.from(otpHash(account.id, String(code)), 'hex');
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (match) {
        await unlockAccount(account, { by: 'the account owner', method: 'Discord one-time code' });
        return { ok: true };
    }
    if (s.otp.tries >= OTP_MAX_TRIES) {
        s.otp = null;
        s.otpBlocked = true;
        s.otpBlockedAt = t;
        event(`Code-unlock disabled for "${account.username}" after ${OTP_MAX_TRIES} wrong codes.`);
        logToModLog('⚠️ Unlock Codes Exhausted', `Dashboard login **${account.username}** entered ${OTP_MAX_TRIES} wrong unlock codes. Code-unlock is disabled; the support team must unlock it.`, 0xFEE75C);
        await persist();
        await dmUser(account.discordId, { embeds: [brandEmbed({
            title: '⚠️ Unlock code attempts used up',
            description: `${OTP_MAX_TRIES} wrong unlock codes were entered for **${account.username}**. Unlocking with a code is now disabled for this account, so you need to **contact the bot support team** to get it unlocked.\nIf that wasn't you, tell them.`,
            color: 0xFEE75C,
        })] });
        return { ok: false, reason: 'too_many' };
    }
    await persist();
    return { ok: false, reason: 'invalid' };
}


// ---------- support tickets (SEC-XXXXXX) ----------
const TICKET_MSG_MAX = 3000;
const TICKET_MAX_MESSAGES = 60;
const TICKET_KEEP = 300;
const TICKET_REPLY_LIMIT = { windowMs: 10 * 60000, max: 8 };
const ticketReplyHits = new Map();

const tickets = () => secStore()?.tickets || {};
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);
const baseUrl = () => ctxOrNull()?.baseUrl || '';
const memberLink = (t) => `${baseUrl()}/support/security/${t.id}?key=${t.key}`;
const staffLink = (t) => `${baseUrl()}/settings/security/ticket/${t.id}`;
const keyMatches = (t, key) => { const a = Buffer.from(String(t.key || '')); const b = Buffer.from(String(key || '')); return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const ticketsFor = (accountId) => Object.values(tickets()).filter((t) => t.accountId === accountId).sort((a, b) => b.updatedAt - a.updatedAt);
const openTicketFor = (accountId) => ticketsFor(accountId).find((t) => t.status !== 'solved') || null;
const STATUS_LABEL = { open: 'Open', awaiting: 'Awaiting member', solved: 'Solved' };

function newTicketId() {
    const all = tickets();
    let id;
    do { id = 'SEC-' + crypto.randomBytes(3).toString('hex').toUpperCase(); } while (all[id]);
    return id;
}
function pruneTickets() {
    const all = tickets();
    const ids = Object.keys(all);
    if (ids.length <= TICKET_KEEP) return;
    ids.sort((a, b) => (all[a].status === 'solved' ? 0 : 1) - (all[b].status === 'solved' ? 0 : 1) || all[a].updatedAt - all[b].updatedAt);
    for (const id of ids.slice(0, ids.length - TICKET_KEEP)) delete all[id];
}
function createTicket(account, { from, name, body, ip }) {
    const t = now();
    const ticket = {
        id: newTicketId(), accountId: account.id, username: account.username, key: crypto.randomBytes(16).toString('hex'),
        status: from === 'member' ? 'open' : 'awaiting', createdBy: from, createdAt: t, updatedAt: t, ip: maskIp(ip),
        messages: [{ from, name, body, at: t }],
    };
    tickets()[ticket.id] = ticket;
    pruneTickets();
    return ticket;
}
function addTicketMessage(ticket, from, name, body) {
    ticket.messages.push({ from, name, body, at: now() });
    ticket.updatedAt = now();
}
function closeTicketsFor(account, text) {
    for (const t of ticketsFor(account.id)) {
        if (t.status === 'solved') continue;
        addTicketMessage(t, 'event', 'System', text);
        t.status = 'solved';
    }
}
// Dashboard owners with a Discord ID + the bot support team.
async function notifyOwners(payload) {
    const c = ctxOrNull();
    const ids = new Set(supportIds());
    for (const a of (c?.getAdminUsers?.() || [])) if (a.rank === 'owner' && a.discordId) ids.add(String(a.discordId));
    for (const id of ids) await dmUser(id, payload);
}
const ticketEmbed = (title, description, color = 0x5865F2) => ({ embeds: [brandEmbed({ title, description, color })] });

// ---------- website routes (/auth/unlock) ----------
function register(ctx) {
    const { app } = ctx;
    const page = (res, data) => res.render('unlock', { stage: 'request', error: null, msg: null, otpEnabled: OTP_ENABLED, ...data });

    app.get('/auth/unlock', (req, res) => {
        if (req.session) delete req.session.unlockFor;
        page(res, {});
    });

    registerOwnerPage(ctx);
    registerSupportPages(ctx);

    // Step 1: username -> DM a code. The answer never reveals whether the account exists / is locked.
    app.post('/auth/unlock/request', async (req, res) => {
        if (!OTP_ENABLED) return page(res, { error: 'Unlocking with a Discord code is turned off. Please contact the bot support team.' });
        const username = String(req.body.username || '').trim().slice(0, 64);
        const staffId = normStaffId(req.body.staffId).slice(0, 32);
        let account = findAccount(username);
        // The Staff ID is the private secret: without the matching one nothing happens (same answer as an unknown account).
        if (account && !staffIdOk(account, staffId)) { addStrikeSoft(normIp(req.ip)); account = null; }
        req.session.unlockFor = null;
        req.session.unlockUsername = username; // pre-fills the "Contact support" form
        if (account && sec(account).locked && sec(account).supportHold) {
            return page(res, { error: HOLD_MESSAGE });
        }
        if (account && sec(account).locked && sec(account).otpBlocked) {
            return page(res, { error: OTP_BLOCKED_MESSAGE });
        }
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
            return res.redirect('/auth/admin?msg=' + encodeURIComponent('Account unlocked. Log in with your current password, then you will be asked to set a new one.'));
        }
        addStrikeSoft(normIp(req.ip));
        if (result.reason === 'support_hold') { delete req.session.unlockFor; return page(res, { error: HOLD_MESSAGE }); }
        if (result.reason === 'too_many') { delete req.session.unlockFor; return page(res, { error: OTP_BLOCKED_MESSAGE }); }
        return fail('Invalid or expired code.');
    });
}

// ---------- /support/security (public help-center pages for locked staff) ----------
function registerSupportPages(ctx) {
    const { app } = ctx;
    const render = (res, view) => { res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); return res.render('security-support', view); };
    const base = (req) => ({ botName: ctx.client?.user?.username || "OsQarek's Universe", error: null, msg: null, isNew: false, ticket: null, account: null, tickets: [], staffId: '', username: req.session?.unlockUsername || '', body: '', limits: { max: TICKET_MSG_MAX }, STATUS_LABEL });
    const allowed = (req, ticket, key) => {
        if (!ticket) return false;
        if (keyMatches(ticket, key)) { (req.session.secKeys = req.session.secKeys || {})[ticket.id] = ticket.key; return true; }
        return !!req.session?.secKeys && keyMatches(ticket, req.session.secKeys[ticket.id]);
    };
    const accountOf = (ticket) => ctx.getAdminUsers().find((a) => a.id === ticket.accountId) || null;
    const threadView = (req, ticket, extra = {}) => { const account = accountOf(ticket); return { ...base(req), mode: 'thread', ticket, account, staffIdMasked: maskedStaffId(account), locked: account ? sec(account).locked : false, ...extra }; };

    app.get('/support/security', (req, res) => render(res, { ...base(req), mode: 'form' }));

    app.post('/support/security', async (req, res) => {
        const username = cleanText(req.body.username, 64);
        const body = cleanText(req.body.message, TICKET_MSG_MAX);
        const form = (error) => render(res, { ...base(req), mode: 'form', error, username, body });
        if (req.body.website) return form('Something went wrong. Please try again.'); // honeypot
        if (!username) return form('Enter your staff username.');
        if (body.length < 10) return form('Please describe the problem in a bit more detail.');
        const staffId = normStaffId(req.body.staffId).slice(0, 32);
        const account = findAccount(username);
        if (!account || !staffIdOk(account, staffId)) { addStrikeSoft(normIp(req.ip)); return form('The username and Staff ID do not match a staff login.'); }
        if (!sec(account).locked) return form('That login is not locked. This form is only for locked staff logins.');

        const existing = openTicketFor(account.id);
        if (existing) {
            if (req.session.secKeys && keyMatches(existing, req.session.secKeys[existing.id])) return res.redirect(`/support/security/${existing.id}`);
            return form('There is already an open support request for this account. Use the link that was sent to the Discord account linked to this login.');
        }

        const ticket = createTicket(account, { from: 'member', name: account.username, body, ip: req.ip });
        const s = sec(account);
        s.supportHold = ticket.id; // suspended until an owner unlocks it
        s.otp = null;
        (req.session.secKeys = req.session.secKeys || {})[ticket.id] = ticket.key;
        event(`Support request ${ticket.id} opened for locked login "${account.username}"; account on hold.`);
        logToModLog('🆘 Locked-Account Support Request', `**${ticket.id}** for dashboard login **${account.username}**. The account is suspended until an owner unlocks it.\n${staffLink(ticket)}`, 0xFEE75C);
        await persist();

        dmUser(account.discordId, ticketEmbed(`🆘 Support request ${ticket.id} opened`,
            `A support request was opened for the locked dashboard login **${account.username}**.\nYou can find your security requests any time on ${baseUrl()}/support/security with your private Staff ID.\nThe account stays suspended until a dashboard owner unlocks it, and unlocking with a code is switched off meanwhile.\n\n**Read and answer replies (private link, don't share it):**\n${memberLink(ticket)}\n\nIf this wasn't you, tell the support team.`)).catch(() => { });
        notifyOwners(ticketEmbed(`🆘 ${ticket.id}: locked staff login`, `**${account.username}** (${account.rank}) asked for help with a locked account.\n\n> ${truncate(body, 600)}\n\nRead, reply or unlock: ${staffLink(ticket)}`, 0xFEE75C)).catch(() => { });
        res.redirect(`/support/security/${ticket.id}?key=${ticket.key}&new=1`);
    });

    // "Find my requests": a staff member enters their Staff ID to list and open their SEC- requests.
    app.post('/support/security/lookup', (req, res) => {
        const staffId = normStaffId(req.body.staffId).slice(0, 32);
        const fail = (error) => { addStrikeSoft(normIp(req.ip)); return render(res, { ...base(req), mode: 'form', error, staffId }); };
        if (req.body.website) return fail('Something went wrong. Please try again.'); // honeypot
        const account = findByStaffId(staffId);
        if (!account) return fail('No security requests were found for that Staff ID. Check it and try again (format: 12345-ABCDEF-1234).');
        const mine = ticketsFor(account.id);
        if (!mine.length) return render(res, { ...base(req), mode: 'form', error: 'That Staff ID has no security requests yet. Use the form below to open one if your login is locked.', staffId });
        // The Staff ID unlocks every request of this login for this browser session (no private link needed).
        req.session.secKeys = req.session.secKeys || {};
        for (const t of mine) req.session.secKeys[t.id] = t.key;
        render(res, { ...base(req), mode: 'list', account, tickets: mine, staffId: '', staffIdMasked: maskedStaffId(account) });
    });

    app.get('/support/security/:id', (req, res) => {
        const ticket = tickets()[String(req.params.id).toUpperCase()];
        if (!allowed(req, ticket, req.query.key)) return render(res, { ...base(req), mode: 'form', error: 'That request was not found, or the link is incomplete. Use the full link from your Discord DM.' });
        render(res, threadView(req, ticket, { isNew: req.query.new === '1', msg: req.query.sent === '1' ? 'Reply sent.' : null }));
    });

    app.post('/support/security/:id/reply', async (req, res) => {
        const ticket = tickets()[String(req.params.id).toUpperCase()];
        if (!allowed(req, ticket, req.body.key)) return res.redirect('/support/security');
        const fail = (error) => render(res, threadView(req, ticket, { error }));
        const body = cleanText(req.body.body, TICKET_MSG_MAX);
        if (!body) return fail('Write a message first.');
        if (ticket.messages.filter((m) => m.from !== 'event').length >= TICKET_MAX_MESSAGES) return fail('This request reached its message limit. Ask the support team for help.');
        const t = now();
        const arr = (ticketReplyHits.get(ticket.id) || []).filter((x) => t - x < TICKET_REPLY_LIMIT.windowMs);
        if (arr.length >= TICKET_REPLY_LIMIT.max) return fail('You are sending messages too fast. Please wait a few minutes.');
        arr.push(t); ticketReplyHits.set(ticket.id, arr);

        addTicketMessage(ticket, 'member', ticket.username, body);
        ticket.status = 'open';
        await persist();
        notifyOwners(ticketEmbed(`💬 ${ticket.id}: new message`, `**${ticket.username}** replied:\n\n> ${truncate(body, 600)}\n\n${staffLink(ticket)}`)).catch(() => { });
        res.redirect(`/support/security/${ticket.id}?sent=1`);
    });
}

// ---------- /settings/security (dashboard owners only) ----------
const isOwnerSession = (req) => req.session?.user?.id === 'admin' && req.session.isHeadAdmin === true && req.session.user.rank === 'owner';
function registerOwnerPage(ctx) {
    const { app } = ctx;
    const guard = (req, res, next) => {
        if (!req.session?.user) return res.redirect('/login');
        if (!isOwnerSession(req)) return res.status(403).send('Only dashboard owners can open this page.');
        next();
    };
    const back = (res, key, text, to = '/settings/security') => res.redirect(to + '?' + key + '=' + encodeURIComponent(text));
    // Where to return after a button: only pages under /settings/security.
    const returnTo = (req) => { const b = String(req.body.back || ''); return /^\/settings\/security(\/[A-Za-z0-9_-]+)*$/.test(b) ? b : '/settings/security'; };
    const target = (req) => ctx.getAdminUsers().find((a) => a.id === String(req.body.id || ''));

    app.get('/settings/security', guard, (req, res) => {
        const t = now();
        const accounts = ctx.getAdminUsers().map((a) => {
            const x = sec(a);
            return {
                id: a.id, username: a.username, rank: a.rank, discordId: a.discordId || null, isSelf: a.id === req.session.staffId,
                locked: x.locked, failed: x.failed, maxFailed: MAX_FAILED, lockedAt: x.lockedAt || null, lockedBy: x.lockedBy || null,
                lockedReason: x.lockedReason || null, otpBlocked: !!x.otpBlocked, lastFailedAt: x.lastFailedAt || null, lastFailedIp: x.lastFailedIp || null,
            };
        }).sort((a, b) => Number(b.locked) - Number(a.locked) || a.username.localeCompare(b.username));
        const bs = blockStore() || {};
        const blocks = Object.entries(bs).filter(([, b]) => b.until > t).map(([ip, b]) => ({ ip, reason: b.reason, until: b.until })).sort((a, b) => b.until - a.until);
        const allTickets = Object.values(tickets()).sort((a, b) => (a.status === 'solved') - (b.status === 'solved') || b.updatedAt - a.updatedAt);
        accounts.forEach((a) => { a.supportHold = sec(ctx.getAdminUsers().find((x) => x.id === a.id)).supportHold || null; a.openTicket = (openTicketFor(a.id) || {}).id || null; a.ticketCount = ticketsFor(a.id).length; });
        res.render('security', {
            user: req.session.user, accounts, blocks, otpEnabled: OTP_ENABLED, tickets: allTickets.slice(0, 40), STATUS_LABEL,
            msg: String(req.query.msg || '').slice(0, 200) || null, err: String(req.query.err || '').slice(0, 200) || null,
        });
    });
    app.post('/settings/security/unlock', guard, async (req, res) => {
        const a = target(req);
        if (!a) return back(res, 'err', 'Account not found.');
        if (!sec(a).locked) return back(res, 'msg', `${a.username} isn't locked.`, returnTo(req));
        await unlockAccount(a, { by: `${req.session.user.username} (owner, dashboard)`, method: 'dashboard' });
        back(res, 'msg', `Unlocked ${a.username}. They must set a new password at next login.`, returnTo(req));
    });
    app.post('/settings/security/lock', guard, async (req, res) => {
        const a = target(req);
        if (!a) return back(res, 'err', 'Account not found.');
        if (a.id === req.session.staffId) return back(res, 'err', "You can't lock your own account.");
        if (sec(a).locked) return back(res, 'msg', `${a.username} is already locked.`, returnTo(req));
        await lockAccount(a, { reason: `Locked by ${req.session.user.username} (owner)`, by: `${req.session.user.username} (owner, dashboard)` });
        back(res, 'msg', `Locked ${a.username}.`, returnTo(req));
    });

    // ----- messages with locked / other staff logins -----
    const staffName = (req) => req.session.user.username;
    const ticketPage = (req, res, ticket, account, extra = {}) => res.render('security-ticket', {
        user: req.session.user, selfId: req.session.staffId, ticket, account, staffIdMasked: maskedStaffId(account), staffIdFull: (idTools() && account) ? idTools().reveal(account) : null, accountState: account ? sec(account) : {}, STATUS_LABEL, memberUrl: ticket ? memberLink(ticket) : null,
        limits: { max: TICKET_MSG_MAX }, msg: String(req.query.msg || '').slice(0, 200) || null, err: String(req.query.err || '').slice(0, 200) || null, ...extra,
    });
    const ticketOr404 = (req, res) => {
        const ticket = tickets()[String(req.params.id).toUpperCase()];
        if (!ticket) { res.status(404).send('Ticket not found.'); return null; }
        return ticket;
    };

    app.get('/settings/security/ticket/:id', guard, (req, res) => {
        const ticket = ticketOr404(req, res);
        if (ticket) ticketPage(req, res, ticket, ctx.getAdminUsers().find((a) => a.id === ticket.accountId) || null);
    });

    // Owners only (guard): permanently deletes a SEC- request and its whole conversation.
    app.post('/settings/security/ticket/:id/delete', guard, async (req, res) => {
        const ticket = ticketOr404(req, res);
        if (!ticket) return;
        const account = ctx.getAdminUsers().find((a) => a.id === ticket.accountId) || null;
        // If this request is what holds the account suspended, release the hold (the account itself stays locked
        // until it is unlocked, but Discord-code unlock works again).
        if (account && sec(account).supportHold === ticket.id) sec(account).supportHold = null;
        delete tickets()[ticket.id];
        ticketReplyHits.delete(ticket.id);
        event(`Support request ${ticket.id} (${ticket.username}) deleted by ${staffName(req)}.`);
        logToModLog('🗑️ Security Request Deleted', `**${ticket.id}** (login **${ticket.username}**) was deleted by **${staffName(req)}**.`, 0xED4245);
        await persist();
        back(res, 'msg', `Deleted ${ticket.id}.`);
    });

    app.post('/settings/security/ticket/:id/reply', guard, async (req, res) => {
        const ticket = ticketOr404(req, res);
        if (!ticket) return;
        const to = `/settings/security/ticket/${ticket.id}`;
        const account = ctx.getAdminUsers().find((a) => a.id === ticket.accountId) || null;
        const action = String(req.body.action || 'reply');
        const body = cleanText(req.body.body, TICKET_MSG_MAX);
        if (action === 'reopen') {
            ticket.status = 'open'; addTicketMessage(ticket, 'event', 'System', `Reopened by ${staffName(req)}.`);
            await persist(); return back(res, 'msg', 'Reopened.', to);
        }
        if (action === 'solve' && !body) {
            ticket.status = 'solved'; addTicketMessage(ticket, 'event', 'System', `Marked solved by ${staffName(req)}.`);
            await persist(); return back(res, 'msg', 'Marked solved.', to);
        }
        if (!body) return back(res, 'err', 'Write a message first.', to);
        if (ticket.messages.filter((m) => m.from !== 'event').length >= TICKET_MAX_MESSAGES) return back(res, 'err', 'Message limit reached for this ticket.', to);
        addTicketMessage(ticket, 'staff', staffName(req), body);
        ticket.status = action === 'solve' ? 'solved' : 'awaiting';
        if (action === 'solve') addTicketMessage(ticket, 'event', 'System', `Marked solved by ${staffName(req)}.`);
        await persist();
        const sent = account?.discordId ? await dmUser(account.discordId, ticketEmbed(`💬 Support replied to ${ticket.id}`, `The support team answered your request:\n\n> ${truncate(body, 900)}\n\nOpen your private link from the first DM, or:\n${memberLink(ticket)}`)) : false;
        back(res, 'msg', sent ? 'Reply sent and the member was DM\'d.' : 'Reply saved. The member has no Discord DM available, so give them their link (shown on this page).', to);
    });

    // Start a conversation with a staff login (no hold, the account isn't touched).
    app.get('/settings/security/contact/:accountId', guard, (req, res) => {
        const account = ctx.getAdminUsers().find((a) => a.id === req.params.accountId);
        if (!account) return back(res, 'err', 'Account not found.');
        const open = openTicketFor(account.id);
        if (open) return res.redirect(`/settings/security/ticket/${open.id}`);
        ticketPage(req, res, null, account);
    });
    app.post('/settings/security/contact/:accountId', guard, async (req, res) => {
        const account = ctx.getAdminUsers().find((a) => a.id === req.params.accountId);
        if (!account) return back(res, 'err', 'Account not found.');
        const body = cleanText(req.body.body, TICKET_MSG_MAX);
        if (body.length < 2) return back(res, 'err', 'Write a message first.', `/settings/security/contact/${account.id}`);
        const existing = openTicketFor(account.id);
        const ticket = existing || createTicket(account, { from: 'staff', name: staffName(req), body, ip: req.ip });
        if (existing) { addTicketMessage(existing, 'staff', staffName(req), body); existing.status = 'awaiting'; }
        event(`${staffName(req)} messaged staff login "${account.username}" (${ticket.id}).`);
        await persist();
        const sent = account.discordId ? await dmUser(account.discordId, ticketEmbed(`💬 Message from the support team (${ticket.id})`, `${truncate(body, 900)}\n\n**Private link to read and answer (don't share it):**\n${memberLink(ticket)}`)) : false;
        back(res, 'msg', sent ? `Sent. ${account.username} was DM'd their private link.` : `Saved. ${account.username} has no Discord DM available, so copy their private link from this page and send it to them.`, `/settings/security/ticket/${ticket.id}`);
    });

    app.post('/settings/security/unblock', guard, async (req, res) => {
        const ip = normIp(String(req.body.ip || '').slice(0, 64));
        const bs = blockStore() || {};
        delete bs[ip]; memBlocks.delete(ip); strikes.delete(ip); loginFails.delete(ip);
        for (const k of [...hits.keys()]) if (k.endsWith(`:${ip}`)) hits.delete(k);
        event(`IP ${maskIp(ip)} unblocked by ${req.session.user.username} (dashboard).`);
        await persist();
        back(res, 'msg', `Unblocked ${ip}.`);
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
        (s.supportHold ? `\n🆘 Suspended: support request ${s.supportHold} open (owner must unlock)` : '') +
        (s.locked && s.otpBlocked ? '\n⚠️ Code-unlock disabled (3 wrong codes) — support must unlock' : '') +
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
