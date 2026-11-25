// Polls: button voting, multi-choice, anonymous results, timed closing.
// Replaces the old single-question /poll. The old behaviour lives on as /poll quick.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const context = require('./context');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, parseDuration, formatDuration, ts, truncate } = require('./util');

const MIN_MS = 30 * 1000;
const FINISHED_KEEP = 100;
const REFRESH_DEBOUNCE_MS = 1500;
const refreshTimers = new Map(); // pollId -> timeout

function data() {
    const { db } = context.get();
    return store(db, 'polls', { items: [], nextId: 1 });
}

const find = (id) => data().items.find((p) => p.id === id) || null;

// ---------- tallies & rendering ----------
function tally(p) {
    const counts = p.options.map(() => 0);
    let voters = 0;
    for (const picks of Object.values(p.votes)) {
        if (!picks.length) continue;
        voters++;
        for (const i of picks) if (counts[i] !== undefined) counts[i]++;
    }
    return { counts, voters, totalVotes: counts.reduce((a, b) => a + b, 0) };
}

function bar(pct, width = 10) {
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildEmbed(p) {
    const { counts, voters, totalVotes } = tally(p);
    const lines = p.options.map((opt, i) => {
        const pct = totalVotes ? Math.round((counts[i] / totalVotes) * 100) : 0;
        return `**${i + 1}.** ${opt}\n${bar(pct)} **${pct}%** (${counts[i]})`;
    });
    const open = p.status === 'active';
    const meta = [
        p.multi ? 'Multiple choice' : 'Single choice',
        p.anonymous ? 'Anonymous' : 'Votes are public',
        `${voters} voter${voters === 1 ? '' : 's'}`,
    ].join(' • ');
    const fields = [];
    if (open && p.endsAt) fields.push({ name: 'Closes', value: `${ts(p.endsAt)} (${ts(p.endsAt, 'f')})` });
    if (!open) fields.push({ name: 'Status', value: `Closed ${ts(p.closedAt || Date.now())}` });
    return brandEmbed({
        title: `📊 ${p.question}`,
        description: lines.join('\n\n'),
        color: open ? 0x9B59B6 : 0x95A5A6,
        fields,
        footer: `${meta} • Poll #${p.id}`,
        timestamp: false,
    });
}

function buildComponents(p) {
    const rows = [];
    for (let start = 0; start < p.options.length; start += 5) {
        const row = new ActionRowBuilder();
        p.options.slice(start, start + 5).forEach((opt, j) => {
            const i = start + j;
            row.addComponents(new ButtonBuilder().setCustomId(`poll:v:${p.id}:${i}`).setLabel(truncate(`${i + 1}. ${opt}`, 80)).setStyle(ButtonStyle.Primary).setDisabled(p.status !== 'active'));
        });
        rows.push(row);
    }
    return rows;
}

async function fetchMessage(p) {
    const { client } = context.get();
    const ch = client.channels.cache.get(p.channelId) || await client.channels.fetch(p.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return { ch: null, msg: null };
    const msg = await ch.messages.fetch(p.messageId).catch(() => null);
    return { ch, msg };
}

async function refreshMessage(p) {
    const { msg } = await fetchMessage(p);
    if (msg) await msg.edit({ embeds: [buildEmbed(p)], components: buildComponents(p) }).catch((err) => console.error('❌ Poll edit failed:', err.message));
}

function scheduleRefresh(p) {
    if (refreshTimers.has(p.id)) return;
    refreshTimers.set(p.id, setTimeout(() => {
        refreshTimers.delete(p.id);
        refreshMessage(p).catch(() => { });
    }, REFRESH_DEBOUNCE_MS));
}

async function closePoll(p, { by = 'timer' } = {}) {
    if (p.status !== 'active') return false;
    p.status = 'closed';
    p.closedAt = Date.now();
    if (refreshTimers.has(p.id)) { clearTimeout(refreshTimers.get(p.id)); refreshTimers.delete(p.id); }
    recordEvent(context.get().db, 'poll', `Poll #${p.id} "${truncate(p.question, 40)}" closed (${by})`);
    await refreshMessage(p);
    if (by === 'timer') {
        const { ch, msg } = await fetchMessage(p);
        if (ch) {
            const payload = { content: '📊 This poll has closed — final results are above.', allowedMentions: { parse: [] } };
            if (msg) await msg.reply(payload).catch(() => { }); else await ch.send(payload).catch(() => { });
        }
    }
    await context.get().safeSave();
    return true;
}

async function tick() {
    const d = data();
    const now = Date.now();
    for (const p of d.items) {
        if (p.status === 'active' && p.endsAt && p.endsAt <= now) await closePoll(p).catch((err) => console.error('❌ Poll close failed:', err.message));
    }
    const finished = d.items.filter((p) => p.status !== 'active');
    if (finished.length > FINISHED_KEEP) {
        const drop = new Set(finished.sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0)).slice(0, finished.length - FINISHED_KEEP).map((p) => p.id));
        d.items = d.items.filter((p) => !drop.has(p.id));
    }
}

// ---------- voting ----------
async function handleButton(interaction) {
    const { db } = context.get();
    const cfg = getConfig(db, 'polls');
    const [, , idStr, idxStr] = interaction.customId.split(':');
    const p = find(parseInt(idStr, 10));
    const idx = parseInt(idxStr, 10);
    const eph = { flags: MessageFlags.Ephemeral };

    if (!p || p.status !== 'active' || (p.endsAt && p.endsAt <= Date.now())) return interaction.reply({ content: '⏹️ This poll is closed.', ...eph });
    if (!cfg.enabled) return interaction.reply({ content: '🚫 Polls are currently disabled.', ...eph });
    if (!(idx >= 0 && idx < p.options.length)) return interaction.reply({ content: '❌ That option doesn\'t exist.', ...eph });

    const uid = interaction.user.id;
    const current = p.votes[uid] || [];
    let next;
    let message;

    if (current.length && !cfg.allowChangeVote) {
        return interaction.reply({ content: '🔒 You\'ve already voted and votes can\'t be changed.', ...eph });
    }
    if (p.multi) {
        next = current.includes(idx) ? current.filter((i) => i !== idx) : [...current, idx];
    } else {
        next = current.includes(idx) ? [] : [idx];
    }
    if (next.length) p.votes[uid] = next; else delete p.votes[uid];

    if (!next.length) message = '↩️ Your vote was removed.';
    else message = `✅ Your vote${next.length > 1 ? 's' : ''}: ${next.map((i) => `**${truncate(p.options[i], 60)}**`).join(', ')}`;

    context.get().saveLater?.();
    scheduleRefresh(p);
    return interaction.reply({ content: message, ...eph });
}

// ---------- slash command ----------
function parseOptions(raw, max) {
    const opts = String(raw).split(/[|\n]/).map((s) => s.trim()).filter(Boolean);
    const unique = [...new Set(opts)];
    if (unique.length < 2) return { error: '❌ A poll needs at least 2 different options, separated by `|` — e.g. `Pizza | Tacos | Sushi`.' };
    if (unique.length > max) return { error: `❌ Maximum is ${max} options.` };
    if (unique.some((o) => o.length > 70)) return { error: '❌ Each option must be 70 characters or fewer.' };
    return { options: unique };
}

// ---------- create (used by the slash command AND the dashboard) ----------
// `post(payload)` must send the poll message and resolve to it. The slash command
// passes interaction.editReply; the dashboard passes channel.send.
async function createPoll({ channel, question, optionsRaw, when, multi = false, anonymous = null, by, post }) {
    const { db } = context.get();
    const cfg = getConfig(db, 'polls');
    const d = data();
    const err = (error) => ({ ok: false, error });
    if (!cfg.enabled) return err('Polls are disabled (`/feature enable polls`).');
    if (!question || !String(question).trim()) return err('A question is required.');
    const parsed = parseOptions(optionsRaw, cfg.maxOptions);
    if (parsed.error) return err(parsed.error.replace(/^❌ /, ''));
    let endsAt = null;
    if (when) {
        const ms = parseDuration(when);
        if (!ms) return err('Couldn\'t read that duration. Try `30m`, `12h`, `3d`.');
        if (ms < MIN_MS) return err('Minimum is 30 seconds.');
        if (ms > cfg.maxDays * 86400000) return err(`Maximum is ${cfg.maxDays} days.`);
        endsAt = Date.now() + ms;
    }
    const p = {
        id: d.nextId++, channelId: channel.id, messageId: null, question: truncate(String(question).trim(), 250), options: parsed.options,
        votes: {}, multi: !!multi, anonymous: anonymous ?? cfg.defaultAnonymous, endsAt, status: 'active',
        createdBy: by.id, createdByTag: by.tag, createdAt: Date.now(), closedAt: null,
    };
    let msg;
    try { msg = await post({ embeds: [buildEmbed(p)], components: buildComponents(p), allowedMentions: { parse: [] } }); }
    catch (e) { d.nextId--; return err(`I couldn't post the poll: ${e.message}`); }
    p.messageId = msg.id;
    d.items.push(p);
    recordEvent(db, 'poll', `Poll #${p.id} "${truncate(p.question, 40)}" created by ${by.tag}`);
    await context.get().safeSave();
    return { ok: true, p, msg };
}

const commands = {
    async poll({ interaction, options, guild, user, channel, isMod }) {
        const { db } = context.get();
        const sub = options.getSubcommand();

        // Legacy behaviour: one question, 👍 / 👎 reactions.
        if (sub === 'quick') {
            if (db.utilitiesEnabled === false) return interaction.editReply('🚫 The Utilities module is currently disabled.');
            const embed = new EmbedBuilder().setTitle('📊 New Poll').setDescription(options.getString('question')).setColor(0x9B59B6).setFooter({ text: `Asked by ${user.username}` });
            const message = await interaction.editReply({ embeds: [embed], fetchReply: true });
            await message.react('👍').catch(() => { });
            await message.react('👎').catch(() => { });
            return;
        }

        const cfg = getConfig(db, 'polls');
        const d = data();

        if (sub === 'create') {
            const r = await createPoll({
                channel, question: options.getString('question'), optionsRaw: options.getString('options'), when: options.getString('duration'),
                multi: options.getBoolean('multi') ?? false, anonymous: options.getBoolean('anonymous'), by: { id: user.id, tag: user.tag },
                post: (payload) => interaction.editReply({ ...payload, fetchReply: true }),
            });
            if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
            return;
        }

        if (sub === 'list') {
            const active = d.items.filter((p) => p.status === 'active');
            if (!active.length) return interaction.editReply('ℹ️ No active polls.');
            const lines = active.slice(0, 15).map((p) => `**#${p.id}** [${truncate(p.question, 60)}](https://discord.com/channels/${guild.id}/${p.channelId}/${p.messageId}) — ${tally(p).voters} voters${p.endsAt ? ` — closes ${ts(p.endsAt)}` : ''}`);
            return interaction.editReply({ embeds: [brandEmbed({ title: '📊 Active polls', description: lines.join('\n') })] });
        }

        const p = find(options.getInteger('id'));
        if (!p) return interaction.editReply('❌ No poll with that ID. Use `/poll list`.');

        if (sub === 'end') {
            if (p.status !== 'active') return interaction.editReply(`ℹ️ Poll #${p.id} is already closed.`);
            if (p.createdBy !== user.id && !isMod) return interaction.editReply('❌ Only the poll\'s creator or a Moderator+ can end it.');
            await closePoll(p, { by: user.tag });
            return interaction.editReply(`✅ Poll **#${p.id}** closed.`);
        }

        if (sub === 'results') {
            const { counts, voters, totalVotes } = tally(p);
            const lines = p.options.map((opt, i) => {
                const pct = totalVotes ? Math.round((counts[i] / totalVotes) * 100) : 0;
                let line = `**${i + 1}. ${opt}** — ${counts[i]} (${pct}%)`;
                if (!p.anonymous && counts[i]) {
                    const who = Object.entries(p.votes).filter(([, picks]) => picks.includes(i)).map(([uid]) => `<@${uid}>`);
                    line += `\n${truncate(who.slice(0, 25).join(' '), 400)}${who.length > 25 ? ` +${who.length - 25} more` : ''}`;
                }
                return line;
            });
            return interaction.editReply({ embeds: [brandEmbed({ title: `📊 ${p.question}`, description: lines.join('\n\n'), footer: `${voters} voter${voters === 1 ? '' : 's'} • ${p.status === 'active' ? 'open' : 'closed'} • ${p.anonymous ? 'anonymous' : 'public votes'}` })], allowedMentions: { parse: [] } });
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'poll',
        description: 'Create and manage polls',
        options: [
            { name: 'create', description: 'Create a button-vote poll', type: 1, options: [
                { name: 'question', description: 'What are you asking?', type: 3, required: true, max_length: 250 },
                { name: 'options', description: 'Choices separated by |  (e.g. Pizza | Tacos | Sushi)', type: 3, required: true, max_length: 900 },
                { name: 'duration', description: 'Auto-close after, e.g. 1h, 2d (default: stays open)', type: 3, required: false },
                { name: 'multi', description: 'Allow picking more than one option', type: 5, required: false },
                { name: 'anonymous', description: 'Hide who voted for what (default from settings)', type: 5, required: false },
            ] },
            { name: 'quick', description: 'Simple yes/no poll with 👍 / 👎 reactions', type: 1, options: [{ name: 'question', description: 'The question to ask', type: 3, required: true }] },
            { name: 'end', description: 'Close a poll and lock in the results', type: 1, options: [{ name: 'id', description: 'Poll number', type: 4, required: true, min_value: 1 }] },
            { name: 'results', description: 'Show a poll\'s results', type: 1, options: [{ name: 'id', description: 'Poll number', type: 4, required: true, min_value: 1 }] },
            { name: 'list', description: 'List active polls', type: 1 },
        ],
    },
];

module.exports = { createPoll, tick, handleButton, closePoll, find, data, tally, buildEmbed, parseOptions, commands, definitions };
