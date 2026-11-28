// Role message-permission lock, shared by server lockdowns, drills and raid mode.
//
// While it is on, EVERY role the bot is allowed to edit loses its message permissions
// (Send Messages, Send in Threads, Create Public/Private Threads). The roles' original permissions
// are backed up first and put back exactly when the last "holder" lets go.
//
// Holders are reference-counted ('lockdown' | 'drill' | 'raid'), so overlapping events are safe:
// a raid that starts during a lockdown does NOT take a second backup (which would capture the
// already-stripped permissions and "restore" to a locked state). The first holder takes the backup and
// strips; the roles are only restored when the last holder releases.
//
// State lives in db.features.rolelock and the backup is saved BEFORE any role is changed, so a crash or
// restart mid-way can still be restored. Only the message bits are touched on restore, so any other
// permission change made to a role while locked is left alone.
//
// Not touched: roles with Administrator (they bypass everything anyway), managed/integration roles
// (including the bot's own role, so the bot can keep posting) and roles at/above the bot's top role
// (Discord won't let the bot edit those).
const { PermissionFlagsBits } = require('discord.js');
const context = require('./context');
const { store, truncate } = require('./util');

const STRIPPED = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const MASK = STRIPPED.reduce((m, n) => m | PermissionFlagsBits[n], 0n);
const EDIT_DELAY_MS = 150; // gentle pacing; discord.js also queues around rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// acquire()/release() run one at a time, in call order.
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => { }); return run; };

function data() {
    const { db } = context.get();
    // saved:    { [roleId]: { name, perms } }  perms = the role's FULL original permission bitfield (string)
    // leftover: same shape, roles that couldn't be restored last time (kept so nothing is lost)
    return store(db, 'rolelock', { active: false, since: null, holders: {}, saved: {}, skipped: 0, leftover: {} });
}

function status() {
    const d = data();
    return { active: d.active, since: d.since, holders: Object.keys(d.holders), roles: Object.keys(d.saved).length, leftover: Object.keys(d.leftover || {}).length };
}

const needManageRoles = (guild) => {
    const me = guild.members.me;
    return !(me?.permissions.has(PermissionFlagsBits.ManageRoles) || me?.permissions.has(PermissionFlagsBits.Administrator));
};

// Takes the lock for `holder`. First holder backs up + strips; later holders just register.
// Resolves { ok, already, stripped, skipped, failed[], msg }.
function acquire(guild, holder, { reason = 'Role lock' } = {}) {
    return serial(async () => {
        const d = data();
        d.holders[holder] = Date.now();
        if (d.active) {
            await context.get().safeSave();
            return { ok: true, already: true, stripped: Object.keys(d.saved).length, skipped: d.skipped || 0, failed: [], msg: `🛡️ Role message permissions are already stripped (held by ${Object.keys(d.holders).join(' + ')}).` };
        }
        if (needManageRoles(guild)) {
            delete d.holders[holder];
            return { ok: false, already: false, stripped: 0, skipped: 0, failed: [], msg: '⚠️ I need **Manage Roles** to strip role message permissions — roles were left unchanged.' };
        }

        // 1. Backup (no API calls) and persist it before touching anything.
        const saved = {};
        let skipped = 0;
        for (const role of guild.roles.cache.values()) {
            if (!(role.permissions.bitfield & MASK)) continue;                       // nothing to strip
            if (role.permissions.has(PermissionFlagsBits.Administrator)) { skipped++; continue; } // admins bypass it anyway
            if (!role.editable) { skipped++; continue; }                             // managed / above the bot
            saved[role.id] = { name: role.name, perms: role.permissions.bitfield.toString() };
        }
        d.active = true;
        d.since = Date.now();
        d.saved = saved;
        d.skipped = skipped;
        await context.get().safeSave();

        // 2. Strip.
        let stripped = 0;
        const failed = [];
        for (const [id, rec] of Object.entries(saved)) {
            const role = guild.roles.cache.get(id);
            if (!role) continue;
            try {
                await role.setPermissions(role.permissions.bitfield & ~MASK, truncate(reason, 400));
                stripped++;
            } catch (err) {
                failed.push(`${role.name} (${truncate(err.message, 40)})`);
            }
            await sleep(EDIT_DELAY_MS);
        }
        return {
            ok: true, already: false, stripped, skipped, failed,
            msg: `🛡️ Stripped message permissions from **${stripped}** role${stripped === 1 ? '' : 's'} (backed up; restored automatically when this ends).${skipped ? ` ${skipped} role${skipped === 1 ? '' : 's'} skipped (admin / managed / above me).` : ''}${failed.length ? `\n⚠️ Couldn't change: ${truncate(failed.join(', '), 600)}` : ''}`,
        };
    });
}

// Lets go of the lock for `holder`. When no holder is left, every backed-up role gets its message
// permissions back. Resolves { ok, stillHeld, restored, failed[], msg }.
function release(guild, holder, { reason = 'Role lock ended' } = {}) {
    return serial(async () => {
        const d = data();
        delete d.holders[holder];
        if (!d.active) return { ok: true, stillHeld: false, restored: 0, failed: [], msg: '' };
        const others = Object.keys(d.holders);
        if (others.length) {
            await context.get().safeSave();
            return { ok: true, stillHeld: true, restored: 0, failed: [], msg: `🛡️ Role message permissions stay stripped — still held by ${others.join(' + ')}.` };
        }

        let restored = 0;
        const failed = [];
        const leftover = {};
        for (const [id, rec] of Object.entries(d.saved)) {
            const role = guild.roles.cache.get(id);
            if (!role) continue; // deleted while locked — nothing to restore
            const original = BigInt(rec.perms) & MASK;
            const current = role.permissions.bitfield;
            const next = (current & ~MASK) | original;
            if (next === current) { restored++; continue; }
            if (!role.editable) { failed.push(`${rec.name} (can't edit)`); leftover[id] = rec; continue; }
            try {
                await role.setPermissions(next, truncate(reason, 400));
                restored++;
            } catch (err) {
                failed.push(`${rec.name} (${truncate(err.message, 40)})`);
                leftover[id] = rec;
            }
            await sleep(EDIT_DELAY_MS);
        }
        d.active = false;
        d.since = null;
        d.saved = {};
        d.skipped = 0;
        d.leftover = { ...(d.leftover || {}), ...leftover };
        await context.get().safeSave();
        return {
            ok: true, stillHeld: false, restored, failed,
            msg: `🛡️ Restored message permissions on **${restored}** role${restored === 1 ? '' : 's'}.${failed.length ? `\n⚠️ Couldn't restore: ${truncate(failed.join(', '), 600)} — their original permissions are kept in the database (features.rolelock.leftover).` : ''}`,
        };
    });
}

module.exports = { acquire, release, status, STRIPPED, MASK };
