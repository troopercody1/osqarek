// --- TEMP CHANNEL SHARED HELPERS ---
// Backs the "Create Temp Channel" button/modal in TEMP_CHANNEL_MESSAGE, the
// /channel command group, and /mod channel-block. Kept in one place so the
// button/modal flow (handled inline in index.js, since that's where all the
// other component interactions live) and the modular /channel handler agree
// on how members are parsed and how permissions get built.

// Matches Discord user mentions (<@123>, <@!123>) or bare 15-20 digit
// snowflakes, so people can either @mention or paste raw IDs.
const MENTION_OR_ID_REGEX = /<@!?(\d+)>|\b(\d{15,20})\b/g;

// Pulls every user ID out of a free-text field, de-duped, in the order they
// first appeared. Used for both the modal's "who's allowed" field and the
// /channel add-voice `members` option.
function extractUserIds(text) {
    if (!text) return [];
    const ids = [];
    const seen = new Set();
    let match;
    MENTION_OR_ID_REGEX.lastIndex = 0;
    while ((match = MENTION_OR_ID_REGEX.exec(text)) !== null) {
        const id = match[1] || match[2];
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids;
}

function isTempChannelBlocked(db, userId) {
    return Array.isArray(db.tempChannelBlocked) && db.tempChannelBlocked.includes(userId);
}

// Builds a permission overwrite array: @everyone is denied ViewChannel, and
// the owner + every allowed user gets access appropriate to the channel type.
function buildTempChannelOverwrites({ guild, PermissionFlagsBits, ownerId, allowedIds = [], isVoice }) {
    const overwrites = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
        },
    ];

    const grantIds = new Set([ownerId, ...allowedIds]);
    for (const id of grantIds) {
        overwrites.push({
            id,
            allow: isVoice
                ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });
    }

    return overwrites;
}

// Finds the temp-channel record for a channel ID, checking both the record's
// own key and (for backwards compatibility with older saves) nothing else —
// kept as a function in case the storage shape changes later.
function getTempChannelRecord(db, channelId) {
    if (!db.tempChannels) return null;
    return db.tempChannels[channelId] || null;
}

function canManageTempChannel(record, userId, isMod) {
    if (!record) return false;
    return isMod || record.ownerId === userId;
}

module.exports = {
    extractUserIds,
    isTempChannelBlocked,
    buildTempChannelOverwrites,
    getTempChannelRecord,
    canManageTempChannel,
};
