const { ActivityType } = require('discord.js');

// ---------- /help ----------
// Built from the live command definitions, so every registered command always shows up (anything not listed in
// CATEGORIES lands in "Other"). The category list and the rank labels below are the only hand-written parts.
//   /help                  -> overview + a menu to browse every category
//   /help command:giveaway -> every subcommand and option of one command
const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');

const RANK = { all: '🌍', trial: '🔰 Trial+', mod: '🛡️ Mod+', admin: '⚙️ Admin+', head: '🔑 Head Admin+', owner: '👑 Owner' };
// Lowest rank needed for each command (some subcommands need more; the bot says so if you can't use one).
const TIER = {
    warn: 'trial', notes: 'trial', case: 'trial', 'case-search': 'trial', loa: 'trial', 'latest-action': 'mod',
    mod: 'mod', slowmode: 'mod', reason: 'mod', banlist: 'mod', announce: 'mod', staffstats: 'mod', confession: 'mod',
    giveaway: 'mod', poll: 'mod', analytics: 'mod', raid: 'mod', evasion: 'mod', impersonation: 'mod', timed: 'mod', vc: 'all',
    role: 'admin', nickname: 'admin', 'emoji-names': 'admin', userignore: 'admin', staffdm: 'admin', 'ping-all-staff': 'admin', messagereset: 'admin', syncstats: 'admin',
    audit: 'admin', drill: 'admin', feature: 'admin', serverstats: 'admin', force: 'admin', ticket: 'all', reactionrole: 'admin',
    addmod: 'admin', deletemod: 'admin', modlog: 'admin', setchatlog: 'admin', setloachannel: 'admin', ignorechannel: 'admin', status: 'admin',
    restart: 'head', reloaddb: 'head', strike: 'owner', strikes: 'owner', aitoggle: 'owner',
};
const CATEGORIES = [
    { id: 'fun', icon: '🎉', title: 'Everyday & Fun', cmds: ['help', 'ping', 'latest-update', 'fun', 'ship', 'diceroll', 'randomletter', 'pfp', 'userinfo', 'serverinfo', 'osqareksocials', 'afk', 'reminder', 'random', 'confess'] },
    { id: 'family', icon: '💍', title: 'Marriage & Family', cmds: ['marry', 'divorce', 'adopt', 'family', 'force'], note: 'Married people can be adopted too. `/force` (Admin+) skips the other person\'s answer.' },
    { id: 'games', icon: '🎮', title: 'Music, Games & AI', cmds: ['music', 'quiz', 'stateleaderboard', 'ask-rules', 'summarize', 'channel', 'apply'] },
    { id: 'community', icon: '🎁', title: 'Community', cmds: ['giveaway', 'poll', 'ticket', 'vc'], note: 'Giveaways can require a role, level roles, or messages today / this week / this month (`/giveaway start`, or the dashboard).' },
    { id: 'mod', icon: '👮', title: 'Moderation & Staff', cmds: ['mod', 'warn', 'case', 'case-search', 'reason', 'latest-action', 'slowmode', 'role', 'nickname', 'emoji-names', 'banlist', 'userignore', 'notes', 'loa', 'staffstats', 'staffdm', 'ping-all-staff', 'announce', 'confession', 'strike', 'strikes'] },
    { id: 'protect', icon: '🛡️', title: 'Protection & Logs', cmds: ['raid', 'drill', 'evasion', 'impersonation', 'timed', 'audit', 'analytics'] },
    { id: 'admin', icon: '⚙️', title: 'Admin & Setup', cmds: ['feature', 'serverstats', 'addmod', 'deletemod', 'modlog', 'setchatlog', 'setloachannel', 'ignorechannel', 'reactionrole', 'messagereset', 'syncstats', 'status', 'restart', 'reloaddb', 'aitoggle'] },
    {
        id: 'dash', icon: '🖥️', title: 'Dashboard-only features', cmds: [],
        text: [
            '**🎭 Reaction Roles** — embedded panels where members react with any emoji to get any role. Set up only on the dashboard (Reaction Roles page).',
            '**💸 Eco Drops** — random daily drops and manual / repeating drops with a Claim button (first click wins, drops never expire unless you set a date). Drop logging and the manual-drop form are on the Eco Drops page.',
            '**🧩 Feature Settings** — every feature\'s options (same as `/feature`).',
            '**🎉 Giveaways & Polls** — start them from the dashboard too, including level-role and message requirements.',
            '**📚 Help Center** — popular articles editor and support requests.',
        ].join('\n'),
    },
];
const TYPE_NAME = { 3: 'text', 4: 'number', 5: 'yes/no', 6: 'user', 7: 'channel', 8: 'role', 9: 'user/role', 10: 'decimal', 11: 'file' };

function allDefs() { return require('../index').commands; }
function rankOf(name) { return RANK[TIER[name] || 'all']; }
function subsOf(def) { return (def.options || []).filter((o) => o.type === 1 || o.type === 2); }

function buildPages() {
    const defs = new Map(allDefs().map((d) => [d.name, d]));
    const used = new Set(CATEGORIES.flatMap((c) => c.cmds));
    const other = [...defs.keys()].filter((n) => !used.has(n));
    const cats = other.length ? [...CATEGORIES, { id: 'other', icon: '🧩', title: 'Other', cmds: other }] : CATEGORIES;
    return cats.map((c) => {
        const lines = c.cmds.filter((n) => defs.has(n)).map((n) => {
            const d = defs.get(n); const subs = subsOf(d).map((o) => o.name);
            return `**/${n}** ${rankOf(n)} — ${d.description}${subs.length ? `\n└ ${subs.join(' · ')}` : ''}`;
        });
        const body = [c.note, lines.join('\n'), c.text].filter(Boolean).join('\n\n');
        return { id: c.id, icon: c.icon, title: c.title, count: lines.length, text: body.length > 3900 ? `${body.slice(0, 3890)}…` : body };
    });
}

const brand = () => new EmbedBuilder().setColor(0x5500FF).setFooter({ text: "OsQarek's Universe" });
function menuRow(pages, current) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('help:menu').setPlaceholder('Browse a category…').addOptions(
        { label: 'Overview', value: 'overview', emoji: '📖', default: current === 'overview' },
        ...pages.map((p) => ({ label: p.title, value: p.id, emoji: p.icon, description: p.count ? `${p.count} command${p.count === 1 ? '' : 's'}` : undefined, default: current === p.id })),
    ));
}
function pageEmbed(pages, id) {
    if (id === 'overview') {
        return brand().setTitle("🛡️ OsQarek's Universe | Help").setDescription([
            'Pick a category from the menu below, or use `/help command:<name>` for one command in detail.',
            '', ...pages.map((p) => `${p.icon} **${p.title}**${p.count ? ` — ${p.count} command${p.count === 1 ? '' : 's'}` : ''}`),
            '', `**Ranks:** ${Object.values(RANK).join(' • ')}`,
            'The rank shown is the minimum; some subcommands need more, and the bot tells you if you can\'t use one.',
        ].join('\n'));
    }
    const p = pages.find((x) => x.id === id) || pages[0];
    return brand().setTitle(`${p.icon} ${p.title}`).setDescription(p.text || '*Nothing here.*');
}

function optText(o) { return o.required ? `<${o.name}: ${TYPE_NAME[o.type] || 'value'}>` : `[${o.name}: ${TYPE_NAME[o.type] || 'value'}]`; }
function detailEmbed(def) {
    const lines = [];
    const walk = (path, node) => {
        const subs = subsOf(node);
        if (!subs.length) { lines.push(`\`/${path}${(node.options || []).length ? ' ' + node.options.map(optText).join(' ') : ''}\`${node.description && path !== def.name ? `\n└ ${node.description}` : ''}`); return; }
        subs.forEach((s) => walk(`${path} ${s.name}`, s));
    };
    walk(def.name, def);
    let text = lines.join('\n');
    if (text.length > 3800) text = `${text.slice(0, 3790)}…`;
    return brand().setTitle(`/${def.name}  ${rankOf(def.name)}`).setDescription(`${def.description}\n\n${text}\n\n\`<required>\` \`[optional]\``);
}

async function help({ interaction }) {
    const wanted = (interaction.options.getString('command') || '').replace(/^\//, '').trim().toLowerCase();
    if (wanted) {
        const defs = allDefs();
        const def = defs.find((d) => d.name === wanted) || defs.find((d) => d.name.includes(wanted));
        if (!def) return interaction.editReply(`❌ I don't have a command called \`${wanted}\`. Try \`/help\` to browse them all.`);
        return interaction.editReply({ embeds: [detailEmbed(def)] });
    }
    const pages = buildPages();
    return interaction.editReply({ embeds: [pageEmbed(pages, 'overview')], components: [menuRow(pages, 'overview')] });
}
// Category menu under /help.
help.handleMenu = async (interaction) => {
    const pages = buildPages();
    const id = interaction.values[0];
    return interaction.update({ embeds: [pageEmbed(pages, id)], components: [menuRow(pages, id)] });
};
help.buildPages = buildPages;

async function ping({ interaction, client }) {
    return interaction.editReply(`🏓 Latency: **${client.ws.ping}ms**`);
}

async function restart({ interaction, guild, user, isHeadAdmin, logAction }) {
    if (!isHeadAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply('❌ You do not have permission to restart the bot.');
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);
    logAction(guild, '🚀 Restart', `By: ${user.tag}`, 0xFF0000);
    await interaction.editReply('🚀 Restarting...');
    process.exit(0);
}

const MAX_DB_UPLOAD_BYTES = 8 * 1024 * 1024;

async function reloaddb({ interaction, options, user, guild, isHeadAdmin, reloadDatabase, logAction }) {
    if (!isHeadAdmin) return interaction.editReply('❌ You need **Head Admin+** to reload the database.');
    const source = options.getString('source') || 'auto';
    const attachment = options.getAttachment('file');
    try {
        let uploaded = null;
        if (attachment) {
            if (!/\.(txt|json)$/i.test(attachment.name || '')) return interaction.editReply('❌ Upload a `.txt` or `.json` file.');
            if (attachment.size > MAX_DB_UPLOAD_BYTES) return interaction.editReply('❌ That file is too large (8 MB max).');
            const res = await require('axios').get(attachment.url, {
                responseType: 'text',
                transformResponse: (d) => d,
                timeout: 15000,
                maxContentLength: MAX_DB_UPLOAD_BYTES,
            });
            try {
                uploaded = JSON.parse(String(res.data).replace(/^\uFEFF/, ''));
            } catch (err) {
                return interaction.editReply(`❌ That file isn't valid JSON (${err.message.slice(0, 120)}). Live database left unchanged.`);
            }
        }
        const r = await reloadDatabase(source, uploaded);
        const backup = r.backupFile ? `\nPrevious in-memory state saved to \`${r.backupFile}\`.` : '\n⚠️ Could not write a backup of the previous state.';
        const persisted = r.saved === true ? '\n💾 Saved to the persistent database.' : (r.saved === false ? '\n⚠️ Loaded in memory, but saving to the persistent database failed — run it again or check the logs.' : '');
        logAction(guild, '🔄 Database Reloaded', `**By:** ${user.tag}\n**Source:** ${r.source}\n**Top-level keys:** ${r.keys}\n**Cases:** ${r.cases}`, 0x3498DB);
        return interaction.editReply(`✅ Database reloaded from **${r.source}** (${r.keys} top-level keys, ${r.cases} cases).${persisted}${backup}`);
    } catch (err) {
        console.error('❌ /reloaddb failed:', err);
        return interaction.editReply(`❌ Reload failed, live database left unchanged: ${err.message}`);
    }
}

async function status({ interaction, options, guild, member, user, client, db, logAction }) {
    const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
    const hasPerms = member.roles.cache.some((role) => adminRoles.includes(role.id)) || member.permissions.has('Administrator');

    if (!hasPerms) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You do not have permission to change the bot's status.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const presets = {
        universe: { text: "OsQarek's Universe", type: ActivityType.Watching, presence: 'idle' },
        game: { text: "OsQarek's Universe Game on ROBLOX", type: ActivityType.Playing, presence: 'dnd' },
        help: { text: 'for /help', type: ActivityType.Listening, presence: 'online' },
        expand: { text: 'the Universe expand', type: ActivityType.Watching, presence: 'idle' },
    };
    const selected = presets[options.getString('preset')];

    if (!selected) return interaction.editReply('❌ Unknown status preset.');

    client.user.setPresence({
        activities: [{ name: selected.text, type: selected.type }],
        status: selected.presence,
    });

    if (db.modLogChannel) {
        logAction(guild, '🔄 Status Updated', `**Admin:** ${user.tag}\n**New Status:** ${selected.text}\n**Presence:** ${selected.presence}`, 0x3498DB);
    }

    return interaction.editReply(`✅ Status manually set to: **${selected.text}**`);
}

async function latestUpdate({ interaction }) {
    const updateEmbed = {
        title: "🚀 OsQarek's Universe | Bot Update v1.4.2",
        description: '**Latest stability patches and feature additions.**',
        color: 0x00FF00,
        thumbnail: { url: interaction.guild.iconURL({ dynamic: true }) },
        fields: [
            {
                name: '🛡️ Stability Fixes',
                value: '• Resolved intermittent crashes during high load.\n• Optimized database queries for faster response times.',
            },
        ],
        footer: { text: 'Universe Utilities', icon_url: interaction.user.displayAvatarURL() },
        timestamp: new Date().toISOString(),
    };

    return interaction.editReply({ embeds: [updateEmbed] });
}

module.exports = {
    help,
    ping,
    restart,
    reloaddb,
    status,
    'latest-update': latestUpdate,
};
