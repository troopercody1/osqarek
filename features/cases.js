// Case search. The existing case list has mixed shapes (some entries store the
// user's tag in `user`, strike entries store the ID, timestamps are sometimes
// missing), so every match here is deliberately tolerant.
const context = require('./context');
const { brandEmbed, truncate, ts } = require('./util');

const PAGE_SIZE = 10;

const plain = (s) => String(s ?? '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

function caseTime(c) {
    if (!c || !c.timestamp) return null;
    const t = new Date(c.timestamp).getTime();
    return Number.isFinite(t) ? t : null;
}

// filters: { userId, userText, moderator, type, keyword, sinceMs, untilMs, page, pageSize }
function searchCases(cases, f = {}) {
    const pageSize = f.pageSize || PAGE_SIZE;
    const uid = f.userId ? String(f.userId) : null;
    const userText = f.userText ? plain(f.userText) : null;
    const mod = f.moderator ? plain(f.moderator) : null;
    const type = f.type ? plain(f.type) : null;
    const kw = f.keyword ? String(f.keyword).toLowerCase() : null;

    let list = (Array.isArray(cases) ? cases : []).filter((c) => {
        if (!c) return false;
        if (uid && !(String(c.userId || '') === uid || String(c.user || '') === uid || String(c.user || '').includes(uid))) return false;
        if (userText && !(plain(c.user).includes(userText) || String(c.userId || '').includes(userText))) return false;
        if (mod && !plain(c.moderator).includes(mod)) return false;
        if (type && !plain(c.type).includes(type)) return false;
        if (kw && !String(c.reason || '').toLowerCase().includes(kw)) return false;
        if (f.sinceMs || f.untilMs) {
            const t = caseTime(c);
            if (t === null) return false;
            if (f.sinceMs && t < f.sinceMs) return false;
            if (f.untilMs && t > f.untilMs) return false;
        }
        return true;
    });

    // Newest first: by timestamp when we have one, otherwise by id.
    list = list.slice().sort((a, b) => (caseTime(b) ?? 0) - (caseTime(a) ?? 0) || (b.id ?? 0) - (a.id ?? 0));

    const byType = {};
    for (const c of list) { const k = plain(c.type) || 'unknown'; byType[k] = (byType[k] || 0) + 1; }

    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(Math.max(1, f.page || 1), pages);
    return { total: list.length, page, pages, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize), byType };
}

function userLabel(c) {
    if (c.userId && /^\d{15,25}$/.test(String(c.userId))) return `<@${c.userId}>`;
    if (/^\d{15,25}$/.test(String(c.user || ''))) return `<@${c.user}>`;
    return truncate(c.user || 'unknown', 40);
}

const commands = {
    async 'case-search'({ interaction, options, isTrial }) {
        const { db } = context.get();
        if (!isTrial) return interaction.editReply('❌ You need **Trial Moderator+** to use this.');
        const user = options.getUser('user');
        const days = options.getInteger('days');
        const result = searchCases(db.cases, {
            userId: user?.id,
            moderator: options.getString('moderator'),
            type: options.getString('type'),
            keyword: options.getString('keyword'),
            sinceMs: days ? Date.now() - days * 86400000 : null,
            page: options.getInteger('page') || 1,
        });
        if (!result.total) return interaction.editReply('🔎 No cases match those filters.');
        const lines = result.items.map((c) => {
            const t = caseTime(c);
            return `**#${c.id}** ${truncate(c.type, 30)} · ${userLabel(c)}${t ? ` · ${ts(t)}` : ''} · by ${truncate(c.moderator || 'unknown', 30)}\n> ${truncate(c.reason || 'No reason', 120)}`;
        });
        const breakdown = Object.entries(result.byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(' • ');
        return interaction.editReply({
            embeds: [brandEmbed({ title: `🔎 Case search — ${result.total} match${result.total === 1 ? '' : 'es'}`, description: lines.join('\n\n'), footer: `Page ${result.page}/${result.pages}${breakdown ? ` • ${breakdown}` : ''}` })],
            allowedMentions: { parse: [] },
        });
    },
};

const definitions = [
    {
        name: 'case-search',
        description: 'Search moderation cases',
        options: [
            { name: 'user', description: 'Only cases for this user', type: 6, required: false },
            { name: 'type', description: 'Case type contains… (e.g. warn, ban, mute)', type: 3, required: false },
            { name: 'moderator', description: 'Moderator name contains…', type: 3, required: false },
            { name: 'keyword', description: 'Reason contains…', type: 3, required: false },
            { name: 'days', description: 'Only cases from the last N days', type: 4, required: false, min_value: 1, max_value: 3650 },
            { name: 'page', description: 'Page number', type: 4, required: false, min_value: 1 },
        ],
    },
];

module.exports = { searchCases, caseTime, userLabel, plain, commands, definitions, PAGE_SIZE };
