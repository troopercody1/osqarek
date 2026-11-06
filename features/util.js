// Shared helpers for the feature modules (raid protection, ban-evasion flags,
// impersonation guard, timed actions, giveaways, polls, audit viewer, analytics).
const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');

const BRAND_COLOR = 0x5500FF;
const FOOTER = "OsQarek's Universe";

// ---------- durations ----------
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// "90s", "15m", "2h", "3d", "1w", "1d12h30m". A bare number is minutes.
// Returns milliseconds, or null if it can't be parsed / is <= 0.
function parseDuration(input) {
    if (input == null) return null;
    const str = String(input).trim().toLowerCase().replace(/\s+/g, '');
    if (!str) return null;
    if (/^\d+$/.test(str)) {
        const ms = parseInt(str, 10) * 60000;
        return ms > 0 ? ms : null;
    }
    const re = /(\d+(?:\.\d+)?)([smhdw])/g;
    let total = 0;
    let consumed = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
        total += parseFloat(m[1]) * UNIT_MS[m[2]];
        consumed += m[0].length;
    }
    if (consumed !== str.length || total <= 0) return null;
    return Math.round(total);
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    let s = Math.floor(ms / 1000);
    const parts = [];
    for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
        if (s >= size) {
            parts.push(`${Math.floor(s / size)}${label}`);
            s %= size;
        }
        if (parts.length === 2) break;
    }
    return parts.join(' ') || '0s';
}

// Discord timestamp markup. style: R = relative, f = short date/time, F = long.
function ts(ms, style = 'R') {
    return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

// ---------- text ----------
function truncate(str, max = 100) {
    const s = String(str ?? '');
    return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

// Characters that look like Latin letters/digits. Used to fold look-alike names.
const CONFUSABLES = {
    // Cyrillic
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ӏ': 'l', 'ԁ': 'd', 'ɡ': 'g', 'ԛ': 'q', 'ԝ': 'w',
    // Greek
    'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
    // Leet / symbols
    '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a', '!': 'i', '|': 'l', '¡': 'i',
    // Latin extras
    'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
};

// Folds a display name down to a comparable skeleton: strips accents, fancy
// unicode fonts (NFKD), zero-width chars, spaces and punctuation, and swaps
// common look-alike characters. "𝕆𝕤𝕢𝕒𝕣𝕖𝕜", "0sQarek" and "Оsqarek" (Cyrillic О) all
// fold to "osqarek".
function fold(input) {
    let s = String(input ?? '').normalize('NFKD').toLowerCase();
    s = s.replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '');
    let out = '';
    for (const ch of s) out += CONFUSABLES[ch] ?? ch;
    return out.replace(/[^a-z0-9\u0400-\u04ff\u0370-\u03ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g, '');
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

// 0..1 (1 = identical)
function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// ---------- random ----------
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ---------- db access ----------
// Every feature keeps its data under db.features.<name>. Access always goes
// through here (never cache the returned object across awaits for long): the
// Redis load at startup does Object.assign(db, remote), which can replace
// db.features wholesale after init.
function store(db, name, defaults = {}) {
    if (!db.features || typeof db.features !== 'object') db.features = {};
    if (!db.features[name] || typeof db.features[name] !== 'object') db.features[name] = {};
    const s = db.features[name];
    for (const [k, v] of Object.entries(defaults)) {
        if (s[k] === undefined) s[k] = typeof v === 'function' ? v() : JSON.parse(JSON.stringify(v));
    }
    return s;
}

// Compatible with the case shape the rest of the bot already writes
// ({ id, type, user, userId, reason, moderator, timestamp }).
function nextCaseId(db) {
    if (!Array.isArray(db.cases)) db.cases = [];
    return db.cases.reduce((max, c) => (Number.isFinite(c?.id) && c.id > max ? c.id : max), 0) + 1;
}

function addCase(db, { type, userId, userTag, reason, moderator }) {
    const entry = {
        id: nextCaseId(db),
        type,
        user: userTag || String(userId),
        userId: String(userId),
        reason: reason || 'No reason provided.',
        moderator: moderator || 'Auto',
        timestamp: new Date(),
    };
    db.cases.push(entry);
    return entry;
}

// Bot-side activity feed shown on the dashboard "Audit Log" page next to
// Discord's own audit log. Capped so the saved database stays small.
const EVENT_CAP = 500;
function recordEvent(db, type, text, extra = {}) {
    const s = store(db, 'events', { list: [] });
    s.list.unshift({ ts: Date.now(), type, text: truncate(text, 400), ...extra });
    if (s.list.length > EVENT_CAP) s.list.length = EVENT_CAP;
}

// Coalesces many mutations into one db.save() a little later. Used for
// high-frequency data (analytics, join tracking) so we don't hammer Upstash.
function makeDebouncedSaver(db, delayMs = 30000) {
    let timer = null;
    const flush = async () => {
        timer = null;
        try { await db.save(); } catch (err) { console.error('❌ Debounced save failed:', err.message); }
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, delayMs); };
    schedule.flush = async () => { if (timer) { clearTimeout(timer); } await flush(); };
    return schedule;
}

function brandEmbed({ title, description, color = BRAND_COLOR, fields, footer = FOOTER, timestamp = true } = {}) {
    const e = new EmbedBuilder().setColor(color);
    if (title) e.setTitle(truncate(title, 256));
    if (description) e.setDescription(truncate(description, 4000));
    if (fields?.length) e.addFields(fields.map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value || '—', 1024), inline: !!f.inline })));
    if (footer) e.setFooter({ text: footer });
    if (timestamp) e.setTimestamp();
    return e;
}

// YYYY-MM-DD in the process timezone (index.js sets TZ=Europe/London).
function dayKey(ms = Date.now()) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isSnowflake(v) {
    return typeof v === 'string' && /^\d{15,25}$/.test(v);
}

module.exports = {
    BRAND_COLOR, FOOTER,
    parseDuration, formatDuration, ts, truncate,
    fold, levenshtein, similarity, shuffle,
    store, nextCaseId, addCase, recordEvent, makeDebouncedSaver, brandEmbed, dayKey, isSnowflake,
};
