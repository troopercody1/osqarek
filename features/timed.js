// Timed actions: temp-bans, temporary roles, delayed unbans, delayed messages.
// Everything is persisted in db.features.timed.queue so it survives restarts;
// anything overdue at startup runs on the first tick.
const { PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const actions = require('./actions');
const { getConfig } = require('./config');
const { store, brandEmbed, recordEvent, parseDuration, formatDuration, addCase, ts, truncate } = require('./util');

const MIN_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const FINISHED_KEEP_MS = 7 * 86400000;
const FINISHED_KEEP_COUNT = 100;
const running = new Set();

function data() {
    const { db } = context.get();
    return store(db, 'timed', { queue: [], nextId: 1 });
}

function enqueue(item) {
    const d = data();
    const full = { id: d.nextId++, status: 'pending', attempts: 0, createdAt: Date.now(), note: '', ...item };
    d.queue.push(full);
    return full;
}

function cancelPending(predicate) {
    let n = 0;
    for (const it of data().queue) {
        if (it.status === 'pending' && predicate(it)) { it.status = 'cancelled'; it.finishedAt = Date.now(); n++; }
    }
    return n;
}

function pending(filterType) {
    return data().queue.filter((i) => i.status === 'pending' && (!filterType || i.type === filterType)).sort((a, b) => a.dueAt - b.dueAt);
}

const TYPE_LABEL = { unban: '🔓 Unban', role_remove: '➖ Remove role', role_add: '➕ Add role', message: '💬 Message' };

function describe(it) {
    switch (it.type) {
        case 'unban': return `unban <@${it.userId}>`;
        case 'role_remove': return `remove <@&${it.roleId}> from <@${it.userId}>`;
        case 'role_add': return `give <@&${it.roleId}> to <@${it.userId}>`;
        case 'message': return `message in <#${it.channelId}>: "${truncate(it.text, 50)}"`;
        default: return it.type;
    }
}

// ---------- execution ----------
async function execute(guild, it) {
    const { db, logAction } = context.get();
    const cfg = getConfig(db, 'timed');

    if (it.type === 'unban') {
        const ban = await guild.bans.fetch(it.userId).catch(() => null);
        if (!ban) return 'was not banned';
        await guild.members.unban(it.userId, `Timed unban${it.reason ? `: ${it.reason}` : ''}`.slice(0, 512));
        if (cfg.logToCases) addCase(db, { type: '🔓 TEMP UNBAN', userId: it.userId, userTag: ban.user?.tag, reason: 'Temporary ban expired', moderator: 'Timed Actions' });
        logAction?.(guild, '🔓 Timed unban', `**User:** ${ban.user?.tag || it.userId} (\`${it.userId}\`)\n**Scheduled by:** ${it.createdBy}`, 0x00FF00);
        return 'unbanned';
    }

    if (it.type === 'role_remove' || it.type === 'role_add') {
        const member = await guild.members.fetch(it.userId).catch(() => null);
        if (!member) return 'member left the server';
        const role = guild.roles.cache.get(it.roleId);
        if (!role) throw Object.assign(new Error('Role no longer exists.'), { permanent: true });
        if (it.type === 'role_remove') await member.roles.remove(role, `Timed role removal (scheduled by ${it.createdBy})`);
        else await member.roles.add(role, `Timed role grant (scheduled by ${it.createdBy})`);
        logAction?.(guild, '⏲️ Timed role', `${it.type === 'role_remove' ? 'Removed' : 'Added'} **${role.name}** ${it.type === 'role_remove' ? 'from' : 'to'} ${member.user.tag}\n**Scheduled by:** ${it.createdBy}`, 0x5500FF);
        return it.type === 'role_remove' ? 'role removed' : 'role added';
    }

    if (it.type === 'message') {
        const ch = guild.channels.cache.get(it.channelId) || await guild.channels.fetch(it.channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) throw Object.assign(new Error('Channel no longer exists.'), { permanent: true });
        await ch.send({ content: it.text, allowedMentions: { parse: ['users', 'roles'] } });
        return 'sent';
    }
    throw Object.assign(new Error(`Unknown action type ${it.type}`), { permanent: true });
}

async function tick() {
    const d = data();
    const now = Date.now();
    const guild = actions.getGuild();
    if (!guild) return;
    const due = d.queue.filter((i) => i.status === 'pending' && i.dueAt <= now && !running.has(i.id));
    let changed = false;

    for (const it of due) {
        running.add(it.id);
        try {
            it.note = await execute(guild, it);
            it.status = 'done';
            it.finishedAt = Date.now();
            recordEvent(context.get().db, 'timed', `Timed ${it.type} done: ${it.note}`, { userId: it.userId });
        } catch (err) {
            it.attempts++;
            it.note = truncate(err.message, 200);
            if (err.permanent || it.attempts >= MAX_ATTEMPTS) {
                it.status = 'failed';
                it.finishedAt = Date.now();
                recordEvent(context.get().db, 'timed', `Timed ${it.type} FAILED: ${it.note}`, { userId: it.userId });
                context.get().logAction?.(guild, '⚠️ Timed action failed', `${describe(it)}\n**Error:** ${it.note}\n**Scheduled by:** ${it.createdBy}`, 0xFF0000);
            } else {
                it.dueAt = Date.now() + 60000;
            }
        } finally {
            running.delete(it.id);
            changed = true;
        }
    }

    // prune old finished items
    const finished = d.queue.filter((i) => i.status !== 'pending');
    if (finished.length > FINISHED_KEEP_COUNT) {
        const cutoff = now - FINISHED_KEEP_MS;
        const drop = new Set(finished.filter((i) => (i.finishedAt || 0) < cutoff).map((i) => i.id));
        if (drop.size) { d.queue = d.queue.filter((i) => !drop.has(i.id)); changed = true; }
    }
    if (changed) await context.get().safeSave();
}

// ---------- helpers for commands ----------
function parseWhen(input, cfg) {
    const ms = parseDuration(input);
    if (!ms) return { error: '❌ Couldn\'t read that duration. Use things like `30m`, `12h`, `3d`, `1w` or `1d12h`.' };
    if (ms < MIN_MS) return { error: '❌ Minimum is 30 seconds.' };
    if (ms > cfg.maxDays * 86400000) return { error: `❌ Maximum is ${cfg.maxDays} days (change it with \`/feature set timed maxDays <n>\`).` };
    return { ms };
}

function roleProblem(invoker, role, guild) {
    if (role.id === guild.id) return 'You can\'t use @everyone.';
    if (role.managed) return 'That role is managed by an integration.';
    if (!role.editable) return 'That role is above (or equal to) my highest role.';
    if (guild.ownerId !== invoker.id && invoker.roles.highest.comparePositionTo(role) <= 0) return 'That role is above (or equal to) your highest role.';
    return null;
}

// ---------- services (used by the slash command AND the dashboard) ----------
// `actor` = { tag, id }. `invoker` (optional GuildMember) enables Discord-side rank checks.
const fail = (error) => ({ ok: false, error });

async function tempBan(guild, { userId, when, reason = 'No reason provided.', deleteDays = 0, actor, invoker = null }) {
    const { db, client } = context.get();
    const cfg = getConfig(db, 'timed');
    const w = parseWhen(when, cfg); if (w.error) return fail(w.error.replace(/^❌ /, ''));
    if (!/^\d{15,25}$/.test(String(userId))) return fail('That doesn\'t look like a user ID.');
    if (userId === actor.id) return fail('You can\'t temp-ban yourself.');
    const target = await client.users.fetch(userId).catch(() => null);
    if (!target) return fail('No such user.');
    const tm = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (tm && (target.bot || actions.isStaff(tm, guild))) return fail('You can\'t temp-ban staff members or bots.');
    if (tm && !tm.bannable) return fail('I can\'t ban that member (role hierarchy / permissions).');
    if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return fail('I\'m missing the Ban Members permission.');
    if (cfg.dmOnTempBan && tm) {
        await target.send({ embeds: [brandEmbed({ title: '⏳ You have been temporarily banned', color: 0xFF0000, description: `**Server:** ${guild.name}\n**Duration:** ${formatDuration(w.ms)}\n**Reason:** ${reason}\n\nYou'll be able to rejoin when the ban expires.` })] }).catch(() => { });
    }
    try {
        await guild.members.ban(userId, { reason: `Temp-ban (${formatDuration(w.ms)}) by ${actor.tag}: ${reason}`.slice(0, 512), deleteMessageSeconds: deleteDays * 86400 });
    } catch (err) { return fail(`Ban failed: ${err.message}`); }
    cancelPending((i) => i.type === 'unban' && i.userId === userId);
    const item = enqueue({ type: 'unban', userId, dueAt: Date.now() + w.ms, reason, createdBy: actor.tag, createdById: actor.id });
    if (cfg.logToCases) addCase(db, { type: '⏰ TEMP BAN', userId, userTag: target.tag, reason: `${reason} (${formatDuration(w.ms)})`, moderator: actor.tag });
    context.get().logAction?.(guild, '⏰ Temp Ban', `**User:** ${target.tag} (\`${userId}\`)\n**Duration:** ${formatDuration(w.ms)}\n**Reason:** ${reason}\n**Moderator:** ${actor.tag}`, 0xFF0000);
    await context.get().safeSave();
    return { ok: true, item, target };
}

async function timedRole(guild, { userId, roleId, when, mode = 'grant', actor, invoker = null }) {
    const { db } = context.get();
    const w = parseWhen(when, getConfig(db, 'timed')); if (w.error) return fail(w.error.replace(/^❌ /, ''));
    const target = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!target) return fail('That user isn\'t in the server.');
    const role = guild.roles.cache.get(roleId);
    if (!role) return fail('Role not found.');
    if (role.id === guild.id) return fail('You can\'t use @everyone.');
    if (role.managed) return fail('That role is managed by an integration.');
    if (!role.editable) return fail('That role is above (or equal to) my highest role.');
    if (invoker) {
        if (guild.ownerId !== invoker.id && invoker.roles.highest.comparePositionTo(role) <= 0) return fail('That role is above (or equal to) your highest role.');
        if (target.id !== invoker.id && guild.ownerId !== invoker.id && target.roles.highest.comparePositionTo(invoker.roles.highest) >= 0) return fail('You can\'t change roles for someone at or above your own rank.');
    }
    try {
        if (mode === 'grant') await target.roles.add(role, `Timed role grant by ${actor.tag} for ${formatDuration(w.ms)}`);
        else await target.roles.remove(role, `Timed role removal by ${actor.tag} for ${formatDuration(w.ms)}`);
    } catch (err) { return fail(`Couldn't change the role: ${err.message}`); }
    cancelPending((i) => (i.type === 'role_remove' || i.type === 'role_add') && i.userId === userId && i.roleId === roleId);
    const item = enqueue({ type: mode === 'grant' ? 'role_remove' : 'role_add', userId, roleId, dueAt: Date.now() + w.ms, createdBy: actor.tag, createdById: actor.id });
    await context.get().safeSave();
    return { ok: true, item, role, target };
}

async function scheduleUnban({ userId, when, actor }) {
    const { db } = context.get();
    const w = parseWhen(when, getConfig(db, 'timed')); if (w.error) return fail(w.error.replace(/^❌ /, ''));
    if (!/^\d{15,25}$/.test(String(userId))) return fail('That doesn\'t look like a user ID.');
    cancelPending((i) => i.type === 'unban' && i.userId === userId);
    const item = enqueue({ type: 'unban', userId, dueAt: Date.now() + w.ms, reason: 'Scheduled unban', createdBy: actor.tag, createdById: actor.id });
    await context.get().safeSave();
    return { ok: true, item };
}

async function scheduleMessage(guild, { channelId, when, text, actor, invoker = null }) {
    const { db } = context.get();
    const w = parseWhen(when, getConfig(db, 'timed')); if (w.error) return fail(w.error.replace(/^❌ /, ''));
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return fail('Pick a text channel.');
    if (!text || !text.trim()) return fail('Message can\'t be empty.');
    if (text.length > 1800) return fail('Message is too long (1800 max).');
    if (/@(everyone|here)/i.test(text)) return fail('Scheduled messages can\'t contain @everyone / @here.');
    if (invoker) {
        const perms = channel.permissionsFor(invoker);
        if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) return fail('You can\'t send messages in that channel yourself.');
    }
    if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return fail('I can\'t send messages in that channel.');
    const item = enqueue({ type: 'message', channelId, text, dueAt: Date.now() + w.ms, createdBy: actor.tag, createdById: actor.id });
    await context.get().safeSave();
    return { ok: true, item, channel };
}

function cancelItem(id, { actorId = null, isAdmin = true } = {}) {
    const it = data().queue.find((i) => i.id === id);
    if (!it || it.status !== 'pending') return fail('No pending action with that ID.');
    if (actorId && it.createdById !== actorId && !isAdmin) return fail('Only the person who scheduled it, or an Admin+, can cancel it.');
    it.status = 'cancelled'; it.finishedAt = Date.now();
    return { ok: true, item: it };
}

// ---------- slash command ----------
const commands = {
    async timed({ interaction, options, guild, member, user, isMod, isAtLeastAdmin }) {
        const { db } = context.get();
        const cfg = getConfig(db, 'timed');
        if (!cfg.enabled) return interaction.editReply('🚫 Timed Actions are disabled. An admin can enable them with `/feature enable timed`.');
        if (!isMod) return interaction.editReply('❌ You need **Moderator+** to use this.');
        const sub = options.getSubcommand();
        const actor = { tag: user.tag, id: user.id };
        const res = (r, ok) => (r.ok ? interaction.editReply(ok(r)) : interaction.editReply(`❌ ${r.error}`));

        if (sub === 'list') {
            const items = pending(options.getString('type'));
            if (!items.length) return interaction.editReply('ℹ️ Nothing scheduled.');
            const lines = items.slice(0, 15).map((i) => `**#${i.id}** ${ts(i.dueAt)} — ${describe(i)} *(by ${i.createdBy})*`);
            return interaction.editReply({ embeds: [brandEmbed({ title: `⏲️ Scheduled actions (${items.length})`, description: lines.join('\n') + (items.length > 15 ? `\n…and ${items.length - 15} more` : '') })] });
        }
        if (sub === 'cancel') {
            const id = options.getInteger('id');
            const r = cancelItem(id, { actorId: user.id, isAdmin: isAtLeastAdmin });
            if (r.ok) await context.get().safeSave();
            return res(r, (x) => `✅ Cancelled **#${id}** (${describe(x.item)}).`);
        }
        if (sub === 'role') {
            const r = await timedRole(guild, { userId: options.getUser('user')?.id, roleId: options.getRole('role').id, when: options.getString('duration'), mode: options.getString('mode') || 'grant', actor, invoker: member });
            return res(r, (x) => `✅ ${x.item.type === 'role_remove' ? 'Gave' : 'Removed'} **${x.role.name}** ${x.item.type === 'role_remove' ? 'to' : 'from'} ${x.target} — it will be ${x.item.type === 'role_remove' ? 'removed' : 'restored'} ${ts(x.item.dueAt)} *(#${x.item.id})*.`);
        }
        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
        if (sub === 'ban') {
            const r = await tempBan(guild, { userId: options.getUser('user').id, when: options.getString('duration'), reason: options.getString('reason') || undefined, deleteDays: options.getInteger('delete_days') || 0, actor });
            return res(r, (x) => `⏰ Banned **${x.target.tag}** — automatic unban ${ts(x.item.dueAt)} *(#${x.item.id})*.`);
        }
        if (sub === 'unban') {
            const r = await scheduleUnban({ userId: options.getString('id').trim(), when: options.getString('in'), actor });
            return res(r, (x) => `✅ <@${x.item.userId}> will be unbanned ${ts(x.item.dueAt)} *(#${x.item.id})*.`);
        }
        if (sub === 'message') {
            const r = await scheduleMessage(guild, { channelId: options.getChannel('channel').id, when: options.getString('in'), text: options.getString('text'), actor, invoker: member });
            return res(r, (x) => `✅ Message scheduled for ${ts(x.item.dueAt)} in ${x.channel} *(#${x.item.id})*.`);
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const definitions = [
    {
        name: 'timed',
        description: 'Schedule temp-bans, temporary roles and delayed actions',
        options: [
            { name: 'ban', description: 'Ban a member now and unban them automatically later (Admin+)', type: 1, options: [
                { name: 'user', description: 'Who to ban', type: 6, required: true },
                { name: 'duration', description: 'e.g. 12h, 3d, 1w', type: 3, required: true },
                { name: 'reason', description: 'Reason', type: 3, required: false, max_length: 400 },
                { name: 'delete_days', description: 'Days of their messages to delete (0-7)', type: 4, required: false, min_value: 0, max_value: 7 },
            ] },
            { name: 'role', description: 'Temporarily give (or take away) a role', type: 1, options: [
                { name: 'user', description: 'Member', type: 6, required: true },
                { name: 'role', description: 'Role', type: 8, required: true },
                { name: 'duration', description: 'How long, e.g. 2h, 7d', type: 3, required: true },
                { name: 'mode', description: 'grant = add now, remove later (default); revoke = remove now, restore later', type: 3, required: false, choices: [{ name: 'grant', value: 'grant' }, { name: 'revoke', value: 'revoke' }] },
            ] },
            { name: 'unban', description: 'Schedule an unban for a user ID (Admin+)', type: 1, options: [
                { name: 'id', description: 'User ID', type: 3, required: true },
                { name: 'in', description: 'When, e.g. 3d', type: 3, required: true },
            ] },
            { name: 'message', description: 'Schedule a message to be posted later (Admin+)', type: 1, options: [
                { name: 'channel', description: 'Where to post', type: 7, required: true, channel_types: [0, 5] },
                { name: 'in', description: 'When, e.g. 2h', type: 3, required: true },
                { name: 'text', description: 'Message text', type: 3, required: true, max_length: 1800 },
            ] },
            { name: 'list', description: 'Show scheduled actions', type: 1, options: [{ name: 'type', description: 'Filter by type', type: 3, required: false, choices: [{ name: 'unban', value: 'unban' }, { name: 'role removal', value: 'role_remove' }, { name: 'role grant', value: 'role_add' }, { name: 'message', value: 'message' }] }] },
            { name: 'cancel', description: 'Cancel a scheduled action', type: 1, options: [{ name: 'id', description: 'Action number', type: 4, required: true, min_value: 1 }] },
        ],
    },
];

module.exports = { tick, enqueue, pending, describe, TYPE_LABEL, data, commands, definitions, tempBan, timedRole, scheduleUnban, scheduleMessage, cancelItem, _internals: { execute } };
