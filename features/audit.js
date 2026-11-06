// Audit log viewer: Discord's audit log (via the API) + the bot's own activity feed.
const { AuditLogEvent } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, truncate, ts } = require('./util');

// Friendly filter name -> AuditLogEvent value. Only names that exist in the
// installed discord.js are kept.
const FILTER_SOURCE = {
    ban: 'MemberBanAdd', unban: 'MemberBanRemove', kick: 'MemberKick', prune: 'MemberPrune',
    'member-update': 'MemberUpdate', 'member-roles': 'MemberRoleUpdate',
    'role-create': 'RoleCreate', 'role-update': 'RoleUpdate', 'role-delete': 'RoleDelete',
    'channel-create': 'ChannelCreate', 'channel-update': 'ChannelUpdate', 'channel-delete': 'ChannelDelete',
    'message-delete': 'MessageDelete', 'message-bulk-delete': 'MessageBulkDelete', 'message-pin': 'MessagePin',
    'invite-create': 'InviteCreate', 'invite-delete': 'InviteDelete',
    'webhook-create': 'WebhookCreate', 'bot-add': 'BotAdd', 'server-update': 'GuildUpdate',
    'emoji-create': 'EmojiCreate', 'emoji-delete': 'EmojiDelete',
};
const FILTERS = Object.fromEntries(Object.entries(FILTER_SOURCE).filter(([, ev]) => AuditLogEvent[ev] !== undefined).map(([k, ev]) => [k, AuditLogEvent[ev]]));

const EVENT_NAME = {};
for (const [k, v] of Object.entries(AuditLogEvent)) if (typeof v === 'number') EVENT_NAME[v] = k;

const humanize = (name) => String(name).replace(/([a-z])([A-Z])/g, '$1 $2');

function fmtValue(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'object') { try { return truncate(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)), 90); } catch { return '[object]'; } }
    return truncate(String(v), 90);
}

function targetLabel(entry) {
    const t = entry.target;
    if (t) {
        if (t.tag) return `${t.tag} (${t.id})`;
        if (t.username) return `${t.username} (${t.id})`;
        if (t.name) return `${t.name}${t.id ? ` (${t.id})` : ''}`;
        if (t.code) return `invite ${t.code}`;
        if (t.id) return `ID ${t.id}`;
    }
    return entry.targetId ? `ID ${entry.targetId}` : '—';
}

function describeEntry(entry) {
    return {
        id: entry.id,
        at: entry.createdTimestamp,
        action: EVENT_NAME[entry.action] || `Action ${entry.action}`,
        actionLabel: humanize(EVENT_NAME[entry.action] || `Action ${entry.action}`),
        executorId: entry.executor?.id || null,
        executor: entry.executor ? (entry.executor.tag || entry.executor.username) : 'Unknown',
        target: targetLabel(entry),
        targetId: entry.targetId || entry.target?.id || null,
        reason: entry.reason || '',
        changes: (entry.changes || []).slice(0, 8).map((c) => ({ key: c.key, from: fmtValue(c.old), to: fmtValue(c.new) })),
    };
}

// Returns { ok, entries, error, hasMore, lastId }
async function fetchEntries(guild, { type, executorId, targetId, limit = 25, before } = {}) {
    try {
        const opts = { limit: Math.min(100, Math.max(1, limit)) };
        if (type && FILTERS[type] !== undefined) opts.type = FILTERS[type];
        if (executorId && /^\d{15,25}$/.test(executorId)) opts.user = executorId;
        if (before && /^\d{15,25}$/.test(before)) opts.before = before;
        const logs = await guild.fetchAuditLogs(opts);
        let entries = [...logs.entries.values()];
        const lastId = entries.length ? entries[entries.length - 1].id : null;
        const hasMore = entries.length >= opts.limit;
        if (targetId) entries = entries.filter((e) => (e.targetId || e.target?.id) === targetId);
        return { ok: true, entries: entries.map(describeEntry), hasMore, lastId };
    } catch (err) {
        const missing = err.code === 50013 || /permission/i.test(err.message);
        return { ok: false, entries: [], error: missing ? 'I need the **View Audit Log** permission to read this.' : `Discord returned an error: ${err.message}` };
    }
}

function botEvents(db, { type, limit = 50 } = {}) {
    const list = store(db, 'events', { list: [] }).list;
    return list.filter((e) => !type || e.type === type).slice(0, limit);
}

const commands = {
    async audit({ interaction, options, guild, isAtLeastAdmin }) {
        const { db } = context.get();
        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
        if (!getConfig(db, 'audit').enabled) return interaction.editReply('🚫 The audit log viewer is disabled (`/feature enable audit`).');
        const executor = options.getUser('executor');
        const target = options.getUser('target');
        const res = await fetchEntries(guild, { type: options.getString('type'), executorId: executor?.id, targetId: target?.id, limit: target ? 100 : (options.getInteger('limit') || 10) });
        if (!res.ok) return interaction.editReply(`❌ ${res.error}`);
        const rows = res.entries.slice(0, options.getInteger('limit') || 10);
        if (!rows.length) return interaction.editReply('🔎 No audit log entries match.');
        const lines = rows.map((e) => `${ts(e.at)} **${e.actionLabel}** — by ${truncate(e.executor, 30)} → ${truncate(e.target, 40)}${e.reason ? `\n> ${truncate(e.reason, 100)}` : ''}`);
        return interaction.editReply({ embeds: [brandEmbed({ title: '📜 Audit log', description: lines.join('\n'), footer: 'Open the dashboard Audit Log page for filters and paging' })], allowedMentions: { parse: [] } });
    },
};

const definitions = [
    {
        name: 'audit',
        description: 'View the server audit log (Admin+)',
        options: [
            { name: 'type', description: 'Only this kind of event', type: 3, required: false, choices: Object.keys(FILTERS).slice(0, 25).map((k) => ({ name: k, value: k })) },
            { name: 'executor', description: 'Only actions done by this user', type: 6, required: false },
            { name: 'target', description: 'Only actions affecting this user', type: 6, required: false },
            { name: 'limit', description: 'How many entries (1-15, default 10)', type: 4, required: false, min_value: 1, max_value: 15 },
        ],
    },
];

module.exports = { fetchEntries, describeEntry, botEvents, FILTERS, commands, definitions };
