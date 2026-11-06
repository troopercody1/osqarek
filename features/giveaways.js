// Giveaways: button entry, timed ending, role requirements, rerolls.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, parseDuration, formatDuration, shuffle, ts, truncate } = require('./util');

const MIN_MS = 30 * 1000;
const FINISHED_KEEP = 100;
const COUNT_REFRESH_MS = 60 * 1000;
const lastEdit = new Map(); // giveawayId -> ms of last count refresh

function data() {
    const { db } = context.get();
    return store(db, 'giveaways', { items: [], nextId: 1 });
}

const find = (id) => data().items.find((g) => g.id === id) || null;

// ---------- rendering ----------
function buildEmbed(g) {
    const active = g.status === 'active';
    const fields = [
        { name: active ? 'Ends' : (g.status === 'cancelled' ? 'Cancelled' : 'Ended'), value: active ? `${ts(g.endsAt)} (${ts(g.endsAt, 'f')})` : ts(g.endedAt || g.endsAt), inline: true },
        { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true },
        { name: 'Winners', value: String(g.winnersCount), inline: true },
        { name: 'Entries', value: String(g.entries.length), inline: true },
    ];
    if (g.requiredRoleId) fields.push({ name: 'Requirement', value: `Must have <@&${g.requiredRoleId}>`, inline: true });
    if (g.status === 'ended') {
        fields.push({ name: g.winners.length === 1 ? 'Winner' : 'Winners', value: g.winners.length ? g.winners.map((id) => `<@${id}>`).join(', ') : 'No valid entries' });
    }
    return brandEmbed({
        title: `🎉 ${g.prize}`,
        description: active ? 'Press the button below to enter!' : (g.status === 'cancelled' ? 'This giveaway was cancelled.' : 'This giveaway has ended.'),
        color: active ? 0xF1C40F : (g.status === 'cancelled' ? 0x95A5A6 : 0x2ECC71),
        fields,
        footer: `Giveaway #${g.id}`,
        timestamp: false,
    });
}

function buildComponents(g) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:e:${g.id}`).setLabel('Enter').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(g.status !== 'active'),
    )];
}

async function fetchMessage(g) {
    const { client } = context.get();
    const ch = client.channels.cache.get(g.channelId) || await client.channels.fetch(g.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return { ch: null, msg: null };
    const msg = await ch.messages.fetch(g.messageId).catch(() => null);
    return { ch, msg };
}

async function refreshMessage(g) {
    const { msg } = await fetchMessage(g);
    if (msg) await msg.edit({ embeds: [buildEmbed(g)], components: buildComponents(g) }).catch((err) => console.error('❌ Giveaway edit failed:', err.message));
}

// ---------- winners ----------
async function pickWinners(guild, g, count, exclude = []) {
    const skip = new Set(exclude);
    const winners = [];
    for (const id of shuffle(g.entries)) {
        if (winners.length >= count) break;
        if (skip.has(id)) continue;
        const m = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
        if (!m || m.user.bot) continue;
        if (g.requiredRoleId && !m.roles.cache.has(g.requiredRoleId)) continue;
        winners.push(id);
    }
    return winners;
}

async function announce(g, winners, { reroll = false } = {}) {
    const { db } = context.get();
    const cfg = getConfig(db, 'giveaways');
    const { ch, msg } = await fetchMessage(g);
    if (ch) {
        const text = winners.length
            ? `🎉 ${reroll ? 'New winner' : 'Congratulations'}${winners.length > 1 ? 's' : ''} ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${g.prize}**!`
            : `😕 No valid entries for **${g.prize}**${reroll ? ' this time' : ''}.`;
        const payload = { content: text, allowedMentions: { users: winners } };
        if (msg) await msg.reply(payload).catch(() => ch.send(payload).catch(() => { }));
        else await ch.send(payload).catch(() => { });
    }
    if (cfg.dmWinners) {
        const { client } = context.get();
        for (const id of winners) {
            const u = await client.users.fetch(id).catch(() => null);
            if (u) await u.send({ embeds: [brandEmbed({ title: '🎉 You won a giveaway!', color: 0x2ECC71, description: `You won **${g.prize}** in **${actions.getGuild()?.name || 'the server'}**.${msg ? `\n[Jump to the giveaway](${msg.url})` : ''}` })] }).catch(() => { });
        }
    }
}

async function endGiveaway(g, { by = 'timer' } = {}) {
    const { db } = context.get();
    const guild = actions.getGuild();
    if (g.status !== 'active') return false;
    g.status = 'ended';
    g.endedAt = Date.now();
    g.winners = guild ? await pickWinners(guild, g, g.winnersCount) : [];
    recordEvent(db, 'giveaway', `Giveaway #${g.id} "${truncate(g.prize, 40)}" ended (${by}) — ${g.winners.length} winner(s) from ${g.entries.length} entries`);
    await refreshMessage(g);
    await announce(g, g.winners);
    await context.get().safeSave();
    return true;
}

async function cancelGiveaway(g, by) {
    if (g.status !== 'active') return false;
    g.status = 'cancelled';
    g.endedAt = Date.now();
    recordEvent(context.get().db, 'giveaway', `Giveaway #${g.id} cancelled by ${by}`);
    await refreshMessage(g);
    await context.get().safeSave();
    return true;
}

async function reroll(g, count) {
    const guild = actions.getGuild();
    if (g.status !== 'ended') return { error: 'That giveaway hasn\'t ended yet.' };
    const winners = await pickWinners(guild, g, count, g.winners);
    g.winners = [...g.winners, ...winners];
    g.rerolls = (g.rerolls || 0) + 1;
    await announce(g, winners, { reroll: true });
    await context.get().safeSave();
    return { winners };
}

// ---------- scheduler ----------
async function tick() {
    const d = data();
    const now = Date.now();
    for (const g of d.items) {
        if (g.status !== 'active') continue;
        if (g.endsAt <= now) { await endGiveaway(g).catch((err) => console.error('❌ Giveaway end failed:', err.message)); continue; }
        if (g.entries.length !== (g.shownCount ?? -1) && now - (lastEdit.get(g.id) || 0) >= COUNT_REFRESH_MS) {
            lastEdit.set(g.id, now);
            g.shownCount = g.entries.length;
            await refreshMessage(g);
        }
    }
    const finished = d.items.filter((g) => g.status !== 'active');
    if (finished.length > FINISHED_KEEP) {
        const drop = new Set(finished.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)).slice(0, finished.length - FINISHED_KEEP).map((g) => g.id));
        d.items = d.items.filter((g) => !drop.has(g.id));
    }
}

// ---------- buttons ----------
async function handleButton(interaction) {
    const { db } = context.get();
    const cfg = getConfig(db, 'giveaways');
    const [, kind, idStr] = interaction.customId.split(':');
    const g = find(parseInt(idStr, 10));
    const eph = { flags: MessageFlags.Ephemeral };

    if (!g || g.status !== 'active' || g.endsAt <= Date.now()) return interaction.reply({ content: '⏹️ This giveaway has ended.', ...eph });

    if (kind === 'l') {
        g.entries = g.entries.filter((id) => id !== interaction.user.id);
        await context.get().safeSave();
        return interaction.update({ content: '👋 You left the giveaway.', components: [] });
    }

    if (!cfg.enabled) return interaction.reply({ content: '🚫 Giveaways are currently disabled.', ...eph });
    if (g.entries.includes(interaction.user.id)) {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gw:l:${g.id}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: '✅ You\'re already entered.', components: [row], ...eph });
    }
    if (g.requiredRoleId && !interaction.member.roles.cache.has(g.requiredRoleId)) {
        return interaction.reply({ content: `❌ You need the <@&${g.requiredRoleId}> role to enter.`, allowedMentions: { parse: [] }, ...eph });
    }
    if (cfg.minAccountDays > 0 && (Date.now() - interaction.user.createdTimestamp) / 86400000 < cfg.minAccountDays) {
        return interaction.reply({ content: `❌ Your account must be at least ${cfg.minAccountDays} days old to enter.`, ...eph });
    }
    g.entries.push(interaction.user.id);
    context.get().saveLater?.();
    return interaction.reply({ content: `🎉 You're in! Good luck. (${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'})`, ...eph });
}

// ---------- start (used by the slash command AND the dashboard) ----------
async function startGiveaway(guild, { prize, when, winners = 1, roleId = null, channelId = null, host }) {
    const { db } = context.get();
    const cfg = getConfig(db, 'giveaways');
    const d = data();
    const err = (error) => ({ ok: false, error });
    if (!cfg.enabled) return err('Giveaways are disabled (`/feature enable giveaways`).');
    if (!prize || !String(prize).trim()) return err('A prize is required.');
    const ms = parseDuration(when);
    if (!ms) return err('Couldn\'t read that duration. Try `30m`, `12h`, `3d`, `1w`.');
    if (ms < MIN_MS) return err('Minimum is 30 seconds.');
    if (ms > cfg.maxDays * 86400000) return err(`Maximum is ${cfg.maxDays} days.`);
    if (!(winners >= 1) || winners > cfg.maxWinners) return err(`Winners must be between 1 and ${cfg.maxWinners}.`);
    if (roleId && !guild.roles.cache.get(roleId)) return err('Required role not found.');
    const target = guild.channels.cache.get(channelId || cfg.defaultChannel || '');
    if (!target?.isTextBased()) return err('Pick a text channel for the giveaway.');
    const perms = target.permissionsFor(guild.members.me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
        return err(`I need View Channel, Send Messages and Embed Links in #${target.name}.`);
    }
    const g = {
        id: d.nextId++, channelId: target.id, messageId: null, prize: truncate(String(prize).trim(), 200), hostId: host.id, hostTag: host.tag,
        endsAt: Date.now() + ms, winnersCount: winners, requiredRoleId: roleId || null, entries: [], status: 'active', winners: [], createdAt: Date.now(), shownCount: 0,
    };
    const msg = await target.send({ embeds: [buildEmbed(g)], components: buildComponents(g), allowedMentions: { parse: [] } }).catch((e) => { console.error('❌ Giveaway post failed:', e.message); return null; });
    if (!msg) { d.nextId--; return err('I couldn\'t post in that channel.'); }
    g.messageId = msg.id;
    d.items.push(g);
    recordEvent(db, 'giveaway', `Giveaway #${g.id} "${truncate(g.prize, 40)}" started by ${host.tag}`);
    await context.get().safeSave();
    return { ok: true, g, msg };
}

// ---------- slash command ----------
const commands = {
    async giveaway({ interaction, options, guild, user, channel, isMod, isAtLeastAdmin }) {
        const { db } = context.get();
        const cfg = getConfig(db, 'giveaways');
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        const sub = options.getSubcommand();
        const d = data();

        if (sub === 'start') {
            const r = await startGiveaway(guild, {
                prize: options.getString('prize'), when: options.getString('duration'), winners: options.getInteger('winners') || 1,
                roleId: options.getRole('required_role')?.id || null, channelId: options.getChannel('channel')?.id || channel.id, host: { id: user.id, tag: user.tag },
            });
            return interaction.editReply(r.ok ? `✅ Giveaway **#${r.g.id}** started in <#${r.g.channelId}> — ends ${ts(r.g.endsAt)}. [Jump](${r.msg.url})` : `❌ ${r.error}`);
        }

        if (sub === 'list') {
            const active = d.items.filter((g) => g.status === 'active');
            const recent = d.items.filter((g) => g.status !== 'active').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
            const fmt = (g) => `**#${g.id}** ${truncate(g.prize, 50)} — ${g.status === 'active' ? `ends ${ts(g.endsAt)}` : g.status} — ${g.entries.length} entries — <#${g.channelId}>`;
            const desc = [`**Active (${active.length})**`, ...(active.length ? active.map(fmt) : ['*none*']), '', '**Recently finished**', ...(recent.length ? recent.map(fmt) : ['*none*'])].join('\n');
            return interaction.editReply({ embeds: [brandEmbed({ title: '🎉 Giveaways', description: desc })] });
        }

        const g = find(options.getInteger('id'));
        if (!g) return interaction.editReply('❌ No giveaway with that ID. Use `/giveaway list`.');

        if (sub === 'end') {
            if (g.status !== 'active') return interaction.editReply(`ℹ️ Giveaway #${g.id} is already ${g.status}.`);
            await endGiveaway(g, { by: user.tag });
            return interaction.editReply(`✅ Ended **#${g.id}** — winner(s): ${g.winners.length ? g.winners.map((id) => `<@${id}>`).join(', ') : 'none (no valid entries)'}.`);
        }
        if (sub === 'cancel') {
            if (g.status !== 'active') return interaction.editReply(`ℹ️ Giveaway #${g.id} is already ${g.status}.`);
            if (g.hostId !== user.id && !isAtLeastAdmin) return interaction.editReply('❌ Only the host or an Admin+ can cancel it.');
            await cancelGiveaway(g, user.tag);
            return interaction.editReply(`✅ Cancelled giveaway **#${g.id}**.`);
        }
        if (sub === 'reroll') {
            const r = await reroll(g, options.getInteger('count') || 1);
            if (r.error) return interaction.editReply(`❌ ${r.error}`);
            return interaction.editReply(r.winners.length ? `✅ Rerolled — new winner(s): ${r.winners.map((id) => `<@${id}>`).join(', ')}.` : 'ℹ️ No more valid entries to pick from.');
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'giveaway',
        description: 'Run giveaways',
        options: [
            { name: 'start', description: 'Start a giveaway', type: 1, options: [
                { name: 'prize', description: 'What is being given away', type: 3, required: true, max_length: 200 },
                { name: 'duration', description: 'e.g. 30m, 12h, 3d', type: 3, required: true },
                { name: 'winners', description: 'Number of winners (default 1)', type: 4, required: false, min_value: 1, max_value: 25 },
                { name: 'required_role', description: 'Only members with this role can enter', type: 8, required: false },
                { name: 'channel', description: 'Where to post it (default: current / configured channel)', type: 7, required: false, channel_types: [0, 5] },
            ] },
            { name: 'end', description: 'End a giveaway now and pick winners', type: 1, options: [{ name: 'id', description: 'Giveaway number', type: 4, required: true, min_value: 1 }] },
            { name: 'reroll', description: 'Pick new winner(s) for an ended giveaway', type: 1, options: [{ name: 'id', description: 'Giveaway number', type: 4, required: true, min_value: 1 }, { name: 'count', description: 'How many (default 1)', type: 4, required: false, min_value: 1, max_value: 25 }] },
            { name: 'cancel', description: 'Cancel an active giveaway', type: 1, options: [{ name: 'id', description: 'Giveaway number', type: 4, required: true, min_value: 1 }] },
            { name: 'list', description: 'List active and recent giveaways', type: 1 },
        ],
    },
];

module.exports = { startGiveaway, tick, handleButton, endGiveaway, cancelGiveaway, reroll, find, data, buildEmbed, pickWinners, commands, definitions };
