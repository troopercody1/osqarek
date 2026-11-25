// Marriage & family: /marry, /divorce, /adopt, /family tree | disown | leave.
//
// Data (db.features.family.people[userId]):
//   { spouse: id|null, marriedAt: ms|null, parents: [id, ...max 2], children: [id, ...] }
// Both sides of every relationship are always written together (see link()/unlink()).
// Family data is kept when someone leaves the server; names fall back to a Discord lookup.
//
// Requests are stateless: the buttons carry the two user IDs (fam:<kind>:<y|n>:<fromId>:<toId>), only the asked
// person can answer, and a request expires after the "Proposal timeout" setting (measured from the message time).
//   kinds: m = marriage proposal, a = adoption request, d = divorce confirmation (only the person who ran /divorce)
//
// Rules:
//   - Nobody marries a bot, themselves, someone already married, or a relative (parent, child, sibling,
//     grandparent, grandchild ...).
//   - A child has at most 2 parents. A married adopter's spouse becomes the co-parent automatically.
//   - You can't adopt your spouse, a relative, someone who is married, or someone who already has too many parents.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const context = require('./context');
const { getConfig } = require('./config');
const { store, brandEmbed, truncate } = require('./util');

const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_PARENTS = 2;
const TREE_LINE_CAP = 45;

function people() {
    const { db } = context.get();
    return store(db, 'family', { people: {} }).people;
}
function P(id, create = true) {
    const all = people();
    if (!all[id]) {
        if (!create) return { spouse: null, marriedAt: null, parents: [], children: [] };
        all[id] = { spouse: null, marriedAt: null, parents: [], children: [] };
    }
    const p = all[id];
    if (!Array.isArray(p.parents)) p.parents = [];
    if (!Array.isArray(p.children)) p.children = [];
    return p;
}

// ---------- relationship graph ----------
function ancestorsOf(id) {
    const seen = new Set();
    const queue = [...P(id, false).parents];
    while (queue.length) {
        const x = queue.shift();
        if (seen.has(x)) continue;
        seen.add(x);
        queue.push(...P(x, false).parents);
    }
    return seen;
}
function siblingsOf(id) {
    const out = new Set();
    for (const parent of P(id, false).parents) for (const c of P(parent, false).children) if (c !== id) out.add(c);
    return out;
}
// Blood / adoptive kin, any distance up or down the tree, plus siblings.
function isRelative(a, b) {
    if (a === b) return true;
    return ancestorsOf(a).has(b) || ancestorsOf(b).has(a) || siblingsOf(a).has(b);
}

function link(parentId, childId) {
    const parent = P(parentId), child = P(childId);
    if (!parent.children.includes(childId)) parent.children.push(childId);
    if (!child.parents.includes(parentId)) child.parents.push(parentId);
}
function unlink(parentId, childId) {
    const parent = P(parentId), child = P(childId);
    parent.children = parent.children.filter((x) => x !== childId);
    child.parents = child.parents.filter((x) => x !== parentId);
}

// ---------- replies ----------
// Errors are private; the deferred reply is public so proposals can be seen, so swap it for an ephemeral note.
async function fail(interaction, message) {
    await interaction.deleteReply().catch(() => { });
    return interaction.followUp({ content: message.startsWith('❌') ? message : `❌ ${message}`, flags: EPHEMERAL });
}
const noMentions = { parse: [] };
const mention = (id) => `<@${id}>`;

const requestRow = (kind, from, to, yesLabel, noLabel = 'Decline') => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`fam:${kind}:y:${from}:${to}`).setLabel(yesLabel).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`fam:${kind}:n:${from}:${to}`).setLabel(noLabel).setStyle(ButtonStyle.Secondary),
);

async function resolveMember(interaction, user) {
    if (!user) return null;
    return interaction.guild.members.cache.get(user.id) || await interaction.guild.members.fetch(user.id).catch(() => null);
}

// ---------- names (members may have left, so fall back to a user lookup) ----------
async function nameMap(interaction, ids) {
    const { client } = context.get();
    const out = new Map();
    let lookups = 0;
    await Promise.all([...new Set(ids)].map(async (id) => {
        const m = interaction.guild.members.cache.get(id);
        if (m) return out.set(id, m.displayName);
        const u = client.users.cache.get(id) || (lookups++ < 40 ? await client.users.fetch(id).catch(() => null) : null);
        out.set(id, u ? u.username : 'Unknown user');
    }));
    return out;
}

// ---------- commands ----------
const commands = {
    async marry({ interaction, options }) {
        const cfg = getConfig(context.get().db, 'family');
        if (!cfg.enabled) return fail(interaction, 'Marriage is turned off.');
        const me = interaction.user, target = options.getUser('user');
        const meP = P(me.id, false);
        if (target.bot) return fail(interaction, 'Bots can\'t marry. (Believe me, they\'ve tried.)');
        if (target.id === me.id) return fail(interaction, 'You can\'t marry yourself.');
        if (meP.spouse) return fail(interaction, `You\'re already married to ${mention(meP.spouse)}. Use \`/divorce\` first.`);
        if (P(target.id, false).spouse) return fail(interaction, `${target.username} is already married.`);
        if (isRelative(me.id, target.id)) return fail(interaction, 'You can\'t marry a relative.');
        if (!await resolveMember(interaction, target)) return fail(interaction, 'That person isn\'t in this server.');

        return interaction.editReply({
            content: mention(target.id), allowedMentions: { users: [target.id] },
            embeds: [brandEmbed({ title: '💍 Marriage proposal', description: `${mention(me.id)} is asking ${mention(target.id)} to marry them!\n\n${target.username}, you have ${cfg.proposalMinutes} minute${cfg.proposalMinutes === 1 ? '' : 's'} to answer.`, color: 0xEB459E })],
            components: [requestRow('m', me.id, target.id, 'Accept 💕')],
        });
    },

    async divorce({ interaction }) {
        const cfg = getConfig(context.get().db, 'family');
        if (!cfg.enabled) return fail(interaction, 'Marriage is turned off.');
        const me = interaction.user;
        const spouse = P(me.id, false).spouse;
        if (!spouse) return fail(interaction, 'You\'re not married.');
        return interaction.editReply({
            embeds: [brandEmbed({ title: '💔 Divorce', description: `${mention(me.id)}, do you really want to divorce ${mention(spouse)}?\nAny children stay with both of you.`, color: 0xED4245 })],
            components: [requestRow('d', me.id, spouse, 'Yes, divorce', 'Cancel')],
            allowedMentions: noMentions,
        });
    },

    async adopt({ interaction, options }) {
        const cfg = getConfig(context.get().db, 'family');
        if (!cfg.enabled) return fail(interaction, 'Family commands are turned off.');
        if (!cfg.allowAdoption) return fail(interaction, 'Adoption is turned off.');
        const me = interaction.user, child = options.getUser('user');
        const err = adoptionError(me.id, child.id, cfg, child.bot);
        if (err) return fail(interaction, err);
        if (!await resolveMember(interaction, child)) return fail(interaction, 'That person isn\'t in this server.');

        const spouse = P(me.id, false).spouse;
        return interaction.editReply({
            content: mention(child.id), allowedMentions: { users: [child.id] },
            embeds: [brandEmbed({ title: '🍼 Adoption request', description: `${mention(me.id)}${spouse ? ` and ${mention(spouse)}` : ''} would like to adopt ${mention(child.id)}!\n\n${child.username}, you have ${cfg.proposalMinutes} minute${cfg.proposalMinutes === 1 ? '' : 's'} to answer.`, color: 0x57F287 })],
            components: [requestRow('a', me.id, child.id, 'Accept 🤗')],
        });
    },

    async family({ interaction, options }) {
        const sub = options.getSubcommand();
        const me = interaction.user;

        if (sub === 'tree') return tree(interaction, options.getUser('user') || me);

        if (sub === 'disown') {
            const child = options.getUser('user');
            if (!P(me.id, false).children.includes(child.id)) return fail(interaction, `${child.username} isn't your child.`);
            unlink(me.id, child.id);
            await context.get().safeSave();
            return interaction.editReply({ content: `📤 ${mention(me.id)} is no longer ${mention(child.id)}'s parent.`, allowedMentions: noMentions });
        }
        if (sub === 'leave') {
            const mine = P(me.id, false);
            if (!mine.parents.length) return fail(interaction, 'You don\'t have any parents on record.');
            for (const parent of [...mine.parents]) unlink(parent, me.id);
            await context.get().safeSave();
            return interaction.editReply({ content: `🚪 ${mention(me.id)} left their family.`, allowedMentions: noMentions });
        }
        return fail(interaction, 'Unknown subcommand.');
    },
};

// Why `parentId` can't adopt `childId` right now (or null). Used when asking and again when the child accepts.
function adoptionError(parentId, childId, cfg, childIsBot = false) {
    const parentP = P(parentId, false), childP = P(childId, false);
    const spouse = parentP.spouse;
    if (childIsBot) return 'You can\'t adopt a bot.';
    if (childId === parentId) return 'You can\'t adopt yourself.';
    if (childId === spouse) return 'You can\'t adopt your spouse.';
    if (childP.spouse) return 'Married members can\'t be adopted.';
    if (childP.parents.includes(parentId)) return 'They\'re already your child.';
    if (isRelative(parentId, childId)) return 'You can\'t adopt a relative.';
    const adding = spouse ? 2 : 1;
    if (childP.parents.length + adding > MAX_PARENTS) {
        return childP.parents.length ? 'They already have parents, so there\'s no room for a new family.' : 'A child can have at most 2 parents, and you and your spouse would be 2. Try again once that\'s sorted.';
    }
    const kids = (id) => P(id, false).children.length;
    if (kids(parentId) >= cfg.maxChildren || (spouse && kids(spouse) >= cfg.maxChildren)) return `A parent can have at most ${cfg.maxChildren} children.`;
    return null;
}

// ---------- family tree ----------
async function tree(interaction, user) {
    const rootId = user.id;
    const root = P(rootId, false);

    // Gather everyone shown so their names can be looked up in one go.
    const parents = root.parents;
    const grand = parents.map((p) => [p, P(p, false).parents]);
    const sibs = [...siblingsOf(rootId)];
    const lines = [];
    const ids = new Set([rootId, ...parents, ...sibs]);
    grand.forEach(([, g]) => g.forEach((x) => ids.add(x)));
    const spouseOf = (id) => P(id, false).spouse;

    const down = [];
    const walk = (id, prefix, depth, last) => {
        if (down.length > TREE_LINE_CAP) return;
        down.push({ id, prefix, last, depth });
        if (depth >= 4) return;
        const kids = P(id, false).children;
        kids.forEach((k, i) => walk(k, prefix + (depth === 0 ? '' : (last ? '    ' : '│   ')), depth + 1, i === kids.length - 1));
    };
    // Children of the person (a married couple shares the same list, so the spouse needs no tree of their own).
    P(rootId, false).children.forEach((k, i, arr) => walk(k, '', 1, i === arr.length - 1));
    down.forEach((d) => { ids.add(d.id); const s = spouseOf(d.id); if (s) ids.add(s); });
    const rs = spouseOf(rootId);
    if (rs) ids.add(rs);

    const names = await nameMap(interaction, [...ids]);
    const nm = (id) => names.get(id) || 'Unknown user';
    const withSpouse = (id) => { const s = spouseOf(id); return s ? `${nm(id)} 💍 ${nm(s)}` : nm(id); };

    if (parents.length) {
        lines.push(`Parents: ${parents.map(nm).join(' & ')}`);
        for (const [p, g] of grand) if (g.length) lines.push(`  ${nm(p)}'s parents: ${g.map(nm).join(' & ')}`);
    }
    if (sibs.length) lines.push(`Siblings: ${sibs.map(nm).join(', ')}`);
    if (lines.length) lines.push('');
    lines.push(`🌳 ${withSpouse(rootId)}`);
    const shown = down.slice(0, TREE_LINE_CAP);
    for (const d of shown) lines.push(`${d.prefix}${d.last ? '└── ' : '├── '}${withSpouse(d.id)}`);
    if (down.length > shown.length) lines.push(`… and more`);

    const empty = !parents.length && !sibs.length && !shown.length && !rs;
    const fields = [];
    if (rs) fields.push({ name: 'Married', value: `To ${mention(rs)} since <t:${Math.floor((root.marriedAt || Date.now()) / 1000)}:D>`, inline: true });
    if (root.children.length) fields.push({ name: 'Children', value: String(root.children.length), inline: true });

    return interaction.editReply({
        embeds: [brandEmbed({
            title: `🌳 ${truncate(nm(rootId), 80)}'s family`,
            description: empty ? 'No family yet. Try `/marry` or `/adopt`!' : '```\n' + truncate(lines.join('\n'), 3500) + '\n```',
            fields, color: 0x57F287,
        })],
        allowedMentions: noMentions,
    });
}

// ---------- buttons ----------
const ID_RE = /^fam:([mad]):([yn]):(\d{15,25}):(\d{15,25})$/;

async function handleButton(interaction) {
    const m = ID_RE.exec(interaction.customId);
    if (!m) return interaction.reply({ content: '❌ That button is no longer valid.', flags: EPHEMERAL });
    const [, kind, answer, from, to] = m;
    const { db, safeSave } = context.get();
    const cfg = getConfig(db, 'family');
    const clicker = interaction.user.id;

    // Divorce is answered by whoever ran /divorce; proposals and adoptions by the person asked (either side may withdraw).
    const answerer = kind === 'd' ? from : to;
    const isWithdraw = answer === 'n' && clicker === from && kind !== 'd';
    if (clicker !== answerer && !isWithdraw) return interaction.reply({ content: '❌ This isn\'t for you.', flags: EPHEMERAL });

    const age = Date.now() - interaction.message.createdTimestamp;
    if (age > cfg.proposalMinutes * 60000) {
        return interaction.update({ content: '', embeds: [brandEmbed({ title: '⌛ Expired', description: 'This request timed out.', color: 0x95A5A6 })], components: [] });
    }

    if (answer === 'n') {
        const text = kind === 'd' ? 'Divorce cancelled.' : (isWithdraw ? `${mention(from)} withdrew their request.` : `${mention(to)} said no.`);
        return interaction.update({ content: '', embeds: [brandEmbed({ title: kind === 'd' ? '💞 Cancelled' : '💔 Declined', description: text, color: 0x95A5A6 })], components: [], allowedMentions: noMentions });
    }

    if (kind === 'm') {
        if (P(from, false).spouse || P(to, false).spouse) return interaction.update({ content: '', embeds: [brandEmbed({ title: '❌ Can\'t marry', description: 'One of you is already married.', color: 0xED4245 })], components: [] });
        if (isRelative(from, to)) return interaction.update({ content: '', embeds: [brandEmbed({ title: '❌ Can\'t marry', description: 'You\'re related now.', color: 0xED4245 })], components: [] });
        const now = Date.now();
        Object.assign(P(from), { spouse: to, marriedAt: now });
        Object.assign(P(to), { spouse: from, marriedAt: now });
        await safeSave();
        return interaction.update({ content: '', embeds: [brandEmbed({ title: '💒 Just married!', description: `${mention(from)} and ${mention(to)} are now married. Congratulations! 🎉`, color: 0xEB459E })], components: [], allowedMentions: noMentions });
    }

    if (kind === 'd') {
        const a = P(from), b = P(to);
        if (a.spouse !== to) return interaction.update({ content: '', embeds: [brandEmbed({ title: 'Already over', description: 'You\'re not married to them any more.', color: 0x95A5A6 })], components: [] });
        a.spouse = null; a.marriedAt = null; b.spouse = null; b.marriedAt = null;
        await safeSave();
        return interaction.update({ content: '', embeds: [brandEmbed({ title: '💔 Divorced', description: `${mention(from)} and ${mention(to)} are no longer married.`, color: 0xED4245 })], components: [], allowedMentions: noMentions });
    }

    if (kind === 'a') {
        const err = adoptionError(from, to, cfg);
        if (err || !cfg.allowAdoption) return interaction.update({ content: '', embeds: [brandEmbed({ title: '❌ Can\'t adopt', description: err || 'Adoption is turned off.', color: 0xED4245 })], components: [] });
        const spouse = P(from, false).spouse;
        link(from, to);
        if (spouse) link(spouse, to);
        await safeSave();
        return interaction.update({ content: '', embeds: [brandEmbed({ title: '🏡 Welcome to the family!', description: `${mention(to)} was adopted by ${mention(from)}${spouse ? ` and ${mention(spouse)}` : ''}. 💖`, color: 0x57F287 })], components: [], allowedMentions: noMentions });
    }
}

const userOpt = (description) => ({ name: 'user', description, type: 6, required: true });

const definitions = [
    { name: 'marry', description: 'Propose to someone 💍', options: [userOpt('Who to propose to')] },
    { name: 'divorce', description: 'End your marriage' },
    { name: 'adopt', description: 'Ask someone to become your child', options: [userOpt('Who to adopt')] },
    {
        name: 'family',
        description: 'Your family',
        options: [
            { name: 'tree', description: 'Show a family tree', type: 1, options: [{ name: 'user', description: 'Whose tree (default: you)', type: 6 }] },
            { name: 'disown', description: 'Remove one of your children', type: 1, options: [userOpt('Your child')] },
            { name: 'leave', description: 'Leave your parents\' family', type: 1 },
        ],
    },
];

module.exports = { commands, definitions, handleButton, isRelative, adoptionError };
