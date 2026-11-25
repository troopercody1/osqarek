// Server stats channels: locked voice channels under a "📊 Server Stats" category that show live counts.
//
//   - Turn it on (dashboard → Feature Settings, or /serverstats setup) and the bot creates the category and one
//     voice channel per enabled stat, then keeps the names up to date from the scheduler in features/index.js.
//   - Turning a stat off deletes its channel on the next run. /serverstats remove disables everything and deletes
//     the channels and the category.
//   - Discord allows 2 renames per channel per 10 minutes, so a channel is never renamed more than once every
//     5 minutes and only when its text actually changed.
//
// Stored in db.features.serverstats: { categoryId, channels: { <stat>: channelId }, names: { <stat>: { name, at } },
//                                      lastRun, sig }
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig, setValue } = require('./config');
const { store, brandEmbed } = require('./util');

const CATEGORY_NAME = '📊 Server Stats';
const MIN_RENAME_GAP_MS = 5 * 60 * 1000;
const MIN_FORCE_GAP_MS = 60 * 1000;

const num = (n) => Number(n || 0).toLocaleString('en-US');

// Each stat: the setting that turns it on, the channel name, and how to count it.
const STATS = {
    members: { setting: 'showMembers', name: (v) => `👥 Members: ${num(v)}`, value: (g) => g.memberCount },
    humans: { setting: 'showHumans', name: (v) => `🙂 Humans: ${num(v)}`, value: async (g) => (await memberCounts(g)).humans },
    bots: { setting: 'showBots', name: (v) => `🤖 Bots: ${num(v)}`, value: async (g) => (await memberCounts(g)).bots },
    boosts: { setting: 'showBoosts', name: (v) => `🚀 Boosts: ${num(v)}`, value: (g) => g.premiumSubscriptionCount || 0 },
    channels: { setting: 'showChannels', name: (v) => `💬 Channels: ${num(v)}`, value: (g, d) => countChannels(g, d) },
    roles: { setting: 'showRoles', name: (v) => `🏷️ Roles: ${num(v)}`, value: (g) => Math.max(0, g.roles.cache.size - 1) },
    tickets: { setting: 'showOpenTickets', name: (v) => `🎫 Open tickets: ${num(v)}`, value: () => openTickets() },
};
const STAT_KEYS = Object.keys(STATS);

function data() {
    const { db } = context.get();
    return store(db, 'serverstats', { categoryId: '', channels: {}, names: {}, lastRun: 0, sig: '' });
}

function openTickets() {
    const { db } = context.get();
    return (db.supportRequests || []).filter((r) => r && r.ticket && r.status !== 'solved').length;
}

function countChannels(guild, d) {
    const own = new Set(Object.values(d.channels));
    return guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread() && !own.has(c.id)).size;
}

async function memberCounts(guild) {
    const { getCachedMembers } = context.get();
    let members = guild.members.cache;
    try {
        if (getCachedMembers) members = await getCachedMembers(guild);
        else if (guild.members.cache.size < guild.memberCount) members = await guild.members.fetch();
    } catch { /* fall back to whatever is cached */ }
    let bots = 0;
    members.forEach((m) => { if (m.user.bot) bots++; });
    return { bots, humans: Math.max(0, guild.memberCount - bots) };
}

const enabledStats = (cfg) => STAT_KEYS.filter((k) => cfg[STATS[k].setting]);

// Locked for everyone: members can see the channel but cannot join it.
const lockedOverwrites = (guild) => [
    { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] },
];

async function ensureCategory(guild, d) {
    let cat = d.categoryId ? (guild.channels.cache.get(d.categoryId) || await guild.channels.fetch(d.categoryId).catch(() => null)) : null;
    if (cat && cat.type === ChannelType.GuildCategory) return cat;
    cat = await guild.channels.create({
        name: CATEGORY_NAME, type: ChannelType.GuildCategory, position: 0,
        permissionOverwrites: lockedOverwrites(guild), reason: 'Server stats channels',
    });
    d.categoryId = cat.id;
    return cat;
}

async function removeChannel(guild, id) {
    const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (ch) await ch.delete('Server stats: stat turned off').catch(() => { });
}

// Creates / renames / deletes channels so they match the settings. Returns { ok, created, renamed, removed } or { ok:false, error }.
async function reconcile(guild, { force = false } = {}) {
    const { db, saveLater } = context.get();
    const cfg = getConfig(db, 'serverstats');
    const d = data();
    if (!guild) return { ok: false, error: 'Guild unavailable.' };
    if (!cfg.enabled) return { ok: false, error: 'Server Stats is turned off.' };
    const me = guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageChannels)) return { ok: false, error: 'I need the **Manage Channels** permission.' };

    const wanted = enabledStats(cfg);
    const out = { ok: true, created: 0, renamed: 0, removed: 0 };

    // Stats that were turned off: delete their channels.
    for (const key of Object.keys(d.channels)) {
        if (wanted.includes(key) && STATS[key]) continue;
        await removeChannel(guild, d.channels[key]);
        delete d.channels[key]; delete d.names[key];
        out.removed++;
    }
    if (!wanted.length) {
        if (d.categoryId) { await removeChannel(guild, d.categoryId); d.categoryId = ''; }
        d.lastRun = Date.now(); d.sig = '';
        saveLater?.();
        return out;
    }

    let cat;
    try { cat = await ensureCategory(guild, d); } catch (err) { return { ok: false, error: `Couldn't create the category: ${err.message}` }; }

    for (const key of wanted) {
        const stat = STATS[key];
        const name = stat.name(await stat.value(guild, d));
        let ch = d.channels[key] ? (guild.channels.cache.get(d.channels[key]) || await guild.channels.fetch(d.channels[key]).catch(() => null)) : null;
        if (ch && ch.type !== ChannelType.GuildVoice) ch = null;
        try {
            if (!ch) {
                ch = await guild.channels.create({
                    name, type: ChannelType.GuildVoice, parent: cat.id,
                    permissionOverwrites: lockedOverwrites(guild), reason: 'Server stats channels',
                });
                d.channels[key] = ch.id; d.names[key] = { name, at: Date.now() };
                out.created++;
                continue;
            }
            if (ch.parentId !== cat.id) await ch.setParent(cat.id, { lockPermissions: false }).catch(() => { });
            const last = d.names[key]?.at || 0;
            if (ch.name !== name && (force || Date.now() - last >= MIN_RENAME_GAP_MS)) {
                await ch.setName(name, 'Server stats update');
                d.names[key] = { name, at: Date.now() };
                out.renamed++;
            }
        } catch (err) {
            console.error(`❌ [serverstats] ${key}:`, err.message);
        }
    }
    d.lastRun = Date.now();
    d.sig = wanted.join(',');
    saveLater?.();
    return out;
}

// Called by the scheduler every 10 seconds; does real work at most once per interval, or right away when the
// set of enabled stats changed (so ticking a box on the dashboard takes effect without waiting).
async function tick() {
    const { db } = context.get();
    const cfg = getConfig(db, 'serverstats');
    if (!cfg.enabled) return;
    const d = data();
    const sig = enabledStats(cfg).join(',');
    if (sig === d.sig && Date.now() - d.lastRun < cfg.intervalMinutes * 60000) return;
    const guild = actions.getGuild();
    if (!guild) return;
    const r = await reconcile(guild);
    if (!r.ok) { d.lastRun = Date.now(); console.error('⚠️ [serverstats]', r.error.replace(/\*\*/g, '')); }
}

async function removeAll(guild) {
    const { db, safeSave } = context.get();
    const d = data();
    let removed = 0;
    for (const id of Object.values(d.channels)) { await removeChannel(guild, id); removed++; }
    if (d.categoryId) await removeChannel(guild, d.categoryId);
    d.channels = {}; d.names = {}; d.categoryId = ''; d.sig = ''; d.lastRun = 0;
    setValue(db, 'serverstats', 'enabled', false);
    await safeSave();
    return removed;
}

const commands = {
    async serverstats({ interaction, options, isAtLeastAdmin, guild }) {
        const { db, safeSave } = context.get();
        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
        const sub = options.getSubcommand();
        guild = guild || actions.getGuild();

        if (sub === 'setup') {
            setValue(db, 'serverstats', 'enabled', true);
            await safeSave();
            const r = await reconcile(guild, { force: true });
            if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
            const cfg = getConfig(db, 'serverstats');
            return interaction.editReply({ embeds: [brandEmbed({
                title: '📊 Server Stats is on',
                description: `Showing: ${enabledStats(cfg).map((k) => `**${k}**`).join(', ') || 'nothing yet'}.\nCreated ${r.created}, renamed ${r.renamed}, removed ${r.removed}.\n\nPick which stats to show under **Dashboard → Feature Settings → Server Stats Channels**.`,
            })] });
        }
        if (sub === 'refresh') {
            const d = data();
            if (Date.now() - d.lastRun < MIN_FORCE_GAP_MS) return interaction.editReply('⏳ They were just updated. Try again in a minute (Discord limits channel renames).');
            const r = await reconcile(guild, { force: true });
            return interaction.editReply(r.ok ? `✅ Refreshed. Created ${r.created}, renamed ${r.renamed}, removed ${r.removed}.` : `❌ ${r.error}`);
        }
        if (sub === 'remove') {
            const n = await removeAll(guild);
            return interaction.editReply(`🗑️ Server Stats turned off and ${n} stat channel${n === 1 ? '' : 's'} deleted.`);
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'serverstats',
        description: 'Live server stat channels (Admin+)',
        options: [
            { name: 'setup', description: 'Turn stat channels on and create them', type: 1 },
            { name: 'refresh', description: 'Update the stat channels now', type: 1 },
            { name: 'remove', description: 'Turn stat channels off and delete them', type: 1 },
        ],
    },
];

module.exports = { tick, reconcile, removeAll, commands, definitions, STATS };
