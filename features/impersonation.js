// Impersonation guard: catch members whose name copies a staff member or a
// protected name, including look-alike characters (Cyrillic "О", 0 for o, etc).
const context = require('./context');
const actions = require('./actions');
const { getConfig, setValue } = require('./config');
const { store, brandEmbed, recordEvent, fold, similarity, truncate, ts } = require('./util');

const HIT_CAP = 100;
const STAFF_CACHE_TTL = 5 * 60 * 1000;
const MIN_PROTECTED_LEN = 5;
const THROTTLE_MS = 5 * 60 * 1000;

let staffCache = { at: 0, entries: [] };

function data() {
    const { db } = context.get();
    return store(db, 'impersonation', { hits: [] });
}

function moderatedName(member) {
    return `ModeratedNickname#${member.id.slice(-4)}`;
}

function entriesFromNames(names, label, ownerId) {
    const out = [];
    const seen = new Set();
    for (const raw of names) {
        const folded = fold(raw);
        if (folded.length >= MIN_PROTECTED_LEN && !seen.has(folded)) {
            seen.add(folded);
            out.push({ folded, raw, label, ownerId });
        }
    }
    return out;
}

// Protected entries = custom names + (optionally) every staff member's names.
async function getProtected(guild, cfg, { force = false } = {}) {
    const entries = [];
    for (const raw of cfg.protectedNames) entries.push(...entriesFromNames([raw], raw, null));

    if (cfg.protectStaff) {
        if (force || Date.now() - staffCache.at > STAFF_CACHE_TTL) {
            const { getCachedMembers } = context.get();
            const members = await getCachedMembers(guild, { ttl: STAFF_CACHE_TTL }).catch(() => guild.members.cache);
            const staffEntries = [];
            members.forEach((m) => {
                if (m.user.bot || !actions.isStaff(m, guild)) return;
                staffEntries.push(...entriesFromNames([m.user.username, m.user.globalName, m.displayName, m.nickname].filter(Boolean), m.user.tag, m.id));
            });
            staffCache = { at: Date.now(), entries: staffEntries };
        }
        entries.push(...staffCache.entries);
    }
    return entries;
}

// Returns { score, kind } or null.
function compare(candidateName, entry, thresholdPct) {
    const cf = fold(candidateName);
    if (cf.length < 4) return null;
    if (cf === entry.folded) return { score: 100, kind: 'identical (after folding look-alike characters)' };
    if (entry.folded.length >= 6 && cf.includes(entry.folded) && cf.length - entry.folded.length <= 16) {
        return thresholdPct <= 90 ? { score: 90, kind: 'contains the protected name' } : null;
    }
    if (Math.min(cf.length, entry.folded.length) >= MIN_PROTECTED_LEN) {
        const score = Math.round(similarity(cf, entry.folded) * 100);
        if (score >= thresholdPct) return { score, kind: `${score}% similar` };
    }
    return null;
}

function bestMatch(names, entries, cfg, { selfId = null } = {}) {
    let best = null;
    for (const entry of entries) {
        if (selfId && entry.ownerId === selfId) continue;
        for (const [field, raw] of names) {
            if (!raw) continue;
            const r = compare(raw, entry, cfg.threshold);
            if (r && (!best || r.score > best.score)) best = { ...r, field, name: raw, protectedLabel: entry.label, protectedName: entry.raw };
        }
    }
    return best;
}

function memberNames(member) {
    return [['username', member.user.username], ['display name', member.user.globalName], ['server nickname', member.nickname]];
}

function isExempt(member, guild, cfg) {
    if (member.user.bot) return true;
    if (actions.isStaff(member, guild)) return true;
    return cfg.exemptRoles.some((id) => member.roles.cache.has(id));
}

async function evaluateMember(member, cfg, entries) {
    if (isExempt(member, member.guild, cfg)) return null;
    if (member.nickname && member.nickname === moderatedName(member)) return null; // already handled
    return bestMatch(memberNames(member), entries, cfg, { selfId: member.id });
}

async function handleMatch(member, match, cfg, source) {
    const { db } = context.get();
    const d = data();
    const guild = member.guild;

    const recent = d.hits.find((h) => h.userId === member.id && Date.now() - h.ts < THROTTLE_MS);
    if (recent) return null;

    let outcome = 'flagged';
    if (cfg.action === 'rename') {
        if (!member.manageable) outcome = 'rename failed (cannot manage this member)';
        else {
            try {
                await member.setNickname(moderatedName(member), `Impersonation guard: resembles ${match.protectedLabel}`.slice(0, 512));
                outcome = `renamed to ${moderatedName(member)}`;
                if (cfg.dmUser) {
                    await member.send({
                        embeds: [brandEmbed({
                            title: '🎭 Nickname changed',
                            color: 0xFF0000,
                            description: `Your name in **${guild.name}** looked too much like a staff member or protected name, so your nickname was reset. You can set a different one that doesn't copy someone else.`,
                        })],
                    }).catch(() => { });
                }
            } catch (err) { outcome = `rename failed (${truncate(err.message, 80)})`; }
        }
    } else if (cfg.action === 'kick' || cfg.action === 'ban') {
        const r = await actions.applyAction({
            guild, userId: member.id, member, action: cfg.action,
            reason: `Impersonation: "${truncate(match.name, 60)}" resembles ${match.protectedLabel}`,
            caseType: cfg.action === 'ban' ? '🔨 IMPERSONATION BAN' : '👢 IMPERSONATION KICK',
            moderator: 'Impersonation Guard',
        });
        outcome = r.ok ? r.outcome : `${cfg.action} failed (${r.error})`;
    }

    d.hits.unshift({ ts: Date.now(), userId: member.id, tag: member.user.tag, field: match.field, name: truncate(match.name, 60), protectedLabel: match.protectedLabel, score: match.score, kind: match.kind, action: cfg.action, outcome, source });
    if (d.hits.length > HIT_CAP) d.hits.length = HIT_CAP;
    recordEvent(db, 'impersonation', `${member.user.tag}: ${match.field} "${truncate(match.name, 40)}" resembles ${match.protectedLabel} → ${outcome}`, { userId: member.id });

    await actions.notify(guild, cfg.alertChannel, {
        embed: brandEmbed({
            title: `🎭 Impersonation guard (${source})`,
            color: 0xFF9900,
            description: `<@${member.id}> (${member.user.tag}) — ${match.field} **"${truncate(match.name, 60)}"** is ${match.kind} to **${match.protectedLabel}**.`,
            fields: [{ name: 'Score', value: `${match.score}%`, inline: true }, { name: 'Result', value: outcome, inline: true }],
        }),
    });
    await context.get().safeSave();
    return outcome;
}

async function check(member, source) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    if (!cfg.enabled) return;
    if (member.guild.id !== actions.getGuild()?.id) return;
    const entries = await getProtected(member.guild, cfg);
    if (!entries.length) return;
    const match = await evaluateMember(member, cfg, entries);
    if (match) await handleMatch(member, match, cfg, source);
}

const onJoin = (member) => check(member, 'join');

async function onMemberUpdate(oldMember, newMember) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    if (!cfg.enabled || !cfg.checkUpdates) return;
    const changed = oldMember.partial
        || oldMember.nickname !== newMember.nickname
        || oldMember.user?.username !== newMember.user.username
        || oldMember.user?.globalName !== newMember.user.globalName;
    if (!changed) return;
    // Staff changing their own name must refresh the protected list.
    if (actions.isStaff(newMember, newMember.guild)) staffCache.at = 0;
    await check(newMember, 'name change');
}

// ---------- services (slash command AND dashboard) ----------
async function testName(guild, name) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    const entries = await getProtected(guild, cfg);
    return { name, match: bestMatch([['name', name]], entries, cfg) };
}

async function addProtected(name) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    const n = String(name || '').trim();
    if (fold(n).length < MIN_PROTECTED_LEN) return { ok: false, error: `Names need at least ${MIN_PROTECTED_LEN} letters/numbers once look-alikes are folded.` };
    if (cfg.protectedNames.some((x) => fold(x) === fold(n))) return { ok: false, error: 'That name is already protected.' };
    setValue(db, 'impersonation', 'protectedNames', [...cfg.protectedNames, n]);
    staffCache.at = 0;
    await context.get().safeSave();
    return { ok: true };
}

async function removeProtected(name) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    const idx = cfg.protectedNames.findIndex((x) => fold(x) === fold(String(name || '')));
    if (idx === -1) return { ok: false, error: 'That name isn\'t in the custom list.' };
    const next = [...cfg.protectedNames]; next.splice(idx, 1);
    setValue(db, 'impersonation', 'protectedNames', next);
    await context.get().safeSave();
    return { ok: true };
}

// Preview by default; rename:true sets matching members' nicknames.
async function scanMembers(guild, { rename = false } = {}) {
    const { db, getCachedMembers } = context.get();
    const cfg = getConfig(db, 'impersonation');
    const entries = await getProtected(guild, cfg, { force: true });
    const members = await getCachedMembers(guild, { ttl: 60000, force: true });
    const hits = [];
    for (const m of members.values()) {
        const match = await evaluateMember(m, cfg, entries);
        if (match) hits.push({ m, match });
    }
    let renamed = 0; let failed = 0;
    if (rename) {
        for (const { m, match } of hits) {
            if (!m.manageable) { failed++; continue; }
            try { await m.setNickname(moderatedName(m), `Impersonation scan: resembles ${match.protectedLabel}`.slice(0, 512)); renamed++; } catch { failed++; }
        }
    }
    return { hits, scanned: members.size, renamed, failed };
}

async function protectedSummary(guild) {
    const { db } = context.get();
    const cfg = getConfig(db, 'impersonation');
    await getProtected(guild, cfg, { force: true });
    return { staffMembers: new Set(staffCache.entries.map((e) => e.ownerId)).size, custom: cfg.protectedNames };
}

// ---------- slash command ----------
const commands = {
    async impersonation({ interaction, options, guild, isMod, isAtLeastAdmin }) {
        const { db, getCachedMembers } = context.get();
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        const cfg = getConfig(db, 'impersonation');
        const sub = options.getSubcommand();

        if (sub === 'list') {
            const entries = await getProtected(guild, { ...cfg, protectStaff: cfg.protectStaff }, { force: true });
            const staffCount = new Set(staffCache.entries.map((e) => e.ownerId)).size;
            const custom = cfg.protectedNames.length ? cfg.protectedNames.map((n) => `• ${n}`).join('\n') : '*none*';
            return interaction.editReply({
                embeds: [brandEmbed({
                    title: '🎭 Impersonation guard',
                    description: `**Feature:** ${cfg.enabled ? '✅ enabled' : '⛔ disabled'} • action **${cfg.action}** • threshold **${cfg.threshold}%**\n**Staff names protected:** ${cfg.protectStaff ? `yes (${staffCount} staff members)` : 'no'}\n\n**Custom protected names**\n${custom}`,
                    footer: `${entries.length} names in the protected set`,
                })],
            });
        }

        if (sub === 'check') {
            const r = await testName(guild, options.getString('name'));
            return interaction.editReply(r.match
                ? `⚠️ "${truncate(r.name, 60)}" **would be flagged**: ${r.match.kind} to **${r.match.protectedLabel}** (${r.match.score}%, threshold ${cfg.threshold}%).`
                : `✅ "${truncate(r.name, 60)}" would **not** be flagged at a ${cfg.threshold}% threshold.`);
        }

        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');

        if (sub === 'add' || sub === 'remove') {
            const name = options.getString('name');
            const r = sub === 'add' ? await addProtected(name) : await removeProtected(name);
            if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
            return interaction.editReply(`✅ ${sub === 'add' ? 'Added' : 'Removed'} **${truncate(name.trim(), 60)}**. ${cfg.enabled ? '' : '\n⚠️ The feature is disabled — run `/feature enable impersonation` to start enforcing.'}`);
        }

        if (sub === 'scan') {
            const doRename = options.getBoolean('rename') || false;
            const r = await scanMembers(guild, { rename: doRename });
            const lines = r.hits.slice(0, 15).map(({ m, match }) => `• ${m.user.tag} — ${match.field} "${truncate(match.name, 30)}" ≈ **${match.protectedLabel}** (${match.score}%)`);
            return interaction.editReply({
                embeds: [brandEmbed({
                    title: `🎭 Impersonation scan — ${r.hits.length} match${r.hits.length === 1 ? '' : 'es'}`,
                    description: (lines.join('\n') || 'No matches.') + (r.hits.length > 15 ? `\n…and ${r.hits.length - 15} more` : ''),
                    footer: doRename ? `Renamed ${r.renamed}, couldn't manage ${r.failed}` : `Scanned ${r.scanned} members • preview only (run with rename:true to rename)`,
                })],
            });
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'impersonation',
        description: 'Impersonation guard',
        options: [
            { name: 'list', description: 'Show protected names and settings', type: 1 },
            { name: 'check', description: 'Test whether a name would be flagged', type: 1, options: [{ name: 'name', description: 'The name to test', type: 3, required: true, max_length: 100 }] },
            { name: 'add', description: 'Protect an extra name (Admin+)', type: 1, options: [{ name: 'name', description: 'Name to protect', type: 3, required: true, max_length: 100 }] },
            { name: 'remove', description: 'Stop protecting a custom name (Admin+)', type: 1, options: [{ name: 'name', description: 'Name to remove', type: 3, required: true, max_length: 100 }] },
            { name: 'scan', description: 'Scan every member for look-alikes (Admin+)', type: 1, options: [{ name: 'rename', description: 'Rename the matches now (default: preview only)', type: 5, required: false }] },
        ],
    },
];

module.exports = { testName, addProtected, removeProtected, scanMembers, protectedSummary, onJoin, onMemberUpdate, commands, definitions, data, _internals: { compare, bestMatch, entriesFromNames } };
