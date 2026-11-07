// Feature bundle entry point.
//   - require('./features').definitions / .handlers  → used by commands/features (static, no client needed)
//   - require('./features').init(ctx)                → called once from index.js after the client exists
const context = require('./context');
const { makeDebouncedSaver } = require('./util');

const modules = {
    raid: require('./raid'),
    lockdown: require('./lockdown'),
    evasion: require('./evasion'),
    impersonation: require('./impersonation'),
    timed: require('./timed'),
    giveaways: require('./giveaways'),
    polls: require('./polls'),
    cases: require('./cases'),
    audit: require('./audit'),
    analytics: require('./analytics'),
    featurecmd: require('./featurecmd'),
};

const definitions = Object.values(modules).flatMap((m) => m.definitions || []);
const handlers = Object.assign({}, ...Object.values(modules).map((m) => m.commands || {}));

const safe = (label, fn) => async (...args) => {
    try { await fn(...args); } catch (err) { console.error(`❌ [features:${label}]`, err); }
};

let started = false;

// ctx: { client, db, GUILD_ID, safeSave, logAction, STAFF_ROLE_IDS, isStaffMember, getCachedMembers, app, checkAuth, renderDashboard }
function init(ctx) {
    if (started) return;
    started = true;
    const { client, db } = ctx;
    ctx.saveLater = makeDebouncedSaver(db, 30000);
    context.set(ctx);

    const { raid, evasion, impersonation, analytics } = modules;
    const guildOk = (g) => g && g.id === (client.guilds.cache.get(ctx.GUILD_ID)?.id || g.id);

    client.on('guildMemberAdd', safe('join', async (member) => {
        if (!guildOk(member.guild)) return;
        analytics.onJoin(member);
        await raid.onJoin(member);
        await evasion.onJoin(member);
        await impersonation.onJoin(member);
    }));
    client.on('guildMemberRemove', safe('leave', async (member) => { if (guildOk(member.guild)) analytics.onLeave(member); }));
    client.on('guildMemberUpdate', safe('update', (o, n) => impersonation.onMemberUpdate(o, n)));
    client.on('messageCreate', safe('message', async (m) => analytics.onMessage(m)));
    client.on('guildBanAdd', safe('ban', async (ban) => {
        if (!guildOk(ban.guild)) return;
        analytics.onBan();
        const full = ban.partial ? await ban.fetch().catch(() => null) : ban;
        await evasion.recordBan(full?.user || ban.user, full?.reason);
    }));
    client.on('guildBanRemove', safe('unban', async (ban) => evasion.forgetBan(ban.user.id)));
    client.on('inviteCreate', safe('invite+', async (inv) => evasion.cacheInvite(inv)));
    client.on('inviteDelete', safe('invite-', async (inv) => evasion.dropInvite(inv.code)));
    context.bus.on('raid:start', () => analytics.onRaid());
    context.bus.on('drill:start', () => analytics.onDrill());
    context.bus.on('lockdown:start', () => analytics.onLockdown());

    const onReady = safe('ready', async () => {
        const guild = client.guilds.cache.get(ctx.GUILD_ID) || client.guilds.cache.first();
        if (!guild) return;
        await evasion.cacheInvites(guild);
        await evasion.backfillBans(guild);
        analytics.snapshot(guild);
        console.log('🧩 Features online: raid, lockdown, drills, evasion, impersonation, timed, giveaways, polls, audit, analytics.');
    });
    if (client.isReady()) onReady(); else client.once('clientReady', onReady);

    // One scheduler for everything time-based. Overlap-guarded; each job isolated.
    let busy = false;
    setInterval(async () => {
        if (busy || !client.isReady()) return;
        busy = true;
        try {
            for (const [label, fn] of [['raid', raid.tick], ['lockdown', modules.lockdown.tick], ['timed', modules.timed.tick], ['giveaways', modules.giveaways.tick], ['polls', modules.polls.tick], ['evasion', evasion.tick], ['analytics', analytics.tick]]) {
                try { await fn(); } catch (err) { console.error(`❌ [features:${label}] tick failed:`, err.message); }
            }
        } finally { busy = false; }
    }, 10000);

    // Dashboard routes
    require('./dashboard').register(ctx, modules);
}

// Returns true when the interaction belonged to a feature (buttons).
async function handleInteraction(interaction) {
    if (!interaction.isButton()) return false;
    const id = interaction.customId;
    try {
        if (id.startsWith('gw:')) { await modules.giveaways.handleButton(interaction); return true; }
        if (id.startsWith('poll:')) { await modules.polls.handleButton(interaction); return true; }
        if (id.startsWith('ev:')) { await modules.evasion.handleButton(interaction); return true; }
    } catch (err) {
        console.error('❌ [features] button failed:', err);
        if (!interaction.replied && !interaction.deferred) interaction.reply({ content: '❌ Something went wrong.', flags: 64 }).catch(() => { });
        return true;
    }
    return false;
}

module.exports = { init, handleInteraction, definitions, handlers, modules };
