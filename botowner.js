// The Bot Owner: a single hardcoded user that sits above every role.
// Not a Discord role — it's matched by user ID, so it can't be granted, removed or
// impersonated through role changes. No moderation action (warn, strike, mute, kick, ban,
// temp-ban, notes, role changes, auto-mod, ...) can be taken against this user, and they
// pass every staff rank check.
const BOT_OWNER_ID = '778819029041152010';
const BOT_OWNER_LABEL = 'Bot Owner';

// Accepts a user ID string, a User, or a GuildMember.
const isBotOwner = (who) => {
    if (!who) return false;
    const id = typeof who === 'string' ? who : (who.id || who.user?.id);
    return id === BOT_OWNER_ID;
};

module.exports = { BOT_OWNER_ID, BOT_OWNER_LABEL, isBotOwner };
