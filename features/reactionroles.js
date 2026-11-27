// Reaction roles. Configured ONLY from the dashboard (Reaction Roles page); there is no slash command.
//
// A panel is one embed message with up to 20 emoji -> role rows. Members react to get the role and un-react to lose it.
//   - emoji: any standard (Unicode) emoji, including skin tones, plus the server's own custom emojis
//   - role:  any role in the server that the bot can actually give (the dashboard greys out the others and says why)
//   - every piece of text is editable: embed title, description, the heading above the list, footer, the text next
//     to each emoji, and the DMs members get when a role is added or removed
//
// Data (db.features.reactionroles): { panels: [...], nextId }
//   panel = { id, enabled, channelId, messageId|null, title, description, listHeading, footer, color,
//             mode: 'multi' | 'unique', removeOnUnreact, notify: 'none' | 'dm', addedText, removedText,
//             items: [{ emoji, roleId, text }] }
//   emoji is stored as the Unicode character(s), or <:name:id> / <a:name:id> for a custom emoji.
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { store, brandEmbed, recordEvent } = require('./util');

const MAX_ITEMS = 20; // Discord allows 20 different reactions on one message
const LIMITS = { title: 256, description: 1500, listHeading: 100, footer: 200, text: 100, dm: 300 };
const DEFAULTS = {
    title: '🎭 Pick your roles',
    description: 'React below to get a role. Remove your reaction to take it off again.',
    listHeading: 'Available roles',
    footer: '',
    color: '#5500FF',
    mode: 'multi',
    removeOnUnreact: true,
    notify: 'none',
    addedText: 'You now have the **{role}** role in **{server}**. ✅',
    removedText: 'The **{role}** role was removed in **{server}**.',
};

const data = () => store(context.get().db, 'reactionroles', { panels: [], nextId: 1 });
const find = (id) => data().panels.find((p) => p.id === id) || null;
const bg = (label, fn) => { Promise.resolve().then(fn).catch((err) => console.error(`❌ [reactionroles] ${label} failed:`, err.message)); };

// ---------- emoji helpers ----------
const FE0F = /\uFE0F/g;
const TONES = /[\u{1F3FB}-\u{1F3FF}]/gu;
const baseKey = (e) => String(e).replace(FE0F, '').replace(TONES, '');
const CUSTOM_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;

let _unicode = null; // { groups: [{ name, emojis: [[emoji, name, toneable]] }], known: Set<baseKey> }
function unicodeEmojis() {
    if (_unicode) return _unicode;
    let groups = [];
    try {
        const raw = require('unicode-emoji-json/data-by-group.json');
        groups = raw.map((g) => ({ name: g.name, emojis: g.emojis.map((e) => [e.emoji, e.name, e.skin_tone_support ? 1 : 0]) }));
    } catch (err) {
        console.error('⚠️ [reactionroles] unicode-emoji-json is missing (run npm install); the emoji picker will be empty:', err.message);
    }
    _unicode = { groups, known: new Set(groups.flatMap((g) => g.emojis.map((e) => baseKey(e[0])))) };
    return _unicode;
}

// Returns the cleaned emoji string, or null when it is not a real emoji.
function cleanEmoji(raw, guild) {
    const e = String(raw || '').trim();
    const m = CUSTOM_RE.exec(e);
    if (m) return guild?.emojis.cache.has(m[3]) ? e : null;
    return unicodeEmojis().known.has(baseKey(e)) ? e : null;
}
// What to pass to message.react().
const reactable = (e) => { const m = CUSTOM_RE.exec(e); return m ? m[3] : e; };
// Does this gateway reaction emoji match a stored emoji?
function sameEmoji(stored, emoji) {
    const m = CUSTOM_RE.exec(stored);
    if (m) return emoji.id === m[3];
    return !emoji.id && baseKey(emoji.name || '') === baseKey(stored);
}

// ---------- rendering ----------
function colorInt(hex) {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    return Number.isFinite(n) ? Math.min(0xFFFFFF, Math.max(0, n)) : 0x5500FF;
}
function buildEmbed(p) {
    const lines = p.items.map((it) => `${it.emoji}  <@&${it.roleId}>${it.text ? ` — ${it.text}` : ''}`);
    const body = [p.description, lines.length ? `${p.listHeading ? `**${p.listHeading}**\n` : ''}${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
    return brandEmbed({ title: p.title || undefined, description: body || '\u200b', color: colorInt(p.color), footer: p.footer || null, timestamp: false });
}
const fill = (text, vars) => String(text || '').replace(/\{(role|server)\}/g, (_, k) => vars[k]);

// ---------- dashboard helpers ----------
function guildInfo(guild) {
    const me = guild?.members.me;
    const top = me?.roles.highest?.position ?? 0;
    const roles = guild ? [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position).map((r) => ({
        id: r.id, name: r.name, color: r.hexColor,
        problem: r.managed ? 'managed by an integration or bot' : (r.position >= top ? 'above my highest role' : ''),
    })) : [];
    const channels = guild ? [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name })) : [];
    return { roles, channels, canManageRoles: !!me?.permissions.has(PermissionFlagsBits.ManageRoles) };
}
function emojiPayload(guild) {
    const u = unicodeEmojis();
    const custom = guild ? [...guild.emojis.cache.values()].map((e) => [e.toString(), e.name, 0]) : [];
    return { groups: [...(custom.length ? [{ name: 'Server emojis', emojis: custom }] : []), ...u.groups] };
}

// ---------- validate + save (from the dashboard form) ----------
function parseForm(guild, body, existing = null) {
    const err = (error) => ({ ok: false, error });
    const p = {
        id: existing?.id, messageId: existing?.messageId || null,
        enabled: body.enabled === 'on' || body.enabled === 'true',
        channelId: String(body.channelId || ''),
        title: String(body.title ?? '').trim().slice(0, LIMITS.title),
        description: String(body.description ?? '').trim().slice(0, LIMITS.description),
        listHeading: String(body.listHeading ?? '').trim().slice(0, LIMITS.listHeading),
        footer: String(body.footer ?? '').trim().slice(0, LIMITS.footer),
        color: /^#?[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? `#${String(body.color).replace('#', '').toUpperCase()}` : DEFAULTS.color,
        mode: body.mode === 'unique' ? 'unique' : 'multi',
        removeOnUnreact: body.removeOnUnreact === 'on' || body.removeOnUnreact === 'true',
        notify: body.notify === 'dm' ? 'dm' : 'none',
        addedText: String(body.addedText ?? '').trim().slice(0, LIMITS.dm) || DEFAULTS.addedText,
        removedText: String(body.removedText ?? '').trim().slice(0, LIMITS.dm) || DEFAULTS.removedText,
        items: [],
    };
    const ch = guild?.channels.cache.get(p.channelId);
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) return err('Pick a text channel for the panel.');
    if (!p.title && !p.description) return err('Give the panel a title or a description.');

    let items;
    try { items = JSON.parse(body.items || '[]'); } catch { return err('The emoji/role list could not be read. Reload the page and try again.'); }
    if (!Array.isArray(items) || !items.length) return err('Add at least one emoji + role row.');
    if (items.length > MAX_ITEMS) return err(`A panel can have at most ${MAX_ITEMS} rows (Discord's reaction limit).`);
    const seenEmoji = new Set(), seenRole = new Set();
    for (const [i, it] of items.entries()) {
        const emoji = cleanEmoji(it.emoji, guild);
        if (!emoji) return err(`Row ${i + 1}: pick an emoji from the list.`);
        if (!guild.roles.cache.has(String(it.roleId)) || String(it.roleId) === guild.id) return err(`Row ${i + 1}: pick a role.`);
        if (seenEmoji.has(baseKey(emoji))) return err(`Row ${i + 1}: that emoji is already used in this panel.`);
        if (seenRole.has(it.roleId)) return err(`Row ${i + 1}: that role is already in this panel.`);
        seenEmoji.add(baseKey(emoji)); seenRole.add(it.roleId);
        p.items.push({ emoji, roleId: String(it.roleId), text: String(it.text ?? '').trim().slice(0, LIMITS.text) });
    }
    return { ok: true, panel: p };
}

async function savePanel(guild, body, by) {
    const d = data();
    const id = parseInt(body.id, 10);
    const existing = Number.isInteger(id) ? find(id) : null;
    if (Number.isInteger(id) && !existing) return { ok: false, error: 'That panel no longer exists.' };
    const r = parseForm(guild, body, existing);
    if (!r.ok) return r;
    const p = r.panel;
    if (existing) Object.assign(existing, p, { id: existing.id });
    else { p.id = d.nextId++; d.panels.push(p); }
    const saved = existing || p;
    recordEvent(context.get().db, 'reactionroles', `Reaction role panel #${saved.id} saved by ${by}`);
    await context.get().safeSave();
    return { ok: true, panel: saved };
}

// ---------- publish / unpublish ----------
async function fetchMessage(p) {
    const { client } = context.get();
    if (!p.messageId) return null;
    const ch = client.channels.cache.get(p.channelId) || await client.channels.fetch(p.channelId).catch(() => null);
    return ch?.messages ? ch.messages.fetch(p.messageId).catch(() => null) : null;
}

// Makes the message's reactions match the panel (removes stale ones, adds missing ones, in row order).
async function syncReactions(p, msg) {
    const want = p.items.map((i) => i.emoji);
    for (const r of [...msg.reactions.cache.values()]) {
        if (!want.some((e) => sameEmoji(e, r.emoji))) await r.remove().catch(() => { });
    }
    for (const e of want) {
        const has = msg.reactions.cache.find((r) => sameEmoji(e, r.emoji) && r.me);
        if (!has) await msg.react(reactable(e)).catch((err) => console.error(`❌ [reactionroles] react ${e} failed:`, err.message));
    }
}

async function publishPanel(guild, p, by) {
    const { db } = context.get();
    const ch = guild.channels.cache.get(p.channelId);
    if (!ch?.isTextBased()) return { ok: false, error: 'That channel is not available.' };
    const perms = ch.permissionsFor(guild.members.me);
    for (const [flag, label] of [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.SendMessages, 'Send Messages'], [PermissionFlagsBits.EmbedLinks, 'Embed Links'], [PermissionFlagsBits.AddReactions, 'Add Reactions'], [PermissionFlagsBits.ReadMessageHistory, 'Read Message History']]) {
        if (!perms?.has(flag)) return { ok: false, error: `I need **${label}** in #${ch.name}.` };
    }
    let msg = await fetchMessage(p);
    // Moved to another channel? Take the old message down and post a new one.
    if (msg && msg.channelId !== p.channelId) { await msg.delete().catch(() => { }); msg = null; }
    const payload = { embeds: [buildEmbed(p)], allowedMentions: { parse: [] } };
    if (msg) await msg.edit(payload).catch((err) => { console.error('❌ [reactionroles] edit failed:', err.message); msg = null; });
    if (!msg) msg = await ch.send(payload).catch((err) => { console.error('❌ [reactionroles] post failed:', err.message); return null; });
    if (!msg) return { ok: false, error: 'I could not post the panel.' };
    p.messageId = msg.id;
    recordEvent(db, 'reactionroles', `Reaction role panel #${p.id} published in #${ch.name} by ${by}`);
    await context.get().safeSave();
    bg(`sync #${p.id}`, () => syncReactions(p, msg));
    return { ok: true, msg };
}

async function unpublishPanel(p, by) {
    const msg = await fetchMessage(p);
    if (msg) await msg.delete().catch(() => { });
    p.messageId = null;
    recordEvent(context.get().db, 'reactionroles', `Reaction role panel #${p.id} taken down by ${by}`);
    await context.get().safeSave();
}

async function deletePanel(id, by) {
    const d = data();
    const p = find(id);
    if (!p) return false;
    await unpublishPanel(p, by);
    d.panels = d.panels.filter((x) => x.id !== id);
    recordEvent(context.get().db, 'reactionroles', `Reaction role panel #${id} deleted by ${by}`);
    await context.get().safeSave();
    return true;
}

// ---------- reactions -> roles ----------
async function onReaction(reaction, user, added) {
    if (user.bot) return;
    const msgId = reaction.message.id;
    const p = data().panels.find((x) => x.messageId === msgId);
    if (!p || !p.enabled) return;
    if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
    if (!reaction) return;
    const item = p.items.find((i) => sameEmoji(i.emoji, reaction.emoji));
    const guild = reaction.message.guild || actions.getGuild();
    if (!guild) return;
    if (!item) { if (added) await reaction.users.remove(user.id).catch(() => { }); return; } // not one of the panel's emojis
    const member = guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch(() => null);
    const role = guild.roles.cache.get(item.roleId);
    if (!member || !role) return;
    const vars = { role: role.name, server: guild.name };
    const dm = (text) => { if (p.notify === 'dm') member.send(fill(text, vars)).catch(() => { }); };

    try {
        if (added) {
            if (p.mode === 'unique') {
                const others = p.items.filter((i) => i !== item && member.roles.cache.has(i.roleId)).map((i) => i.roleId);
                if (others.length) await member.roles.remove(others, `Reaction role panel #${p.id} (one role only)`);
                for (const r of reaction.message.reactions.cache.values()) {
                    if (r.emoji.name !== reaction.emoji.name || r.emoji.id !== reaction.emoji.id) r.users.remove(user.id).catch(() => { });
                }
            }
            if (!member.roles.cache.has(role.id)) {
                await member.roles.add(role, `Reaction role panel #${p.id}`);
                dm(p.addedText);
            }
        } else if (p.removeOnUnreact && member.roles.cache.has(role.id)) {
            // (In "one role only" mode a swap already removed the old role before its reaction is taken away, so this is a no-op then.)
            await member.roles.remove(role, `Reaction role panel #${p.id}`);
            dm(p.removedText);
        }
    } catch (err) {
        console.error(`❌ [reactionroles] ${added ? 'add' : 'remove'} ${role.name} for ${user.tag} failed:`, err.message);
        if (added) reaction.users.remove(user.id).catch(() => { });
        if (p.notify === 'dm') member.send(`I couldn't change the **${role.name}** role for you in **${guild.name}**. Please tell a moderator (my role is probably below that role).`).catch(() => { });
    }
}

// The panel's message was deleted by hand -> mark it as not published.
function onMessageDelete(message) {
    const p = data().panels.find((x) => x.messageId === message.id);
    if (!p) return;
    p.messageId = null;
    context.get().saveLater?.();
}

// ---------- startup: make sure every published panel still matches reality ----------
async function reconcile() {
    for (const p of data().panels) {
        if (!p.messageId) continue;
        const msg = await fetchMessage(p);
        if (!msg) { p.messageId = null; context.get().saveLater?.(); }
    }
}

module.exports = { DEFAULTS, MAX_ITEMS, LIMITS, find, data, guildInfo, emojiPayload, savePanel, publishPanel, unpublishPanel, deletePanel, onReaction, onMessageDelete, reconcile, buildEmbed };
