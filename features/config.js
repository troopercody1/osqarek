// Per-feature settings registry.
//
// Every feature declares its settings here once. The /feature slash command and
// the dashboard "Features" page both read this schema, so defaults, validation
// and labels live in exactly one place. Values are stored in
// db.features.<name>.config (only values that differ from the default are kept).
const { store, isSnowflake } = require('./util');

// Setting types: bool | int | enum | channel | role | list
const FEATURES = {
    raid: {
        label: 'Raid Protection',
        icon: '🚨',
        description: 'Detects a burst of joins and puts the server into raid mode: new joiners are timed out / kicked / banned, and staff are alerted.',
        defaultEnabled: false,
        settings: [
            { key: 'joinThreshold', type: 'int', min: 3, max: 100, default: 8, label: 'Join threshold', desc: 'This many joins within the window triggers raid mode.' },
            { key: 'windowSeconds', type: 'int', min: 5, max: 600, default: 30, label: 'Window (seconds)', desc: 'Sliding window the joins are counted in.' },
            { key: 'action', type: 'enum', options: ['alert', 'timeout', 'kick', 'ban'], default: 'timeout', label: 'Action on raiders', desc: '"alert" only notifies staff and takes no action on members.' },
            { key: 'timeoutMinutes', type: 'int', min: 1, max: 40320, default: 60, label: 'Timeout length (minutes)', desc: 'Used when the action is "timeout" (Discord max is 28 days).' },
            { key: 'raidModeMinutes', type: 'int', min: 1, max: 1440, default: 10, label: 'Raid mode length (minutes)', desc: 'Raid mode ends this long after the last suspicious join.' },
            { key: 'youngAccountDays', type: 'int', min: 0, max: 365, default: 30, label: 'Only act on accounts younger than (days)', desc: 'During raid mode, older accounts are only flagged. 0 = act on every join.' },
            { key: 'actOnTriggerJoins', type: 'bool', default: true, label: 'Also act on the joins that triggered it', desc: 'Apply the action to the members who tripped the threshold, not just later joins.' },
            { key: 'pauseInvites', type: 'bool', default: false, label: 'Pause invites during raid mode', desc: 'Needs Manage Server. Invites are re-enabled when raid mode ends.' },
            { key: 'alertChannel', type: 'channel', default: '', label: 'Alert channel', desc: 'Falls back to the mod log channel.' },
            { key: 'pingRole', type: 'role', default: '', label: 'Role to ping on alert', desc: 'Optional.' },
        ],
    },
    evasion: {
        label: 'Ban Evasion Flags',
        icon: '🕵️',
        description: 'Compares new joiners to banned users (similar name, similar avatar, same invite, fresh account) and flags likely alts for staff review.',
        defaultEnabled: false,
        settings: [
            { key: 'flagScore', type: 'int', min: 10, max: 100, default: 60, label: 'Flag score', desc: 'Joiners scoring at or above this are flagged to staff (0-100).' },
            { key: 'autoAction', type: 'enum', options: ['flag', 'timeout', 'kick', 'ban'], default: 'flag', label: 'Automatic action', desc: '"flag" never acts on its own. Anything else applies at the auto-action score.' },
            { key: 'autoActionScore', type: 'int', min: 10, max: 100, default: 90, label: 'Auto-action score', desc: 'Minimum score for the automatic action.' },
            { key: 'timeoutMinutes', type: 'int', min: 1, max: 40320, default: 1440, label: 'Timeout length (minutes)', desc: 'Used when the automatic action is "timeout".' },
            { key: 'checkUsername', type: 'bool', default: true, label: 'Compare usernames', desc: 'Look-alike and near-identical names count.' },
            { key: 'checkAvatar', type: 'bool', default: true, label: 'Compare avatars', desc: 'Visually near-identical custom avatars count (best effort).' },
            { key: 'checkInvite', type: 'bool', default: true, label: 'Compare invites', desc: 'Same invite link as a banned user, or invited by one. Needs Manage Server.' },
            { key: 'checkTiming', type: 'bool', default: true, label: 'Compare account timing', desc: 'Account created shortly after a ban.' },
            { key: 'timingWindowDays', type: 'int', min: 1, max: 365, default: 14, label: 'Timing window (days)', desc: 'How soon after a ban a new account looks suspicious.' },
            { key: 'flagChannel', type: 'channel', default: '', label: 'Flag channel', desc: 'Falls back to the mod log channel.' },
            { key: 'pingRole', type: 'role', default: '', label: 'Role to ping on flag', desc: 'Optional.' },
        ],
    },
    impersonation: {
        label: 'Impersonation Guard',
        icon: '🎭',
        description: 'Catches members whose name or nickname copies a staff member or a protected name (including look-alike characters).',
        defaultEnabled: false,
        settings: [
            { key: 'threshold', type: 'int', min: 60, max: 100, default: 85, label: 'Match threshold (%)', desc: 'How similar a name must be to count. 100 = exact (after folding look-alikes).' },
            { key: 'action', type: 'enum', options: ['flag', 'rename', 'kick', 'ban'], default: 'rename', label: 'Action', desc: '"rename" sets their server nickname to ModeratedNickname#XXXX, which replaces the name shown in the server (a bot can\'t change someone\'s account username).' },
            { key: 'protectStaff', type: 'bool', default: true, label: 'Protect staff names', desc: 'Every staff member\'s name, nickname and display name is protected.' },
            { key: 'checkUpdates', type: 'bool', default: true, label: 'Re-check on name changes', desc: 'Not just on join.' },
            { key: 'dmUser', type: 'bool', default: true, label: 'DM the member', desc: 'Explain a rename.' },
            { key: 'protectedNames', type: 'list', default: [], label: 'Extra protected names', desc: 'Comma separated, e.g. "OsQarek, Support Team". Names under 5 characters are ignored (too many false positives).' },
            { key: 'exemptRoles', type: 'list', default: [], label: 'Exempt role IDs', desc: 'Comma separated role IDs that are never checked (staff are always exempt).' },
            { key: 'alertChannel', type: 'channel', default: '', label: 'Alert channel', desc: 'Falls back to the mod log channel.' },
        ],
    },
    timed: {
        label: 'Timed Actions',
        icon: '⏲️',
        description: 'Schedule temp-bans, temporary roles, delayed unbans and delayed messages. They survive restarts.',
        defaultEnabled: true,
        settings: [
            { key: 'maxDays', type: 'int', min: 1, max: 3650, default: 365, label: 'Max duration (days)', desc: 'Longest a timed action may be scheduled for.' },
            { key: 'dmOnTempBan', type: 'bool', default: true, label: 'DM temp-banned users', desc: 'Tell them how long the ban lasts (sent before the ban).' },
            { key: 'logToCases', type: 'bool', default: true, label: 'Record cases', desc: 'Temp-bans and their automatic unbans are added to the case list.' },
        ],
    },
    giveaways: {
        label: 'Giveaways',
        icon: '🎉',
        description: 'Button-entry giveaways with timed endings, role requirements and rerolls.',
        defaultEnabled: true,
        settings: [
            { key: 'maxWinners', type: 'int', min: 1, max: 25, default: 10, label: 'Max winners', desc: '' },
            { key: 'maxDays', type: 'int', min: 1, max: 365, default: 30, label: 'Max duration (days)', desc: '' },
            { key: 'minAccountDays', type: 'int', min: 0, max: 365, default: 0, label: 'Minimum account age (days)', desc: 'Entrants with newer accounts are turned away. 0 = no minimum.' },
            { key: 'dmWinners', type: 'bool', default: true, label: 'DM winners', desc: '' },
            { key: 'defaultChannel', type: 'channel', default: '', label: 'Default channel', desc: 'Where giveaways post if none is chosen.' },
        ],
    },
    polls: {
        label: 'Polls',
        icon: '📊',
        description: 'Button-vote polls with up to 10 options, optional multi-choice, anonymous voting and timed closing.',
        defaultEnabled: true,
        settings: [
            { key: 'maxOptions', type: 'int', min: 2, max: 10, default: 10, label: 'Max options', desc: '' },
            { key: 'maxDays', type: 'int', min: 1, max: 365, default: 14, label: 'Max duration (days)', desc: '' },
            { key: 'defaultAnonymous', type: 'bool', default: true, label: 'Anonymous by default', desc: 'Voters are hidden from the results unless the creator opts out.' },
            { key: 'allowChangeVote', type: 'bool', default: true, label: 'Allow changing votes', desc: '' },
        ],
    },
    audit: {
        label: 'Audit Log Viewer',
        icon: '📜',
        description: 'Browse Discord\'s audit log (and the bot\'s own activity feed) from the dashboard and /audit. Needs View Audit Log.',
        defaultEnabled: true,
        settings: [
            { key: 'pageSize', type: 'int', min: 5, max: 100, default: 25, label: 'Entries per page', desc: 'Dashboard page size.' },
        ],
    },
    analytics: {
        label: 'Analytics',
        icon: '📈',
        description: 'Daily message (bot + human, and human-only), join/leave, ban and busiest-hour stats. Counts only; no message content is stored.',
        defaultEnabled: true,
        settings: [
            { key: 'retentionDays', type: 'int', min: 7, max: 365, default: 90, label: 'Keep daily stats for (days)', desc: 'Older days are dropped to keep the database small.' },
            { key: 'trackChannels', type: 'bool', default: true, label: 'Track per-channel counts', desc: 'Top-channels chart. Stores channel IDs and counts only.' },
        ],
    },
    voice: {
        label: 'Voice Time Stats',
        icon: '🎙️',
        description: 'Tracks how long members spend in voice channels (per member, per channel, per day). Counts only — no audio or content. Stats start from when tracking is enabled.',
        defaultEnabled: true,
        settings: [
            { key: 'excludeAfk', type: 'bool', default: true, label: 'Ignore the AFK channel', desc: 'Time in the server\'s AFK voice channel is not counted.' },
            { key: 'retentionDays', type: 'int', min: 7, max: 365, default: 90, label: 'Keep daily voice stats for (days)', desc: 'All-time totals are kept forever; per-day detail older than this is dropped.' },
        ],
    },
};

const FEATURE_NAMES = Object.keys(FEATURES);

function getFeature(name) {
    return FEATURES[name] || null;
}

function defaultsFor(name) {
    const out = {};
    for (const s of FEATURES[name].settings) out[s.key] = s.default;
    return out;
}

function featureStore(db) {
    return store(db, 'settings', {});
}

// Effective config for a feature: defaults + saved overrides + `enabled`.
function getConfig(db, name) {
    const def = FEATURES[name];
    if (!def) throw new Error(`Unknown feature: ${name}`);
    const saved = featureStore(db)[name] || {};
    const cfg = { ...defaultsFor(name) };
    for (const s of def.settings) {
        if (saved[s.key] !== undefined) cfg[s.key] = saved[s.key];
    }
    cfg.enabled = saved.enabled !== undefined ? !!saved.enabled : def.defaultEnabled;
    return cfg;
}

function isEnabled(db, name) {
    return getConfig(db, name).enabled;
}

// Validates and coerces a raw (string / boolean) value for one setting.
// Returns { ok: true, value } or { ok: false, error }.
function coerce(setting, raw) {
    const v = typeof raw === 'string' ? raw.trim() : raw;
    switch (setting.type) {
        case 'bool': {
            if (typeof v === 'boolean') return { ok: true, value: v };
            const s = String(v).toLowerCase();
            if (['true', 'on', 'yes', '1', 'enable', 'enabled'].includes(s)) return { ok: true, value: true };
            if (['false', 'off', 'no', '0', 'disable', 'disabled'].includes(s)) return { ok: true, value: false };
            return { ok: false, error: `\`${setting.key}\` must be true or false.` };
        }
        case 'int': {
            const n = Number(v);
            if (v === '' || !Number.isInteger(n)) return { ok: false, error: `\`${setting.key}\` must be a whole number.` };
            if (n < setting.min || n > setting.max) return { ok: false, error: `\`${setting.key}\` must be between ${setting.min} and ${setting.max}.` };
            return { ok: true, value: n };
        }
        case 'enum': {
            const s = String(v).toLowerCase();
            if (!setting.options.includes(s)) return { ok: false, error: `\`${setting.key}\` must be one of: ${setting.options.join(', ')}.` };
            return { ok: true, value: s };
        }
        case 'channel':
        case 'role': {
            if (v === '' || v === null || v === undefined || String(v).toLowerCase() === 'none') return { ok: true, value: '' };
            const id = String(v).replace(/[<>#@&\s]/g, '');
            if (!isSnowflake(id)) return { ok: false, error: `\`${setting.key}\` must be a ${setting.type} ID or mention (or "none").` };
            return { ok: true, value: id };
        }
        case 'list': {
            const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
            const cleaned = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
            return { ok: true, value: cleaned };
        }
        default:
            return { ok: false, error: `Unsupported setting type for \`${setting.key}\`.` };
    }
}

function setValue(db, name, key, raw) {
    const def = FEATURES[name];
    if (!def) return { ok: false, error: `Unknown feature \`${name}\`.` };
    if (key === 'enabled') {
        const r = coerce({ key: 'enabled', type: 'bool' }, raw);
        if (!r.ok) return r;
        const s = featureStore(db);
        s[name] = { ...(s[name] || {}), enabled: r.value };
        return { ok: true, value: r.value };
    }
    const setting = def.settings.find((x) => x.key === key);
    if (!setting) {
        return { ok: false, error: `\`${key}\` isn't a setting of ${def.label}. Valid keys: ${['enabled', ...def.settings.map((x) => x.key)].map((k) => `\`${k}\``).join(', ')}.` };
    }
    const r = coerce(setting, raw);
    if (!r.ok) return r;
    const s = featureStore(db);
    s[name] = { ...(s[name] || {}), [key]: r.value };
    return { ok: true, value: r.value };
}

function resetFeature(db, name) {
    const s = featureStore(db);
    delete s[name];
}

// Applies a whole submitted dashboard form to one feature. Missing checkboxes
// mean "off". Returns { ok, errors[] }; nothing is written if anything fails.
function applyForm(db, name, body) {
    const def = FEATURES[name];
    if (!def) return { ok: false, errors: ['Unknown feature.'] };
    const next = { enabled: body.enabled === 'on' || body.enabled === 'true' };
    const errors = [];
    for (const s of def.settings) {
        const raw = s.type === 'bool' ? (body[s.key] === 'on' || body[s.key] === 'true') : (body[s.key] ?? '');
        const r = coerce(s, raw);
        if (!r.ok) errors.push(r.error); else next[s.key] = r.value;
    }
    if (errors.length) return { ok: false, errors };
    featureStore(db)[name] = next;
    return { ok: true, errors: [] };
}

module.exports = { FEATURES, FEATURE_NAMES, getFeature, getConfig, isEnabled, setValue, resetFeature, applyForm, coerce, defaultsFor };
