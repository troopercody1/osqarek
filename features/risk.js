// Risk manager scoring (Dashboard → Risk manager).
//
// assessMembers() scores every human member from signals the bot already has, buckets them
// (critical / high / medium / low) and returns the flagged ones, worst first. It is a pure function
// of its inputs (no Discord or db calls of its own), so it is cheap to run on a page load and easy to test.
//
// A score is a sum of weighted signals capped at 100, and every signal is kept as a reason so staff can
// see exactly why someone was flagged. Dismissed ("reviewed") members are excluded and live in db.reviewedUsers,
// with who/when/note in db.riskReviews.

const DAY = 86400000;
const HOUR = 3600000;
const DISCORD_EPOCH = 1420070400000n;

const LEVELS = [
    { key: 'critical', min: 70, label: 'Critical' },
    { key: 'high', min: 50, label: 'High' },
    { key: 'medium', min: 30, label: 'Medium' },
    { key: 'low', min: 0, label: 'Low' },
];
const MAX_ROWS = 300; // flagged members shown at once; the rest are summarised in the counts

const levelFor = (score) => LEVELS.find(l => score >= l.min);

function createdAtOf(id) {
    try { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); } catch { return null; }
}

// Number of timestamps in the sorted array `times` within ±windowMs of `t` (including t itself).
function countNear(times, t, windowMs) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t - windowMs) lo = mid + 1; else hi = mid; }
    const first = lo;
    hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t + windowMs) lo = mid + 1; else hi = mid; }
    return lo - first;
}

function ago(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < HOUR) return Math.max(1, Math.round(ms / 60000)) + 'm';
    if (ms < DAY) return Math.round(ms / HOUR) + 'h';
    if (ms < 60 * DAY) return Math.round(ms / DAY) + 'd';
    if (ms < 730 * DAY) return Math.round(ms / (30.44 * DAY)) + 'mo';
    return (ms / (365.25 * DAY)).toFixed(1).replace(/\.0$/, '') + 'y';
}

// opts: { cases: db.cases, reviewed: Set|array of dismissed ids, isStaff: (member) => boolean, now }
function assessMembers(members, opts = {}) {
    const now = opts.now || Date.now();
    const reviewed = new Set(opts.reviewed || []);
    const isStaff = typeof opts.isStaff === 'function' ? opts.isStaff : () => false;

    // Prior moderation cases per member (warns, mutes, bans...). Strike removals don't count against anyone.
    const caseCounts = new Map();
    for (const c of opts.cases || []) {
        const id = c.userId || c.user;
        if (!id || /removal/i.test(String(c.type || ''))) continue;
        caseCounts.set(String(id), (caseCounts.get(String(id)) || 0) + 1);
    }

    const list = Array.from(members || []).filter(m => m?.user && !m.user.bot && !reviewed.has(m.id));

    // Join times of recent joiners, for spotting raid-style bursts.
    const recentJoins = list.map(m => m.joinedTimestamp).filter(t => t && t > now - 30 * DAY).sort((a, b) => a - b);

    const rows = [];
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const m of list) {
        if (isStaff(m)) continue; // staff aren't "risky members"; they're handled by /strike
        const reasons = [];
        const add = (points, label) => reasons.push({ points, label });

        const createdAt = createdAtOf(m.id);
        const accountAge = createdAt ? now - createdAt : null;
        const sinceJoin = m.joinedTimestamp ? now - m.joinedTimestamp : null;

        if (accountAge !== null) {
            if (accountAge < DAY) add(40, 'Account made today');
            else if (accountAge < 7 * DAY) add(32, 'Account under 7 days old');
            else if (accountAge < 30 * DAY) add(22, 'Account under 30 days old');
            else if (accountAge < 90 * DAY) add(12, 'Account under 90 days old');
            else if (accountAge < 365 * DAY) add(5, 'Account under 1 year old');
        }
        if (sinceJoin !== null) {
            if (sinceJoin < DAY) add(25, 'Joined in the last 24h');
            else if (sinceJoin < 7 * DAY) add(15, 'Joined in the last 7 days');
            else if (sinceJoin < 30 * DAY) add(5, 'Joined in the last 30 days');
        }
        if (accountAge !== null && m.joinedTimestamp && accountAge < 7 * DAY && m.joinedTimestamp - createdAt < HOUR) {
            add(10, 'Made the account just to join');
        }
        if (!m.user.avatar) add(10, 'No avatar');
        if (/\d{5,}/.test(m.user.username || '')) add(6, 'Long number in username');
        if (m.roles?.cache && m.roles.cache.size <= 1) add(8, 'No roles (not verified?)');
        if (m.pending) add(8, 'Hasn\'t passed membership screening');
        if (m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > now) add(10, 'Currently timed out');

        const prior = caseCounts.get(m.id) || 0;
        if (prior > 0) add(Math.min(30, 12 * prior), `${prior} prior case${prior === 1 ? '' : 's'}`);

        if (m.joinedTimestamp && m.joinedTimestamp > now - 30 * DAY) {
            const burst = countNear(recentJoins, m.joinedTimestamp, 5 * 60000);
            if (burst >= 5) add(Math.min(20, 10 + burst), `Joined in a burst (${burst} members within 10 min)`);
        }

        const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
        const level = levelFor(score);
        counts[level.key]++;
        if (level.key === 'low') continue;

        rows.push({
            id: m.id,
            tag: m.user.tag || m.user.username,
            avatar: typeof m.user.displayAvatarURL === 'function' ? m.user.displayAvatarURL({ size: 64 }) : null,
            score, level: level.key, levelLabel: level.label,
            reasons: reasons.sort((a, b) => b.points - a.points),
            accountAge: ago(accountAge), joined: ago(sinceJoin),
            priorCases: prior,
        });
    }

    rows.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
    return {
        rows: rows.slice(0, MAX_ROWS),
        flagged: rows.length,
        hidden: Math.max(0, rows.length - MAX_ROWS),
        counts,
        total: counts.critical + counts.high + counts.medium + counts.low,
    };
}

// Dismissed members for the "Reviewed" list: [{ id, tag, at, by, note }], newest first.
// `lookup(id)` returns a GuildMember (or undefined if they left).
function reviewedList(reviewedIds, reviews, lookup) {
    return Array.from(new Set(reviewedIds || [])).map(id => {
        const meta = (reviews || {})[id] || {};
        const m = lookup ? lookup(id) : null;
        return { id, tag: m?.user?.tag || m?.user?.username || null, inServer: !!m, at: meta.at || 0, by: meta.by || null, note: meta.note || '' };
    }).sort((a, b) => b.at - a.at);
}

module.exports = { assessMembers, reviewedList, levelFor, LEVELS, MAX_ROWS };
