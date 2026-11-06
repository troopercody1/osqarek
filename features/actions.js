// Moderation primitives shared by the automatic features.
const { PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const { addCase, recordEvent, truncate } = require('./util');

function getGuild() {
    const { client, GUILD_ID } = context.get();
    return client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first() || null;
}

function channelFor(guild, preferredId) {
    const { db } = context.get();
    const id = preferredId || db.modLogChannel;
    if (!id) return null;
    const ch = guild.channels.cache.get(String(id));
    return ch && ch.isTextBased() ? ch : null;
}

// Posts an embed (optionally pinging a role + with buttons) to a feature's
// alert channel, falling back to the mod log channel. Never throws.
async function notify(guild, preferredChannelId, { embed, pingRoleId, components } = {}) {
    try {
        const ch = channelFor(guild, preferredChannelId);
        if (!ch) return null;
        const payload = { embeds: [embed] };
        if (components?.length) payload.components = components;
        if (pingRoleId) {
            payload.content = `<@&${pingRoleId}>`;
            payload.allowedMentions = { roles: [pingRoleId] };
        }
        return await ch.send(payload);
    } catch (err) {
        console.error('❌ features.notify failed:', err.message);
        return null;
    }
}

function isStaff(member, guild) {
    const { isStaffMember } = context.get();
    try { return !!member && isStaffMember(member, guild); } catch { return false; }
}

// Applies timeout / kick / ban to a user. Never acts on staff or bots.
// Returns { ok, outcome, error? }. `outcome` is a past-tense word for logs.
async function applyAction({ guild, userId, member = null, action, reason, timeoutMs = 3600000, caseType, moderator = 'Auto', logCase = true, deleteSeconds = 0 }) {
    const { db } = context.get();
    if (!guild) return { ok: false, error: 'Guild unavailable.' };
    if (!member) member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (member && (member.user.bot || isStaff(member, guild))) {
        return { ok: false, skipped: true, error: member.user.bot ? 'Bot account.' : 'Staff member.' };
    }
    const tag = member?.user?.tag || userId;
    const why = truncate(reason, 500);

    try {
        let outcome;
        if (action === 'timeout') {
            if (!member) return { ok: false, error: 'Member is not in the server.' };
            if (!member.moderatable) return { ok: false, error: 'Missing permission / role hierarchy (cannot timeout).' };
            const capped = Math.min(timeoutMs, 28 * 86400000);
            await member.timeout(capped, why);
            outcome = 'timed out';
            if (logCase) addCase(db, { type: caseType || '🔇 AUTO MUTE', userId, userTag: tag, reason, moderator });
        } else if (action === 'kick') {
            if (!member) return { ok: false, error: 'Member is not in the server.' };
            if (!member.kickable) return { ok: false, error: 'Missing permission / role hierarchy (cannot kick).' };
            await member.kick(why);
            outcome = 'kicked';
            if (logCase) addCase(db, { type: caseType || '👢 AUTO KICK', userId, userTag: tag, reason, moderator });
        } else if (action === 'ban') {
            if (member && !member.bannable) return { ok: false, error: 'Missing permission / role hierarchy (cannot ban).' };
            await guild.members.ban(userId, { reason: why, deleteMessageSeconds: deleteSeconds });
            outcome = 'banned';
            if (logCase) addCase(db, { type: caseType || '🔨 AUTO BAN', userId, userTag: tag, reason, moderator });
        } else {
            return { ok: true, outcome: 'alerted' };
        }
        recordEvent(db, 'action', `${outcome} ${tag} — ${reason}`, { userId });
        return { ok: true, outcome };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Highest-privilege check for the buttons staff press on alerts.
function memberIsMod(member) {
    const { STAFF_ROLE_IDS } = context.get();
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.guild?.ownerId === member.id) return true;
    const roles = member.roles?.cache;
    if (!roles) return false;
    return [STAFF_ROLE_IDS.mod, STAFF_ROLE_IDS.headMod, STAFF_ROLE_IDS.admin, STAFF_ROLE_IDS.headAdmin, STAFF_ROLE_IDS.coOwner, STAFF_ROLE_IDS.owner]
        .some((id) => roles.has(id));
}

function memberIsAdmin(member) {
    const { STAFF_ROLE_IDS } = context.get();
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.guild?.ownerId === member.id) return true;
    const roles = member.roles?.cache;
    if (!roles) return false;
    return [STAFF_ROLE_IDS.admin, STAFF_ROLE_IDS.headAdmin, STAFF_ROLE_IDS.coOwner, STAFF_ROLE_IDS.owner].some((id) => roles.has(id));
}

module.exports = { getGuild, channelFor, notify, isStaff, applyAction, memberIsMod, memberIsAdmin };
