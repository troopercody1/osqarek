// Tickets (TicketTool-style) that are also Help Center requests.
//
// A member presses a button on the panel, fills in a short form, and gets a private channel. At the same moment a
// normal Help Center request (db.supportRequests[], "SR-XXXXXX") is created for them, flagged with `ticket: {...}`,
// so it appears on the website under "My Help Requests" with its status, Created and Last activity dates, and in
// Settings → Support requests for staff.
//
// Sync (both ways, until the ticket is closed):
//   Discord channel → Help Center   member messages = "member", staff messages = "staff"; member message sets the
//                                   status to Open, staff message sets it to "Awaiting your reply".
//   Help Center → Discord channel   replies made on the website (member or staff) and status events are posted in
//                                   the channel; marking the request Solved on the website closes the ticket.
//   Closing a ticket (button or /ticket close) marks the request Solved, posts a transcript to the log channel,
//   DMs it to the member, and deletes the channel after a short delay. The conversation stays in the Help Center.
//   If the member replies on the website afterwards the request reopens there (there is no channel any more).
//
// db.supportRequests[].ticket = { number, category, channelId, claimedBy, closedAt, closedBy, deleteAt }
// db.features.tickets        = { nextNumber, categoryId }
const crypto = require('crypto');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelType, PermissionFlagsBits, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, truncate } = require('./util');
const support = require('./support');

const EPHEMERAL = MessageFlags.Ephemeral;
const CATEGORY_NAME = '🎫 Tickets';
const MAX_PANEL_BUTTONS = 5;

const noMentions = { parse: [] };
const newMsgId = () => 'm' + crypto.randomBytes(4).toString('hex');
const clean = (v, max) => String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

function data() {
    const { db } = context.get();
    return store(db, 'tickets', { nextNumber: 1, categoryId: '' });
}
function requests() {
    const { db } = context.get();
    if (!Array.isArray(db.supportRequests)) db.supportRequests = [];
    return db.supportRequests;
}
const byChannel = (channelId) => requests().find((r) => r && r.ticket && r.ticket.channelId === channelId) || null;
const byId = (id) => requests().find((r) => r && r.id === id) || null;
const realMessages = (r) => (r.messages || []).filter((m) => m.from !== 'system').length;
const isLive = (r) => r.ticket && r.ticket.channelId && !r.ticket.closedAt;

function pushMessage(r, from, name, body, extra = {}) {
    support.normalize(r);
    const at = Date.now();
    r.messages.push({ id: newMsgId(), from, name, body, at, ...extra });
    r.updatedAt = at;
}
function setStatus(r, status) {
    r.status = status;
    r.updatedAt = Date.now();
}

// ---------- who counts as support staff ----------
function supportRoleId() { return getConfig(context.get().db, 'tickets').supportRole || ''; }
function isTicketStaff(member, guild) {
    if (!member) return false;
    const rid = supportRoleId();
    return actions.isStaff(member, guild) || (rid && member.roles.cache.has(rid)) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}
function staffRoleIds(guild) {
    const { STAFF_ROLE_IDS } = context.get();
    const ids = new Set(Object.values(STAFF_ROLE_IDS || {}));
    const extra = supportRoleId();
    if (extra) ids.add(extra);
    return [...ids].filter((id) => guild.roles.cache.has(id)); // an overwrite for a role that no longer exists makes channel creation fail
}

// ---------- links ----------
const threadUrl = (r) => `${context.get().baseUrl || ''}/support/requests/${r.id}`;

// ---------- the ticket category ----------
async function ensureCategory(guild) {
    const d = data();
    let cat = d.categoryId ? (guild.channels.cache.get(d.categoryId) || await guild.channels.fetch(d.categoryId).catch(() => null)) : null;
    if (cat && cat.type === ChannelType.GuildCategory) return cat;
    cat = await guild.channels.create({
        name: CATEGORY_NAME, type: ChannelType.GuildCategory,
        permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages] },
            ...staffRoleIds(guild).map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        ],
        reason: 'Ticket category',
    });
    d.categoryId = cat.id;
    return cat;
}

// ---------- panel ----------
function categories(cfg) {
    const list = (cfg.categories || []).map((c) => clean(c, 80)).filter(Boolean).slice(0, MAX_PANEL_BUTTONS);
    return list.length ? list : ['Support'];
}
function panelComponents(cfg) {
    const list = categories(cfg);
    const single = list.length === 1 && list[0] === 'Support' && !(cfg.categories || []).length;
    return [new ActionRowBuilder().addComponents(list.map((label, i) =>
        new ButtonBuilder().setCustomId(`tk:new:${i}`).setLabel(single ? 'Open a ticket' : label).setEmoji('🎫').setStyle(ButtonStyle.Primary)))];
}

const ticketButtons = (claimed, cfg) => {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
    if (cfg.allowClaim) row.addComponents(new ButtonBuilder().setCustomId('tk:claim').setLabel(claimed ? 'Claimed' : 'Claim').setEmoji('🙋').setStyle(ButtonStyle.Secondary).setDisabled(!!claimed));
    return [row];
};

// ---------- opening a ticket ----------
function openCountFor(userId) {
    return requests().filter((r) => isLive(r) && r.discordId === userId).length;
}

async function startTicket(interaction, idx) {
    const { db } = context.get();
    const cfg = getConfig(db, 'tickets');
    if (!cfg.enabled) return interaction.reply({ content: '❌ Tickets are turned off right now.', flags: EPHEMERAL });
    const mine = requests().filter((r) => isLive(r) && r.discordId === interaction.user.id);
    if (mine.length >= cfg.maxOpenPerUser) {
        const list = mine.map((r) => `<#${r.ticket.channelId}>`).join(', ');
        return interaction.reply({ content: `❌ You already have ${mine.length} open ticket${mine.length === 1 ? '' : 's'}: ${list}. Close one before opening another.`, flags: EPHEMERAL });
    }
    const label = categories(cfg)[idx] || 'Support';
    const modal = new ModalBuilder().setCustomId(`tk:modal:${idx}`).setTitle(truncate(`New ticket: ${label}`, 45)).addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(100).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(1000).setRequired(true)),
    );
    return interaction.showModal(modal);
}

async function createTicket(interaction, idx) {
    const { db, safeSave } = context.get();
    const cfg = getConfig(db, 'tickets');
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild;
    if (!cfg.enabled) return interaction.editReply('❌ Tickets are turned off right now.');
    if (openCountFor(interaction.user.id) >= cfg.maxOpenPerUser) return interaction.editReply('❌ You already have the maximum number of open tickets.');
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) return interaction.editReply('❌ I can\'t create channels here. Ask an admin to give me **Manage Channels**.');

    const category = categories(cfg)[idx] || 'Support';
    const subject = clean(interaction.fields.getTextInputValue('subject'), 100);
    const details = clean(interaction.fields.getTextInputValue('details'), 1000);
    const user = interaction.user;
    const d = data();

    let channel, cat;
    try {
        cat = await ensureCategory(guild);
        const number = d.nextNumber++;
        const staffOverwrites = staffRoleIds(guild).map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] }));
        channel = await guild.channels.create({
            name: `ticket-${String(number).padStart(4, '0')}`, type: ChannelType.GuildText, parent: cat.id,
            topic: truncate(`${category} · ${user.tag || user.username} · ${subject}`, 1000),
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
                ...staffOverwrites,
            ],
            reason: `Ticket opened by ${user.tag || user.username}`,
        });

        // The Help Center request that mirrors this ticket.
        let id;
        do { id = 'SR-' + crypto.randomBytes(3).toString('hex').toUpperCase(); } while (byId(id));
        const now = Date.now();
        const text = `[${category}] ${subject}\n\n${details}`.slice(0, 3000);
        requests().push({
            id, type: 'Ticket', discord: user.username, discordId: user.id, avatar: user.avatar || null, email: '',
            subject, message: text, status: 'open', createdAt: now, updatedAt: now,
            messages: [{ id: 'm0', from: 'member', name: user.username, body: text, at: now, via: 'discord' }],
            ticket: { number: d.nextNumber - 1, category, channelId: channel.id, claimedBy: null, closedAt: null, closedBy: null, deleteAt: null },
        });
        if (requests().length > 500) db.supportRequests = db.supportRequests.slice(-500);
        await safeSave();

        const rid = supportRoleId();
        await channel.send({
            content: `<@${user.id}>${rid ? ` <@&${rid}>` : ''}`,
            allowedMentions: { users: [user.id], roles: rid ? [rid] : [] },
            embeds: [brandEmbed({
                title: `🎫 ${truncate(subject, 200)}`,
                description: truncate(details, 1800),
                fields: [
                    { name: 'Type', value: category, inline: true },
                    { name: 'Opened by', value: `<@${user.id}>`, inline: true },
                    { name: 'Help Center reference', value: `[${id}](${threadUrl({ id })})`, inline: true },
                ],
                footer: `Ticket #${String(d.nextNumber - 1).padStart(4, '0')} · messages here also appear in the Help Center`,
            })],
            components: ticketButtons(false, cfg),
        });
        logToChannel(guild, cfg, brandEmbed({
            title: '🎫 Ticket opened', color: 0x57F287,
            description: `<#${channel.id}> · **${truncate(subject, 150)}**\nBy <@${user.id}> · ${category} · ${id}`,
        }));
        return interaction.editReply(`✅ Your ticket is open: <#${channel.id}>\nYou can also follow it on the Help Center under **My Help Requests** (${id}).`);
    } catch (err) {
        console.error('❌ [tickets] create failed:', err);
        if (channel) channel.delete('Ticket creation failed').catch(() => { });
        return interaction.editReply('❌ Something went wrong opening your ticket. Please try again, or use the Help Center.');
    }
}

// ---------- logging / transcript ----------
function logChannel(guild, cfg) {
    const { db } = context.get();
    const ch = guild.channels.cache.get(cfg.logChannel || db.modLogChannel);
    return ch && ch.isTextBased() ? ch : null;
}
function logToChannel(guild, cfg, embed, files) {
    const ch = logChannel(guild, cfg);
    if (!ch) return Promise.resolve();
    return ch.send({ embeds: [embed], files: files || [], allowedMentions: noMentions }).catch((err) => console.error('❌ [tickets] log failed:', err.message));
}
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
function transcriptText(r) {
    const head = [
        `Ticket ${r.id}${r.ticket?.number ? ` (#${String(r.ticket.number).padStart(4, '0')})` : ''}`,
        `Subject: ${r.subject}`, `Type: ${r.ticket?.category || r.type}`, `Opened by: ${r.discord} (${r.discordId})`,
        `Opened: ${utc(r.createdAt)}`, r.ticket?.closedAt ? `Closed: ${utc(r.ticket.closedAt)}` : '', '', '-'.repeat(60), '',
    ].filter((l, i) => l !== '' || i > 4);
    const lines = (r.messages || []).map((m) => {
        const who = m.from === 'system' ? '— ' : `${m.name || m.from} (${m.from}): `;
        return `[${utc(m.at)}] ${who}${m.body}`;
    });
    return head.join('\n') + '\n' + lines.join('\n') + '\n';
}

// ---------- closing ----------
async function closeTicket(r, { by, reason = '', alreadySolved = false } = {}) {
    const { client, db, safeSave, GUILD_ID } = context.get();
    const t = r.ticket;
    if (!t || t.closedAt) return false;
    const cfg = getConfig(db, 'tickets');
    const now = Date.now();
    t.closedAt = now; t.closedBy = by;
    t.deleteAt = now + cfg.closeDelaySeconds * 1000;
    if (!alreadySolved) {
        pushMessage(r, 'system', '', `Ticket closed by ${by}${reason ? `: ${truncate(reason, 300)}` : ''}`);
        setStatus(r, 'solved');
    }
    await safeSave();

    const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
    const channel = t.channelId && guild ? (guild.channels.cache.get(t.channelId) || await guild.channels.fetch(t.channelId).catch(() => null)) : null;
    const file = () => new AttachmentBuilder(Buffer.from(transcriptText(r), 'utf8'), { name: `${r.id}-transcript.txt` });

    if (guild) {
        await logToChannel(guild, cfg, brandEmbed({
            title: '🔒 Ticket closed', color: 0xED4245,
            description: `**${truncate(r.subject, 150)}** · ${r.id}\nOpened by <@${r.discordId}> · closed by ${by}${reason ? `\nReason: ${truncate(reason, 300)}` : ''}\nMessages: ${realMessages(r)}`,
        }), [file()]);
    }
    if (cfg.dmTranscript && r.discordId) {
        try {
            const user = await client.users.fetch(r.discordId);
            await user.send({
                embeds: [brandEmbed({
                    title: '🔒 Your ticket was closed',
                    description: `**${truncate(r.subject, 200)}**\nIt is marked **Solved** in the Help Center. If you still need help, reply there and it will reopen.\n\n[Open your request](${threadUrl(r)})`,
                })],
                files: [file()],
            });
        } catch { /* DMs closed */ }
    }
    if (channel) {
        await channel.permissionOverwrites.edit(r.discordId, { SendMessages: false }).catch(() => { });
        await channel.send({ embeds: [brandEmbed({
            title: '🔒 Ticket closed', color: 0xED4245,
            description: `Closed by ${by}.${cfg.closeDelaySeconds ? ` This channel will be deleted in ${cfg.closeDelaySeconds} second${cfg.closeDelaySeconds === 1 ? '' : 's'}.` : ''}\nThe conversation stays in the Help Center.`,
        })], allowedMentions: noMentions }).catch(() => { });
    }
    return true;
}

// Scheduler hook (every 10 s): delete channels whose close delay has passed. Restart-safe because deleteAt is stored.
async function tick() {
    const { client, GUILD_ID, safeSave } = context.get();
    const due = requests().filter((r) => r && r.ticket && r.ticket.deleteAt && r.ticket.deleteAt <= Date.now());
    if (!due.length) return;
    const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
    for (const r of due) {
        const id = r.ticket.channelId;
        if (guild && id) {
            const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
            if (ch) await ch.delete(`Ticket ${r.id} closed`).catch((err) => console.error('❌ [tickets] delete failed:', err.message));
        }
        r.ticket.channelId = null;
        r.ticket.deleteAt = null;
    }
    await safeSave();
}

// ---------- Discord → Help Center ----------
function onMessage(message) {
    if (!message.guild || message.author.bot || message.system) return;
    if (!message.channel.name || !message.channel.name.startsWith('ticket-')) return;
    const r = byChannel(message.channel.id);
    if (!r || r.ticket.closedAt) return;

    let body = message.cleanContent || '';
    for (const a of message.attachments.values()) body += `${body ? '\n' : ''}[attachment: ${a.url}]`;
    body = clean(body, support.MAX_BODY);
    if (!body) return;

    support.normalize(r);
    if (realMessages(r) >= support.TICKET_MAX_MESSAGES) {
        if (!r.ticket.capNotified) {
            r.ticket.capNotified = true;
            message.channel.send('⚠️ This ticket reached the Help Center message limit, so new messages here are no longer synced. The channel keeps working.').catch(() => { });
        }
        return;
    }
    const staff = isTicketStaff(message.member, message.guild);
    const from = staff ? 'staff' : 'member';
    pushMessage(r, from, message.member?.displayName || message.author.username, body, { via: 'discord' });
    setStatus(r, staff ? 'awaiting' : 'open');
    context.get().saveLater?.();
}

// ---------- Help Center → Discord (events come from features/support.js) ----------
async function channelOf(r) {
    const { client } = context.get();
    if (!isLive(r)) return null;
    return client.channels.cache.get(r.ticket.channelId) || await client.channels.fetch(r.ticket.channelId).catch(() => null);
}
async function onWebMessage(r, msg) {
    if (!r.ticket || msg.via === 'discord') return;
    const ch = await channelOf(r);
    if (!ch) return;
    const text = msg.from === 'system' ? `ℹ️ ${msg.body}`
        : `📨 **${msg.name || msg.from}** (${msg.from === 'staff' ? 'staff, ' : ''}from the Help Center):\n${msg.body}`;
    ch.send({ content: truncate(text, 1900), allowedMentions: noMentions }).catch(() => { });
}
async function onWebStatus(r, status) {
    const t = r.ticket;
    if (!t) return;
    if (status === 'solved') {
        // Solved on the website closes the ticket (the website already added its own "marked as solved" line).
        if (!t.closedAt) await closeTicket(r, { by: 'the Help Center', alreadySolved: true });
        return;
    }
    if (t.closedAt && t.deleteAt && t.channelId) {
        // Reopened from the website while the channel still exists: cancel the delete and unlock it.
        t.closedAt = null; t.closedBy = null; t.deleteAt = null;
        const ch = await channelOf(r);
        if (ch) {
            await ch.permissionOverwrites.edit(r.discordId, { SendMessages: true }).catch(() => { });
            ch.send({ content: '🔓 This ticket was reopened from the Help Center.', allowedMentions: noMentions }).catch(() => { });
        }
    }
}

// ---------- panel + slash commands ----------
const inTicketChannel = (interaction) => {
    const r = interaction.channel ? byChannel(interaction.channel.id) : null;
    return r && !r.ticket.closedAt ? r : null;
};

const commands = {
    async ticket({ interaction, options, isAtLeastAdmin, guild }) {
        const { db, safeSave } = context.get();
        const cfg = getConfig(db, 'tickets');
        const sub = options.getSubcommand();
        guild = guild || interaction.guild;
        const member = interaction.member;

        if (sub === 'panel') {
            if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to post the ticket panel.');
            if (!cfg.enabled) return interaction.editReply('❌ Tickets are turned off. Enable **Tickets** under Dashboard → Feature Settings first.');
            const target = options.getChannel('channel') || interaction.channel;
            if (!target || !target.isTextBased()) return interaction.editReply('❌ Pick a text channel.');
            const cat = options.getChannel('category');
            if (cat) { data().categoryId = cat.id; await safeSave(); }
            await target.send({
                embeds: [brandEmbed({
                    title: options.getString('title') || '🎫 Need help?',
                    description: options.getString('description') || 'Press a button below to open a private ticket with staff. Your ticket is also saved in the Help Center, where you can follow it and reply from the website.',
                })],
                components: panelComponents(cfg),
            });
            return interaction.editReply(`✅ Panel posted in <#${target.id}>.`);
        }

        const r = inTicketChannel(interaction);
        if (!r) return interaction.editReply('❌ Use this inside an open ticket channel.');
        const staff = isTicketStaff(member, guild);

        if (sub === 'close') {
            if (!staff && interaction.user.id !== r.discordId) return interaction.editReply('❌ Only the ticket owner or staff can close it.');
            await interaction.editReply('🔒 Closing…');
            return void closeTicket(r, { by: member?.displayName || interaction.user.username, reason: clean(options.getString('reason'), 300) });
        }
        if (!staff) return interaction.editReply('❌ Only staff can do that.');

        if (sub === 'claim') return claim(interaction, r, cfg, false);
        if (sub === 'add' || sub === 'remove') {
            const user = options.getUser('user');
            if (user.bot) return interaction.editReply('❌ That\'s a bot.');
            if (sub === 'remove' && user.id === r.discordId) return interaction.editReply('❌ You can\'t remove the ticket owner.');
            if (sub === 'add') {
                await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
                await interaction.channel.send({ content: `➕ <@${user.id}> was added to this ticket.`, allowedMentions: { users: [user.id] } });
            } else {
                await interaction.channel.permissionOverwrites.delete(user.id);
                await interaction.channel.send({ content: `➖ ${user.username} was removed from this ticket.`, allowedMentions: noMentions });
            }
            return interaction.editReply('✅ Done.');
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

async function claim(interaction, r, cfg, fromButton) {
    const name = interaction.member?.displayName || interaction.user.username;
    if (!cfg.allowClaim) { const msg = '❌ Claiming is turned off.'; return fromButton ? interaction.reply({ content: msg, flags: EPHEMERAL }) : interaction.editReply(msg); }
    if (r.ticket.claimedBy) { const msg = `❌ Already claimed by <@${r.ticket.claimedBy}>.`; return fromButton ? interaction.reply({ content: msg, flags: EPHEMERAL, allowedMentions: noMentions }) : interaction.editReply({ content: msg, allowedMentions: noMentions }); }
    r.ticket.claimedBy = interaction.user.id;
    pushMessage(r, 'system', '', 'A staff member picked up your ticket');
    await context.get().safeSave();
    const note = `🙋 <@${interaction.user.id}> claimed this ticket.`;
    if (fromButton) {
        await interaction.update({ components: ticketButtons(true, cfg) }).catch(() => { });
        return interaction.channel.send({ content: note, allowedMentions: noMentions });
    }
    await interaction.channel.send({ content: note, allowedMentions: noMentions });
    return interaction.editReply(`✅ Claimed as ${name}.`);
}

// ---------- buttons + modal ----------
async function handleButton(interaction) {
    const id = interaction.customId;
    const { db } = context.get();
    const cfg = getConfig(db, 'tickets');
    if (id.startsWith('tk:new:')) return startTicket(interaction, parseInt(id.slice(7), 10) || 0);

    const r = interaction.channel ? byChannel(interaction.channel.id) : null;
    if (!r || r.ticket.closedAt) return interaction.reply({ content: '❌ This ticket is already closed.', flags: EPHEMERAL });
    const staff = isTicketStaff(interaction.member, interaction.guild);

    if (id === 'tk:close') {
        if (!staff && interaction.user.id !== r.discordId) return interaction.reply({ content: '❌ Only the ticket owner or staff can close it.', flags: EPHEMERAL });
        return interaction.reply({
            content: 'Close this ticket? The channel will be deleted and the conversation kept in the Help Center.', flags: EPHEMERAL,
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tk:close:y').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('tk:close:n').setLabel('Keep open').setStyle(ButtonStyle.Secondary),
            )],
        });
    }
    if (id === 'tk:close:n') return interaction.update({ content: 'Ticket kept open.', components: [] });
    if (id === 'tk:close:y') {
        if (!staff && interaction.user.id !== r.discordId) return interaction.update({ content: '❌ Only the ticket owner or staff can close it.', components: [] });
        await interaction.update({ content: '🔒 Closing…', components: [] });
        return void closeTicket(r, { by: interaction.member?.displayName || interaction.user.username });
    }
    if (id === 'tk:claim') {
        if (!staff) return interaction.reply({ content: '❌ Only staff can claim tickets.', flags: EPHEMERAL });
        return claim(interaction, r, cfg, true);
    }
}

async function handleModal(interaction) {
    if (interaction.customId.startsWith('tk:modal:')) return createTicket(interaction, parseInt(interaction.customId.slice(9), 10) || 0);
}

// Wires the Help Center → channel direction. Called once from features/index.js.
function init() {
    context.bus.on('support:message', (r, msg) => { onWebMessage(r, msg).catch((e) => console.error('❌ [tickets] relay failed:', e.message)); });
    context.bus.on('support:status', (r, status) => { onWebStatus(r, status).catch((e) => console.error('❌ [tickets] status relay failed:', e.message)); });
}

const definitions = [
    {
        name: 'ticket',
        description: 'Tickets',
        options: [
            {
                name: 'panel', description: 'Post the ticket panel (Admin+)', type: 1,
                options: [
                    { name: 'channel', description: 'Where to post it (default: here)', type: 7, channel_types: [0, 5] },
                    { name: 'title', description: 'Panel title', type: 3, max_length: 100 },
                    { name: 'description', description: 'Panel text', type: 3, max_length: 1000 },
                    { name: 'category', description: 'Category new ticket channels are created in', type: 7, channel_types: [4] },
                ],
            },
            { name: 'close', description: 'Close this ticket', type: 1, options: [{ name: 'reason', description: 'Why it is being closed', type: 3, max_length: 300 }] },
            { name: 'claim', description: 'Claim this ticket (staff)', type: 1 },
            { name: 'add', description: 'Add someone to this ticket (staff)', type: 1, options: [{ name: 'user', description: 'Who to add', type: 6, required: true }] },
            { name: 'remove', description: 'Remove someone from this ticket (staff)', type: 1, options: [{ name: 'user', description: 'Who to remove', type: 6, required: true }] },
        ],
    },
];

module.exports = { commands, definitions, handleButton, handleModal, onMessage, tick, init, closeTicket, byChannel };
