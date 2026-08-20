process.env.TZ = 'Europe/London';
const { checkMessage } = require('./badwords.js');
const { commandNames: DEPLOYED_COMMAND_NAMES } = require('./commands');
const commandHandlers = require('./commands/handlers');

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
    console.log('🌐 DNS result order set to ipv4first (workaround for hosts with broken IPv6 routing to Discord).');
}

// --- ONE-TIME NETWORK PROBE ---
// Directly hits Discord's REST API with a hard 8s timeout, bypassing discord.js entirely,
// to prove/disprove whether this host's egress can reach Discord at all.
(function probeDiscordConnectivity() {
    const https = require('https');
    const start = Date.now();
    const req = https.get('https://discord.com/api/v10/gateway', { timeout: 8000 }, (res) => {
        console.log(`🩺 [probe] Reached discord.com — status ${res.statusCode} in ${Date.now() - start}ms`);
        res.resume();
    });
    req.on('timeout', () => {
        console.error(`🩺 [probe] TIMED OUT after ${Date.now() - start}ms reaching discord.com — egress to Discord is likely blocked/blackholed on this host.`);
        req.destroy();
    });
    req.on('error', (err) => {
        console.error(`🩺 [probe] ERROR reaching discord.com after ${Date.now() - start}ms:`, err.message);
    });
})();

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const play = require('play-dl');
const { Redis } = require('@upstash/redis');
const session = require('express-session');
const axios = require('axios');

// --- INITIALIZATION ---
const app = express();
app.set('trust proxy', 1);

// Redis Init
let redis;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    console.log("✅ Upstash Redis client initialized.");
}

// Global Variables

global.botErrors = global.botErrors || [];
global.botLogs = global.botLogs || [];
global.db = global.db || { settings: {}, reviewedUsers: [], reactionRoles: [], bannedWords: [], cases: [], dmThreads: {}, aiEnabled: true, musicEnabled: true, modmailEnabled: true, automodEnabled: true, welcomeEnabled: true, remindersEnabled: true, moderationEnabled: true, utilitiesEnabled: true, funEnabled: true, quizEnabled: true, staffToolsEnabled: true };

// Error Handling
process.on('uncaughtException', (err) => console.error('CRITICAL DASHBOARD ERROR:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Promise Rejection:', reason));

const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID || '771423231114084353';
const ALLOWED_ROLES = ["850513944329191445", "1511810524818440243", "771423764511981599", "850513087399329823", "801828933800296478", "772558550555295794"];

let client;

async function safeSave() {
    try { await db.save(); console.log("💾 Database synced."); } catch (e) { console.error("❌ Sync failed:", e.message); }
}

async function sendDiscordWebhook({ title, message, color = 0x5865F2 }) {
    const webhookUrl = (db.settings?.discordWebhook || db.settings?.slackWebhook || '').trim();
    if (!webhookUrl) {
        console.error("❌ Discord webhook skipped: no webhook URL is configured.");
        return false;
    }

    let parsedWebhookUrl;
    try {
        parsedWebhookUrl = new URL(webhookUrl);
    } catch {
        console.error("❌ Discord webhook skipped: the configured URL is invalid.");
        return false;
    }

    const isDiscordWebhook =
        parsedWebhookUrl.protocol === 'https:' &&
        ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(parsedWebhookUrl.hostname) &&
        /^\/api\/webhooks\/\d+\/[^/]+\/?$/.test(parsedWebhookUrl.pathname);

    if (!isDiscordWebhook) {
        console.error("❌ Discord webhook skipped: the configured URL is not a Discord webhook URL.");
        return false;
    }

    try {
        await axios.post(webhookUrl, {
            content: message,
            username: "OsQarek Universe",
            embeds: [{
                title,
                description: message,
                color,
                timestamp: new Date().toISOString(),
                footer: { text: "OsQarek Universe Dashboard" }
            }]
        });
        console.log("✅ Discord webhook sent.");
        return true;
    } catch (err) {
        console.error("❌ Discord webhook failed:", err.response?.data?.message || err.message);
        return false;
    }
}

// --- DEBOUNCED SAVE ---
// Coalesces rapid-fire db.save() calls into a single write a few seconds later.
// Use for non-critical updates (stats, message logs etc). Use safeSave() directly
// when the user needs an immediate guarantee the data was persisted (e.g. before redirects).
let _saveTimeout = null;
function queueSave(delayMs = 5000) {
    if (_saveTimeout) return;
    _saveTimeout = setTimeout(async () => {
        _saveTimeout = null;
    
    }, delayMs);
}

// --- MEMBER CACHE ---
// guild.members.fetch() hits the Discord API and can pull thousands of records.
// Cache the result briefly so repeated calls (e.g. every dashboard page load)
// don't re-fetch every time.
const _memberCache = new Map(); // guildId -> { data, ts }
async function getCachedMembers(guild, { ttl = 60000, force = false } = {}) {
    const cached = _memberCache.get(guild.id);
    if (!force && cached && Date.now() - cached.ts < ttl) return cached.data;
    const fetched = await guild.members.fetch().catch(() => guild.members.cache);
    _memberCache.set(guild.id, { data: fetched, ts: Date.now() });
    return fetched;
}

// --- CENTRAL EMBED FACTORY ---
// Wraps EmbedBuilder with the bot's brand defaults (Neon Purple, timestamp,
// standard footer) so every embed looks consistent without repeating setup.
// Pass `client` for the default author icon, or set author: false to omit it.
const BRAND_COLOR = '#5500FF'; // Neon Blue/Purple
function createEmbed({
    title,
    description,
    color = BRAND_COLOR,
    footer,
    author,       // string -> shown as author name with bot avatar; omit for no author block
    client,       // needed to pull the bot's avatar for the author icon
    timestamp = true,
    fields,
    thumbnail,
    image,
} = {}) {
    const embed = new EmbedBuilder().setColor(color);

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (fields) embed.addFields(fields);
    if (thumbnail) embed.setThumbnail(thumbnail);
    if (image) embed.setImage(image);
    if (timestamp) embed.setTimestamp();

    if (author) {
        embed.setAuthor({
            name: author,
            iconURL: client?.user?.displayAvatarURL?.(),
        });
    }

    if (footer) {
        embed.setFooter(typeof footer === 'string' ? { text: footer } : footer);
    }

    return embed;
}

// --- EXPRESS MIDDLEWARE ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60000 * 60 * 24 }
}));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => {
    const maintenanceWhitelist = [
        '/login',
        '/auth/discord',
        '/auth/callback',
        '/auth/admin',
        '/auth/verify-admin',
        '/verify',
        '/verify/login',
        '/verify/callback',
        '/verify/submit',
    ];

    // Dynamically whitelist `/settings` for admin users
    if (req.session?.user?.id === 'admin') {
        maintenanceWhitelist.push('/settings');
        maintenanceWhitelist.push('/settings/toggle-maintenance');
        maintenanceWhitelist.push('/settings/maintenance-config');
        maintenanceWhitelist.push('/settings/rate-limit');
        maintenanceWhitelist.push('/settings/toggle-https');
        maintenanceWhitelist.push('/settings/toggle-bots');
        maintenanceWhitelist.push('/settings/ip-allowlist');
        maintenanceWhitelist.push('/settings/cache-strategy');
        maintenanceWhitelist.push('/settings/toggle-image-opt');
        maintenanceWhitelist.push('/settings/purge-cache');
        maintenanceWhitelist.push('/settings/toggle-downtime-alerts');
        maintenanceWhitelist.push('/settings/discord-webhook');
        maintenanceWhitelist.push('/settings/flush-sessions');
        maintenanceWhitelist.push('/settings/reset');
    }

    if (
        db.settings?.maintenanceMode &&
        !maintenanceWhitelist.includes(req.path)
    ) {
        return res.render('maintenance', { 
            stats: { botName: client?.user?.username || "OsQarek's Universe" }
        });
    }
    next();
});

// Logging Helpers
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { global.botLogs.push({ time: new Date().toLocaleTimeString('en-GB'), text: args.join(' ') }); if (global.botLogs.length > 100) global.botLogs.shift(); originalLog(...args); };
console.error = (...args) => { global.botErrors.push({ time: new Date().toLocaleTimeString('en-GB'), text: args.join(' ') }); if (global.botErrors.length > 50) global.botErrors.shift(); originalError(...args); };

function checkAuth(req, res, next) {
    if (req.session?.user && req.session.isHeadAdmin) return next();
    res.redirect('/login');
}

// --- ROUTES ---
app.get('/login', (req, res) => {
    if (req.session?.user && req.session.isHeadAdmin) return res.redirect(req.session.user?.id === 'admin' ? '/settings' : '/');
    res.render('login', { error: req.query.error || null, stats: { botName: client?.user?.username || "OsQarek’s Universe" } });
});

app.get('/admin/user/:userId', checkAuth, (req, res) => {
    const userId = req.params.userId;

    const history = (db.cases || []).filter(c => c.userId === userId);

    res.render('user-history', {
        userId,
        history,
        user: req.session.user,
        stats: { botName: client?.user?.username || "OsQarek’s Universe" }
    });
});


app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Session destruction error:", err);
            return res.status(500).send("Logout failed");
        }
        res.redirect('/login');
    });
});

app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({ client_id: process.env.CLIENT_ID, redirect_uri: process.env.DASHBOARD_CALLBACK_URL, response_type: 'code', scope: 'identify guilds.members.read' });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DASHBOARD_CALLBACK_URL }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const user = (await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` } })).data;
        const member = (await axios.get(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, { headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` } })).data;
        if (!member.roles.some(r => ALLOWED_ROLES.includes(r))) return res.redirect('/login?error=Unauthorized');
        req.session.user = user;
        req.session.isHeadAdmin = true;
        res.redirect('/');
    } catch (err) {
        console.error('❌ [oauth callback] Discord auth failed:', err.response?.data || err.message);
        res.redirect('/login?error=AuthFailed');
    }
});

app.get('/auth/admin', (req, res) => res.render('admin', { error: req.query.error || null, msg: req.query.msg || null }));

// --- PUBLIC VERIFICATION GATE ---
// Lets ordinary members verify via Discord OAuth + CAPTCHA + a rules-agreement
// checkbox, then the bot adds the configured "verified" role. This is
// deliberately kept on its own session key (req.session.verifyUser) rather than
// req.session.user / req.session.isHeadAdmin — those two are what checkAuth()
// checks to grant admin dashboard access, so a member completing verification
// must never be able to touch them.
const VERIFY_CALLBACK_URL = process.env.VERIFY_CALLBACK_URL; // e.g. https://yourdomain.com/verify/callback
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;
const HCAPTCHA_SITE_KEY = process.env.HCAPTCHA_SITE_KEY;
const HCAPTCHA_SECRET_KEY = process.env.HCAPTCHA_SECRET_KEY;

app.get('/verify', (req, res) => {
    res.render('verify', {
        discordUser: req.session.verifyUser || null,
        hcaptchaSiteKey: HCAPTCHA_SITE_KEY,
        error: req.query.error || null,
        success: req.query.success || null,
        stats: { botName: client?.user?.username || "OsQarek's Universe" }
    });
});

app.get('/verify/login', (req, res) => {
    if (!VERIFY_CALLBACK_URL) return res.redirect('/verify?error=' + encodeURIComponent('Verification is not configured yet — missing VERIFY_CALLBACK_URL.'));
    const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        redirect_uri: VERIFY_CALLBACK_URL,
        response_type: 'code',
        scope: 'identify'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/verify/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/verify?error=' + encodeURIComponent('Discord login was cancelled or failed.'));
    try {
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: VERIFY_CALLBACK_URL
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const discordUser = (await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        })).data;

        req.session.verifyUser = { id: discordUser.id, username: discordUser.username, avatar: discordUser.avatar };
        res.redirect('/verify');
    } catch (err) {
        console.error('❌ [verify oauth] Discord auth failed:', err.response?.data || err.message);
        res.redirect('/verify?error=' + encodeURIComponent('Discord login failed. Please try again.'));
    }
});

app.post('/verify/submit', async (req, res) => {
    const discordUser = req.session.verifyUser;
    const captchaToken = req.body['h-captcha-response'];
    const agreedToRules = req.body.agree === 'on';

    if (!discordUser) return res.redirect('/verify?error=' + encodeURIComponent('Please log in with Discord first.'));
    if (!agreedToRules) return res.redirect('/verify?error=' + encodeURIComponent('You must agree to the rules to continue.'));
    if (!captchaToken) return res.redirect('/verify?error=' + encodeURIComponent('Please complete the CAPTCHA.'));
    if (!VERIFIED_ROLE_ID || !HCAPTCHA_SECRET_KEY) {
        console.error('❌ [verify submit] Missing VERIFIED_ROLE_ID or HCAPTCHA_SECRET_KEY env var.');
        return res.redirect('/verify?error=' + encodeURIComponent('Verification is not fully configured. Contact staff.'));
    }

    try {
        const captchaCheck = await axios.post(
            'https://hcaptcha.com/siteverify',
            new URLSearchParams({ secret: HCAPTCHA_SECRET_KEY, response: captchaToken }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        if (!captchaCheck.data.success) {
            return res.redirect('/verify?error=' + encodeURIComponent('CAPTCHA verification failed. Please try again.'));
        }

        const guild = client?.guilds?.cache.get(GUILD_ID);
        if (!guild) return res.redirect('/verify?error=' + encodeURIComponent('Server is temporarily unavailable. Try again shortly.'));

        const member = await guild.members.fetch(discordUser.id).catch(() => null);
        if (!member) {
            return res.redirect('/verify?error=' + encodeURIComponent('You need to join the Discord server before verifying.'));
        }

        if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
            await member.roles.add(VERIFIED_ROLE_ID, 'Completed website verification (CAPTCHA + rules agreement)');
        }

        logAction(guild, '✅ Member Verified', `<@${discordUser.id}> (\`${discordUser.id}\`) completed website verification.`, 0x00FF00);

        delete req.session.verifyUser;
        res.redirect('/verify?success=1');
    } catch (err) {
        console.error('❌ [verify submit] Verification failed:', err.response?.data || err.message);
        res.redirect('/verify?error=' + encodeURIComponent('Something went wrong. Please try again.'));
    }
});

app.post('/auth/verify-admin', (req, res) => {
    if (!process.env.ADMIN_PASS) {
        console.error("❌ [admin login] ADMIN_PASS is not set in .env.");
        return res.redirect('/auth/admin?error=Admin+login+is+not+configured');
    }
    const submitted = req.body.password || '';
    // Constant-time-ish comparison to avoid trivial timing leaks
    const valid = submitted.length === process.env.ADMIN_PASS.length &&
        crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(process.env.ADMIN_PASS));
    if (valid) {
        req.session.user = { id: 'admin', username: 'Master Admin', avatar: null };
        req.session.isHeadAdmin = true;
        res.redirect('/settings');
    } else {
        res.redirect('/auth/admin?error=Invalid+Code');
    }
});

app.get('/settings', (req, res) => {
    if (req.session.user?.id === 'admin') {
        res.render('settings', { user: req.session.user, settings: db.settings || {}, bannedWords: db.bannedWords || [], msg: req.query.msg || null });
    } else res.status(403).send("<h1>403 Forbidden</h1><p>Access denied.</p>");
});

app.get("/admin/filter/:type", checkAuth, async (req, res) => {
    const type = req.params.type.toUpperCase();

    const filtered = (db.cases || []).filter(c => c.type === type);

    res.render("index", {
        stats: {
            botName: client?.user?.username || "Dashboard",
            botStatus: client?.readyAt ? "ONLINE" : "OFFLINE",
            guildsCount: client?.guilds?.cache.size || 0,
            totalUsers: client?.users?.cache.size || 0,
            ping: `${Math.round(client?.ws?.ping || 0)}ms`,
            uptime: "N/A"
        },
        members: [],
        emojis: [],
        cases: filtered,
        settings: db.settings || {},
        reactionRoles: db.reactionRoles || [],
        bannedWords: db.bannedWords || [],
        user: req.session.user,
        logs: global.botLogs,
        errors: global.botErrors,
        db,
        activeTab: "infractions"   // ⭐ tells index.ejs which tab to open
    });
});
app.get("/admin/search", checkAuth, async (req, res) => {
    const q = (req.query.q || "").toLowerCase();

    const results = (db.cases || []).filter(c =>
        c.user?.toLowerCase().includes(q) ||
        c.userId?.toLowerCase().includes(q) ||
        c.type?.toLowerCase().includes(q) ||
        c.reason?.toLowerCase().includes(q)
    );

    res.render("index", {
        stats: {
            botName: client?.user?.username || "Dashboard",
            botStatus: client?.readyAt ? "ONLINE" : "OFFLINE",
            guildsCount: client?.guilds?.cache.size || 0,
            totalUsers: client?.users?.cache.size || 0,
            ping: `${Math.round(client?.ws?.ping || 0)}ms`,
            uptime: "N/A"
        },
        members: [],
        emojis: [],
        cases: results,
        settings: db.settings || {},
        reactionRoles: db.reactionRoles || [],
        bannedWords: db.bannedWords || [],
        user: req.session.user,
        logs: global.botLogs,
        errors: global.botErrors,
        db,
        activeTab: "infractions"   // ⭐ auto-open the correct tab
    });
});

app.get('/', checkAuth, async (req, res) => {
    const guild = client?.guilds?.cache.get(GUILD_ID);
    let members = [], emojis = [];
    if (guild) {
        const fetched = await getCachedMembers(guild); // cached ~60s, avoids re-fetching full member list on every page load
        members = Array.from(fetched.values()).filter(m => !(db.reviewedUsers || []).includes(m.id));
        emojis = guild.emojis.cache.map(e => ({ id: e.id, name: e.name, toString: e.toString() }));
    }
    const uptimeSec = Math.floor(process.uptime());
    const hh = Math.floor(uptimeSec / 3600);
    const mm = Math.floor((uptimeSec % 3600) / 60);
    const ss = uptimeSec % 60;
    const uptimeStr = hh > 0 ? `${hh}h ${mm}m` : mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
    res.render('index', {
        stats: {
            botName: client?.user?.username || "Dashboard",
            botStatus: client?.readyAt ? "ONLINE" : "OFFLINE",
            guildsCount: client?.guilds?.cache.size || 0,
            totalUsers: client?.users?.cache.size || 0,
            ping: `${Math.round(client?.ws?.ping || 0)}ms`,
            uptime: uptimeStr,
        },
        members, emojis,
        cases: db.cases || [],
        settings: db.settings || {},
        reactionRoles: db.reactionRoles || [],
        bannedWords: db.bannedWords || [],
        user: req.session.user,
        logs: global.botLogs,
        errors: global.botErrors,
        db,
    });
});

app.post('/update-settings', checkAuth, async (req, res) => { db.settings = { prefix: req.body.prefix, welcomeChannel: req.body.welcomeChannel, goodbyeChannel: req.body.goodbyeChannel }; await safeSave(); res.redirect('/'); });
app.post('/review-risk/:userId', checkAuth, async (req, res) => { if (!db.reviewedUsers) db.reviewedUsers = []; if (!db.reviewedUsers.includes(req.params.userId)) { db.reviewedUsers.push(req.params.userId); await safeSave(); } res.redirect('/#risk-manager'); });
app.post('/add-reaction-role', checkAuth, async (req, res) => { if (!db.reactionRoles) db.reactionRoles = []; db.reactionRoles.push({ emoji: req.body.emoji, roleId: req.body.roleId, messageId: req.body.messageId }); await safeSave(); res.redirect('/'); });
app.post('/banned-words/add', checkAuth, async (req, res) => { if (!db.bannedWords) db.bannedWords = []; if (!db.bannedWords.includes(req.body.word)) { db.bannedWords.push(req.body.word); await safeSave(); } res.redirect('/#banned-words'); });
app.post('/banned-words/remove', checkAuth, async (req, res) => { if (!db.bannedWords) db.bannedWords = []; db.bannedWords = db.bannedWords.filter(w => w !== req.body.word); await safeSave(); res.redirect('/#banned-words'); });
app.post("/create-case", checkAuth, async (req, res) => {
    const { user, userId, type, reason } = req.body;

    if (!db.cases) db.cases = [];

    const nextId = db.cases.length > 0
        ? Math.max(...db.cases.map(c => c.id)) + 1
        : 1;

    db.cases.push({
        id: nextId,
        user,
        userId,
        type: type.toUpperCase(),
        reason: reason || "No reason given",
        timestamp: new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })
    });

    await safeSave();
    res.redirect("/admin?tab=infractions");
});
app.post('/remove-reaction-role/:index', checkAuth, async (req, res) => {
    const i = parseInt(req.params.index, 10);
    if (!isNaN(i) && db.reactionRoles && db.reactionRoles[i]) {
        db.reactionRoles.splice(i, 1);
    
    }
    res.redirect('/#roles');
});

app.post('/edit-case/:index', checkAuth, async (req, res) => {
    const i = parseInt(req.params.index, 10);
    if (!isNaN(i) && db.cases && db.cases[i]) {
        db.cases[i].reason = req.body.reason || db.cases[i].reason;
    
    }
    res.redirect('/#infractions');
});

// --- MODULE TOGGLES ---
const TOGGLEABLE_MODULES = ['aiEnabled', 'musicEnabled', 'modmailEnabled', 'automodEnabled', 'welcomeEnabled', 'remindersEnabled', 'moderationEnabled', 'utilitiesEnabled', 'funEnabled', 'quizEnabled', 'staffToolsEnabled'];
const MODULE_COMMANDS = {
    aiEnabled: ['summarize', 'ask-rules'],
    musicEnabled: ['music'],
    modmailEnabled: [],
    remindersEnabled: ['reminder'],
    moderationEnabled: ['mod', 'warn', 'mute', 'unmute', 'slowmode', 'case', 'reason', 'reactionrole', 'role', 'clearall', 'announce', 'globalannounce', 'latest-action', 'userignore', 'nickname'],
    utilitiesEnabled: ['ping', 'serverinfo', 'userinfo', 'pfp', 'poll', 'random', 'afk', 'osqareksocials', 'emoji-names', 'latest-update'],
    funEnabled: ['fun', 'ship', 'ban-prank', 'keyboard-fix', 'nuke-server', 'reset-levels', 'nerd-mode'],
    quizEnabled: ['quiz', 'stateleaderboard'],
    staffToolsEnabled: ['staffstats', 'syncstats', 'messagereset', 'staffdm', 'ping-all-staff', 'loa', 'strike', 'strikes', 'notes'],
};
const MODULE_LABELS = {
    aiEnabled: 'AI',
    musicEnabled: 'Music',
    modmailEnabled: 'Modmail',
    remindersEnabled: 'Reminders',
    moderationEnabled: 'Moderation',
    utilitiesEnabled: 'Utilities',
    funEnabled: 'Fun',
    quizEnabled: 'Quiz',
    staffToolsEnabled: 'Staff Tools',
};

// Every command name this handler actually has an `if (commandName === '...')`
// case for. Used by the post-handler safety net below to detect a registered
// slash command whose name doesn't match anything here (the #1 cause of a
// command deferring successfully — showing "is thinking..." — and then never
// getting a reply).
const KNOWN_COMMAND_NAMES = new Set([
    ...DEPLOYED_COMMAND_NAMES,
    'addmod', 'afk', 'aitoggle', 'announce', 'apply', 'ask-rules', 'ban-prank',
    'case', 'clearall', 'deletemod', 'emoji-names', 'fun', 'globalannounce',
    'help', 'ignorechannel', 'keyboard-fix', 'latest-action', 'latest-update',
    'loa', 'messagereset', 'mod', 'modlog', 'music', 'mute', 'nerd-mode',
    'nickname', 'notes', 'nuke-server', 'osqareksocials', 'pfp', 'ping',
    'ping-all-staff', 'poll', 'quiz', 'random', 'reactionrole', 'reason',
    'reminder', 'reset-levels', 'restart', 'role', 'serverinfo', 'setchatlog',
    'setloachannel', 'ship', 'slowmode', 'staff-leaderboard', 'staffdm',
    'staffstats', 'stateleaderboard', 'status', 'strike', 'strikes',
    'summarize', 'syncstats', 'togglecommand', 'unmute', 'userignore', 'userinfo',
    'warn'
]);

function getDisabledModuleForCommand(commandName) {
    const normalized = commandName.toLowerCase();
    return Object.entries(MODULE_COMMANDS).find(([moduleKey, commands]) =>
        db[moduleKey] === false && commands.includes(normalized)
    );
}

app.post('/modules/toggle', checkAuth, async (req, res) => {
    const mod = req.body.module;
    if (!TOGGLEABLE_MODULES.includes(mod)) return res.status(400).send('Unknown module');
    if (db[mod] === undefined) db[mod] = true;
    db[mod] = !db[mod];

    res.redirect('/#modules');
});
app.post('/settings/toggle-maintenance', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = { maintenanceMode: false };
    db.settings.maintenanceMode = !db.settings.maintenanceMode;
    await db.save();
    const title = db.settings.maintenanceMode ? "Maintenance Mode Enabled" : "Maintenance Mode Disabled";
    const message = db.settings.maintenanceMode
        ? "The site has been switched into maintenance mode. Visitors will see the maintenance page."
        : "The site has been switched back to live mode. Visitors can access it again.";

    await sendStatusChangeEmail({
        subject: db.settings.maintenanceMode ? "Maintenance mode enabled" : "Site is live again",
        title,
        message
    });
    await sendDiscordWebhook({
        title,
        message,
        color: db.settings.maintenanceMode ? 0xE0AF68 : 0x9ECE6A
    });
    res.redirect('/settings?msg=' + (db.settings.maintenanceMode ? 'Maintenance+ON' : 'Maintenance+OFF'));
});

app.post('/settings/maintenance-config', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.maintenanceETA     = req.body.eta              || '';
    db.settings.maintenanceMessage = req.body.maintenanceMessage || '';
    db.settings.bypassIPs          = req.body.bypassIPs         || '';
    await db.save();
    res.redirect('/settings?msg=Maintenance+config+saved');
});

app.post('/settings/rate-limit', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.rateLimit = parseInt(req.body.rateLimit, 10) || 100;
    await db.save();
    res.redirect('/settings?msg=Rate+limit+updated');
});

app.post('/settings/toggle-https', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.forceHttps = !db.settings.forceHttps;
    await db.save();
    res.redirect('/settings?msg=HTTPS+setting+updated');
});

app.post('/settings/toggle-bots', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.blockBots = !db.settings.blockBots;
    await db.save();
    res.redirect('/settings?msg=Bot+blocking+updated');
});

app.post('/settings/ip-allowlist', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.ipAllowlist = req.body.ipAllowlist || '';
    await db.save();
    res.redirect('/settings?msg=IP+allowlist+saved');
});

app.post('/settings/cache-strategy', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.cacheStrategy = req.body.cacheStrategy || 'balanced';
    await db.save();
    res.redirect('/settings?msg=Cache+strategy+updated');
});

app.post('/settings/toggle-image-opt', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.imageOptimisation = !db.settings.imageOptimisation;
    await db.save();
    res.redirect('/settings?msg=Image+optimisation+updated');
});

app.post('/settings/purge-cache', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.lastCachePurge = Date.now();
    await db.save();
    res.redirect('/settings?msg=Cache+purged');
});

app.post('/settings/toggle-downtime-alerts', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.downtimeAlerts = !db.settings.downtimeAlerts;
    await db.save();
    let msg = db.settings.downtimeAlerts ? 'Downtime+alerts+enabled' : 'Downtime+alerts+disabled';
    if (db.settings.downtimeAlerts) {
        const sent = await sendStatusChangeEmail({
            subject: "Status email alerts enabled",
            title: "Status Email Alerts Enabled",
            message: "Email alerts are now enabled. You will be emailed when maintenance mode is turned on or off."
        });
        msg = sent ? 'Downtime+alerts+enabled+and+test+email+sent' : 'Downtime+alerts+enabled+but+email+failed';
    }
    await sendDiscordWebhook({
        title: db.settings.downtimeAlerts ? "Status Alerts Enabled" : "Status Alerts Disabled",
        message: db.settings.downtimeAlerts
            ? "Dashboard status alerts have been enabled."
            : "Dashboard status alerts have been disabled.",
        color: db.settings.downtimeAlerts ? 0x9ECE6A : 0xF7768E
    });
    res.redirect('/settings?msg=' + msg);
});

app.post('/settings/discord-webhook', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};
    db.settings.discordWebhook = (req.body.discordWebhook || req.body.slackWebhook || '').trim();
    delete db.settings.slackWebhook;
    await db.save();
    const sent = await sendDiscordWebhook({
        title: "Discord Webhook Connected",
        message: "This channel will now receive dashboard status notifications.",
        color: 0x5865F2
    });
    res.redirect('/settings?msg=' + (sent ? 'Discord+webhook+saved+and+test+sent' : 'Discord+webhook+saved+but+test+failed'));
});

app.post('/settings/flush-sessions', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    // Destroy the current session last so the admin gets redirected cleanly
    req.session.destroy(() => {});
    res.redirect('/login?msg=All+sessions+flushed');
});

app.post('/settings/reset', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    db.settings = {};
    await db.save();
    res.redirect('/settings?msg=Settings+reset+to+defaults');
});


// --- BOT STARTUP ---
// This section will be registered after the Discord client is initialized.

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Engine Online on Port ${PORT}`));

// --- CONSOLIDATED VOICE & DISCORD IMPORTS ---
const {
    joinVoiceChannel,
    createAudioPlayer,
    AudioPlayerStatus,
    createAudioResource,
    VoiceConnectionStatus,
    entersState,
    demuxProbe,
    getVoiceConnection
} = require('@discordjs/voice');

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Partials,
    ActivityType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

dayjs.extend(relativeTime);

// --- SAFE COOKIE INITIALIZATION ---
async function setupPlayDL() {
    try {
        console.log("🔐 Setting up SoundCloud authentication...");
        // SoundCloud client_ids are scraped, unofficial tokens that SoundCloud
        // periodically rotates/invalidates. A static SOUNDCLOUD_CLIENT_ID env var
        // will eventually 401. play.getFreeClientID() scrapes a fresh, currently
        // valid one from soundcloud.com at startup instead.
        const clientID = await play.getFreeClientID();
        await play.setToken({
            soundcloud: {
                client_id: clientID
            }
        });
        console.log("✅ SoundCloud Authorized (fresh client ID fetched).");
    } catch (err) {
        console.error("❌ SoundCloud Auth Error:", err.message);
        // Fallback: try the env var if scraping failed for some reason (e.g. network block)
        if (process.env.SOUNDCLOUD_CLIENT_ID) {
            try {
                await play.setToken({ soundcloud: { client_id: process.env.SOUNDCLOUD_CLIENT_ID } });
                console.log("⚠️ SoundCloud Authorized using fallback SOUNDCLOUD_CLIENT_ID env var (may be stale).");
            } catch (fallbackErr) {
                console.error("❌ SoundCloud fallback auth also failed:", fallbackErr.message);
            }
        }
    }
}


async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || !song) {
        if (serverQueue?.connection) serverQueue.connection.destroy();
        queue.delete(guildId);
        return false;
    }

    try {
        console.log(`🎧 Streaming SoundCloud track: ${song.title}`);

        const streamData = await play.stream(song.streamURL || song.url, {
            quality: 2,
            discordPlayerCompatibility: true
        });

        const stream = streamData.stream || streamData;
        if (!stream) throw new Error("SoundCloud stream is null");

        const { stream: probedStream, type: probedType } = await demuxProbe(stream);

        const resource = createAudioResource(probedStream, {
            inputType: probedType,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume ?? 0.5);

        serverQueue.connection.subscribe(serverQueue.player);
        serverQueue.player.removeAllListeners(AudioPlayerStatus.Idle);

        const playbackStartedAt = Date.now();
        serverQueue.player.play(resource);

        serverQueue.player.on(AudioPlayerStatus.Idle, () => {
            // SoundCloud serves 30s "preview" streams instead of the full track for a lot of
            // commercial/label music when accessed without a paid/OAuth client_id. If playback
            // ended way earlier than the track's reported duration, it's almost certainly that —
            // not a crash — so tell the channel instead of silently vanishing.
            const playedSeconds = (Date.now() - playbackStartedAt) / 1000;
            if (song.duration && playedSeconds < song.duration - 10 && playedSeconds < 40) {
                serverQueue.textChannel?.send(
                    `⚠️ **${song.title}** cut off after ~${Math.round(playedSeconds)}s — SoundCloud likely only allows a preview clip for this track (common for major-label releases without a paid API key).`
                ).catch(() => { });
            }

            serverQueue.songs.shift();

            if (serverQueue.songs.length > 0) {
                playSong(guildId, serverQueue.songs[0]);
            } else if (!stayInVC) {
                serverQueue.connection.destroy();
                queue.delete(guildId);
            }
        });

        return true;

    } catch (err) {
        console.error(`❌ SoundCloud Stream Error: ${err.message}`);
        serverQueue.textChannel?.send(
            `❌ Couldn't play **${song.title}** — this track's stream link is unavailable (it may have been removed or restricted on SoundCloud).`
        ).catch(() => { });

        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) {
            return playSong(guildId, serverQueue.songs[0]);
        } else {
            serverQueue.connection.destroy();
            queue.delete(guildId);
            return false;
        }
    }
}

async function finalizeSongSelection(interaction, member, song) {
    let serverQueue = queue.get(interaction.guild.id);

    if (!serverQueue) {
        const connection = joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true
        });

        // --- TEMP DIAGNOSTIC LOGGING (voice connection troubleshooting) ---
        // Distinguishes "voice signalling never connects" from "signalling OK but
        // UDP audio path never completes" — these need different fixes.
        connection.on('debug', (msg) => console.log('🔧 [voice debug]', msg));
        connection.on('stateChange', (oldState, newState) => {
            console.log(`🔧 [voice state] ${oldState.status} -> ${newState.status} | networking: ${newState.networking?.state?.code ?? newState.networking?.state ?? 'n/a'}`);
        });

        try {
            // 5s was too tight for some hosts' network paths to Discord's voice
            // media servers, causing spurious "operation was aborted" errors
            // even though the connection would have succeeded a couple seconds later.
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (err) {
            connection.destroy();
            console.error("❌ Voice connection failed to become ready:", err.message);
            return interaction.followUp("❌ Couldn't establish a stable voice connection. Please try again.");
        }

        const queueConstruct = {
            textChannel: interaction.channel,
            voiceChannel: member.voice.channel,
            connection: connection,
            player: createAudioPlayer(),
            songs: [song],
            autoplay: false,
            volume: 0.5
        };

        queue.set(interaction.guild.id, queueConstruct);
        connection.subscribe(queueConstruct.player);

        await playSong(interaction.guild.id, song);
        return interaction.followUp(`🎶 Now playing: **${song.title}**`);
    }

    serverQueue.songs.push(song);
    return interaction.followUp(`➕ Added **${song.title}** to queue.`);
}

function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}


client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- GATEWAY DIAGNOSTICS ---
// Temporary verbose logging to trace exactly where login() is stalling.
// Safe to remove/comment out once the hang is diagnosed.
client.on('debug', (info) => console.log('🔧 [gateway debug]', info));
client.on('warn', (info) => console.warn('⚠️ [gateway warn]', info));
client.on('error', (err) => console.error('❌ [client error]', err));
client.on('shardError', (err, shardId) => console.error(`❌ [shard ${shardId} error]`, err));
client.on('shardDisconnect', (event, shardId) => console.log(`🔌 [shard ${shardId} disconnected]`, event?.code, event?.reason));
client.on('shardReconnecting', (shardId) => console.log(`🔄 [shard ${shardId} reconnecting]`));
client.on('shardResume', (shardId, replayed) => console.log(`▶️ [shard ${shardId} resumed]`, replayed));
client.on('invalidated', () => console.error('❌ [session invalidated] Discord invalidated this session — token or intents likely rejected.'));

client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    if (redis) {
        try {
            const remoteData = await redis.get('bot_db');
            if (remoteData) {
                Object.assign(db, remoteData);
                if (!db.bannedWords) db.bannedWords = [];
            }
        } catch (err) { console.error("❌ Redis sync failed:", err.message); }
    }
});

const queue = new Map();
let unsavedMessages = 0;
let isTrial = false;
let stayInVC = false;

// --- DATABASE STARTS BELOW ---
let db = {
    offences: {},
    staffStrikes: {},
    notes: {},
    ignoredChannels: [],
    cases: [],
    modLogChannel: null,
    chatLogChannel: null,
    loaChannel: null,
    disabledCommands: [],
    afk: {},
    loa: {},
    suggestions: {},
    modRoles: [],
    reminders: [],
    stats: {},
    aiEnabled: true,
    musicEnabled: true,
    modmailEnabled: true,
    automodEnabled: true,
    welcomeEnabled: true,
    remindersEnabled: true,
    moderationEnabled: true,
    utilitiesEnabled: true,
    funEnabled: true,
    quizEnabled: true,
    staffToolsEnabled: true,
    customQuizzes: {},
    dmThreads: {},
    bannedWords: [],

    // The save function is now a method INSIDE the db object
    async save() {
        try {
            // Check if redis is defined in the global scope
            if (typeof redis !== 'undefined') {
                // Destructure 'save' to prevent trying to save the function itself to Redis
                const { save, ...dataToSave } = this;
                await redis.set('bot_db', dataToSave);
                console.log("💾 Database synced to Upstash.");
            } else {
                // Fallback to local file if Redis isn't connected
                fs.writeFileSync('./database.json', JSON.stringify(this, null, 4));
                console.log("💾 Database synced to local file.");
            }
        } catch (err) {
            console.error("❌ Failed to save database:", err.message);
        }
    }
};

// --- INITIAL LOAD FROM REDIS ---
(async () => {
    try {
        if (redis) {
            console.log("⏳ Loading database from Upstash...");
            const remoteData = await redis.get('bot_db');

            if (remoteData) {
                // Merge Redis data into the real db object (defaults act as fallback for new keys)
                // Object.assign only overwrites keys present in remoteData, so new fields
                // added to the db defaults above are preserved when not yet in Redis.
                Object.assign(db, remoteData);
                if (!db.dmThreads) db.dmThreads = {};
                if (!db.bannedWords) db.bannedWords = [];
                console.log("✅ Database successfully loaded from Upstash.");
            } else {
                console.log("ℹ️ No existing database found in Redis; starting with defaults.");
            }
        } else {
            console.warn("⚠️ Redis not configured! Running with memory-only storage.");
        }
    } catch (e) {
        console.error("❌ Redis Load Error:", e.message);
    }
    // Always point global.db at the live db object so all mutations are shared
    global.db = db;
})();

// --- LOGGING SYSTEM ---
// Sends a DM to the affected member (with evidence attached) and posts the
// evidence to the mod log channel alongside the standard logAction embed.
async function logActionWithEvidence(guild, targetUser, title, description, color, dmTitle, dmDescription, evidence) {
    // 1. DM the member with the reason and evidence
    try {
        const dmEmbed = new EmbedBuilder()
            .setTitle(dmTitle)
            .setDescription(dmDescription)
            .setColor(color)
            .setTimestamp();

        const dmPayload = { embeds: [dmEmbed] };
        if (evidence) dmPayload.files = [evidence.url];

        await targetUser.send(dmPayload);
    } catch (err) {
        console.error(`❌ Failed to DM ${targetUser.tag} for ${title}:`, err.message);
    }

    // 2. Post to the mod log channel, including the evidence attachment
    try {
        if (!db.modLogChannel) return;
        const logChannel = guild.channels.cache.get(db.modLogChannel);
        if (!logChannel) return;

        const logEmbed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        const logPayload = { embeds: [logEmbed] };
        if (evidence) logPayload.files = [evidence.url];

        await logChannel.send(logPayload);
    } catch (err) {
        console.error(`❌ Failed to send mod log for ${title}:`, err.message);
    }
}

function logAction(guild, title, description, color = 0x00FF00) {
    try {
        if (!db.modLogChannel) return;

        const logChannel = guild.channels.cache.get(db.modLogChannel);
        if (!logChannel) return;

        const logEmbed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        logChannel.send({ embeds: [logEmbed] });
    } catch (err) {
        console.error("❌ Failed to send logAction:", err.message);
    }
}

function formatMsDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const remSeconds = totalSeconds % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    return minutes > 0 ? `${minutes}m ${remSeconds}s` : `${remSeconds}.${tenths}s`;
}

// --- VERIFY CHANNEL EMBED ---
// Posts (or refreshes) a standing embed + Link button in VERIFY_CHANNEL that
// points members at the /verify website page. A Link-style button just opens
// the URL directly — no interaction/customId handling needed on the bot's side.
// The message ID is cached in db.verifyMessageId so restarts edit the existing
// message in place instead of spamming a new one into the channel every time.
async function ensureVerifyEmbed(guild) {
    const channelId = process.env.VERIFY_CHANNEL;
    if (!channelId) return; // Not configured — nothing to do.

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
        console.error(`❌ VERIFY_CHANNEL (${channelId}) not found in this guild or isn't a text channel.`);
        return;
    }

    const verifyUrl = process.env.VERIFY_URL;
    if (!verifyUrl) {
        console.error('❌ VERIFY_URL is not set — cannot build the verify button link. Set it to e.g. https://yourdomain.com/verify');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('✅ Verify to Unlock the Server')
        .setDescription(
            `Welcome to **${guild.name}**!\n\n` +
            `To gain access to the rest of the server, click the button below, log in with Discord, ` +
            `complete the CAPTCHA, and agree to the rules. You'll be verified in seconds.`
        )
        .setColor(0x5865F2)
        .setFooter({ text: 'This only takes a few seconds.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('✅ Verify Now')
            .setStyle(ButtonStyle.Link)
            .setURL(verifyUrl)
    );

    if (db.verifyMessageId) {
        const existing = await channel.messages.fetch(db.verifyMessageId).catch(() => null);
        if (existing) {
            await existing.edit({ embeds: [embed], components: [row] }).catch((err) => {
                console.error(`❌ Failed to refresh existing verify embed: ${err.message}`);
            });
            return;
        }
        // Message we were tracking is gone (deleted, channel purged, etc.) — fall through and repost.
    }

    const sent = await channel.send({ embeds: [embed], components: [row] }).catch((err) => {
        console.error(`❌ Failed to post verify embed: ${err.message}`);
        return null;
    });
    if (sent) {
        db.verifyMessageId = sent.id;
        await db.save().catch((err) => console.error('❌ Failed to save verifyMessageId:', err.message));
    }
}

// --- STARTUP STATS SYNC ---
// A standalone, non-interactive counterpart to /syncstats that runs automatically
// once on boot. Deliberately does NOT run the security audit/kick logic from the
// slash command (that should always be an explicit admin action, never automatic),
// and doesn't use the button-based checkpoint pause from /syncstats (there's no
// user to click it on startup) — it just runs straight through and posts progress
// to the mod log every PROGRESS_PERCENT_STEP% instead.
const MIN_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — guards against back-to-back
// full rescans if the bot restarts/crash-loops repeatedly. Adjust or remove this
// guard (and the db.lastStatsSyncAt check below) if that's not the behavior you want.

async function runStartupStatsSync(guild) {
    if (!guild) return;

    if (db.lastStatsSyncAt && (Date.now() - db.lastStatsSyncAt) < MIN_RESYNC_INTERVAL_MS) {
        const waitLeft = formatMsDuration(MIN_RESYNC_INTERVAL_MS - (Date.now() - db.lastStatsSyncAt));
        console.log(`📊 Startup sync: skipped — last full sync was under ${formatMsDuration(MIN_RESYNC_INTERVAL_MS)} ago (next eligible in ~${waitLeft}).`);
        return;
    }

    // Same timeout-race guard used in /syncstats — protects against any single
    // Discord/DB call hanging forever instead of erroring.
    const withTimeout = (promise, ms, label) => {
        promise.catch(() => { });
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    const startedAt = Date.now();
    console.log(`📊 Startup sync: beginning full-history stats rebuild for ${guild.name}...`);

    const excludedLogChannelIds = new Set([db.modLogChannel, db.chatLogChannel].filter(Boolean));
    const channelsToScan = guild.channels.cache.filter(c =>
        c.isTextBased() &&
        c.permissionsFor(guild.members.me).has(['ViewChannel', 'ReadMessageHistory']) &&
        !excludedLogChannelIds.has(c.id)
    );
    const totalChannelsToScan = channelsToScan.size;
    if (totalChannelsToScan === 0) {
        console.log("📊 Startup sync: no scannable channels found, skipping.");
        return;
    }

    const allMembers = await withTimeout(guild.members.fetch(), 30000, 'guild.members.fetch()').catch((err) => {
        console.error(`❌ Startup sync: couldn't fetch guild members, aborting: ${err.message}`);
        return null;
    });
    if (!allMembers) return;

    const staffIds = allMembers.filter(m =>
        m.roles.cache.has('826829037136510986') ||
        m.roles.cache.has('772558550555295794') ||
        m.roles.cache.has('850513087399329823') ||
        m.roles.cache.has('1511810524818440243') ||
        m.roles.cache.has('771423764511981599')
    ).map(m => m.id);

    if (!db.stats) db.stats = {};
    staffIds.forEach(id => {
        if (!db.stats[id]) db.stats[id] = { count: 0, allTime: 0 };
        db.stats[id].count = 0;
        db.stats[id].allTime = 0;
    });

    const lastMonday = new Date();
    lastMonday.setHours(0, 0, 0, 0);
    const day = lastMonday.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    lastMonday.setDate(lastMonday.getDate() - diff);
    const startTimestamp = lastMonday.getTime();

    const FETCH_TIMEOUT_MS = 20000;
    const MAX_RETRIES_PER_PAGE = 3;
    const CLUSTER_SIZE = 5;
    const DB_SAVE_TIMEOUT_MS = 15000;
    const PROGRESS_PERCENT_STEP = 10;

    let scannedCount = 0;
    let allTimeScannedCount = 0;
    let channelsDone = 0;
    let pagesFetchedInChannel = 0;
    let skippedChannels = [];
    let lastReportedPercent = 0;
    let lastHeartbeatAt = Date.now();
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // console every 5min — cheap, no Discord API cost

    logAction(
        guild,
        '📊 Startup Stats Sync Starting',
        `Rebuilding staff stats from full channel history across **${totalChannelsToScan}** channels. This can take a while on large servers — progress every ${PROGRESS_PERCENT_STEP}%, with a console heartbeat every 5 minutes so a big channel doesn't look like a hang.`,
        0x5865F2
    );

    for (const [id, channel] of channelsToScan) {
        let lastId = null;
        let fetching = true;
        let retriesLeft = MAX_RETRIES_PER_PAGE;
        pagesFetchedInChannel = 0;

        while (fetching) {
            try {
                const messages = await withTimeout(
                    channel.messages.fetch({ limit: 100, before: lastId, cache: false }),
                    FETCH_TIMEOUT_MS,
                    `Fetch in #${channel.name}`
                );
                retriesLeft = MAX_RETRIES_PER_PAGE;
                pagesFetchedInChannel++;
                if (messages.size === 0) break;
                for (const msg of messages.values()) {
                    if (staffIds.includes(msg.author.id)) {
                        db.stats[msg.author.id].allTime++;
                        allTimeScannedCount++;
                        if (msg.createdTimestamp >= startTimestamp) {
                            db.stats[msg.author.id].count++;
                            scannedCount++;
                        }
                    }
                }
                lastId = messages.last()?.id;
                if (messages.size < 100) fetching = false;
            } catch (err) {
                if (retriesLeft > 0) {
                    retriesLeft--;
                    console.error(`⚠️ Startup sync: fetch failed in #${channel.name} (${retriesLeft} retries left): ${err.message}`);
                    continue;
                }
                console.error(`❌ Startup sync: giving up on #${channel.name} after repeated failures/timeouts: ${err.message}`);
                skippedChannels.push(channel.name);
                fetching = false;
            }

            // Heartbeat: a single huge channel (very plausible on a server active since
            // 2021) can take a long time to page through before channelsDone ever
            // increments, which is the only thing driving the % progress below. Without
            // this, that looks indistinguishable from a hang. Console-only (cheap) —
            // doesn't touch the Discord API or spam the mod log.
            if (fetching && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
                lastHeartbeatAt = Date.now();
                console.log(`💓 Startup sync heartbeat: still on #${channel.name} (channel ${channelsDone + 1}/${totalChannelsToScan}, ${pagesFetchedInChannel} pages / ~${pagesFetchedInChannel * 100} messages fetched in this channel so far). ${allTimeScannedCount} staff messages found total.`);
            }
        }

        // Same memory guard as /syncstats — without this, a ~900K-message server
        // can accumulate enough cached messages to freeze the process via GC thrashing.
        channel.messages.cache.clear();
        channelsDone++;

        if (channelsDone % CLUSTER_SIZE === 0 || channelsDone === totalChannelsToScan) {
            try {
                await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() startup sync cluster');
            } catch (saveErr) {
                console.error(`❌ Startup sync: cluster save failed/stalled at ${channelsDone}/${totalChannelsToScan}: ${saveErr.message}`);
            }
        }

        const percent = Math.floor((channelsDone / totalChannelsToScan) * 100);
        const currentStep = Math.floor(percent / PROGRESS_PERCENT_STEP);
        if (currentStep > lastReportedPercent || channelsDone === totalChannelsToScan) {
            lastReportedPercent = currentStep;
            logAction(
                guild,
                '📊 Startup Stats Sync Progress',
                `**${percent}%** (${channelsDone}/${totalChannelsToScan} channels) — ` +
                `**${allTimeScannedCount}** staff messages all-time / **${scannedCount}** this week so far.\n` +
                `Elapsed: ${formatMsDuration(Date.now() - startedAt)}`,
                0x5865F2
            );
        }
    }

    db.lastStatsSyncAt = Date.now();
    try {
        await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() startup sync final');
    } catch (saveErr) {
        console.error(`❌ Startup sync: final save failed/stalled: ${saveErr.message}`);
    }

    let summary = `✅ Done in **${formatMsDuration(Date.now() - startedAt)}**.\n` +
        `Found **${allTimeScannedCount}** staff messages all-time, **${scannedCount}** this week.`;
    if (skippedChannels.length > 0) {
        summary += `\n⚠️ Skipped ${skippedChannels.length} channel(s) after repeated failures: \`${skippedChannels.join(', ')}\``;
    }
    logAction(guild, '✅ Startup Stats Sync Complete', summary, 0x00FF00);
    console.log(`✅ Startup sync complete for ${guild.name}: ${allTimeScannedCount} all-time staff messages (took ${formatMsDuration(Date.now() - startedAt)}).`);
}

// --- DATABASE SAVING SYSTEM ---
function saveDB() {
    try {
        fs.writeFileSync('./database.json', JSON.stringify(db, null, 4));
        console.log("💾 Database successfully synced to disk.");
    } catch (err) {
        console.error("❌ CRITICAL: Failed to save database.json:", err.message);
    }
}


// --- PUNISHMENT LADDER ---
// Same role hierarchy used by the slash-command permission checks. Kept as a
// standalone constant so non-interaction listeners (like the suggestion
// channel's reaction handler) can check staff status too.
const STAFF_ROLE_IDS = {
    trial: '826829037136510986',
    mod: '772558550555295794',
    headMod: '801828933800296478',
    admin: '850513087399329823',
    headAdmin: '850513944329191445',
    coOwner: '1511810524818440243',
    owner: '771423764511981599'
};

function isStaffMember(member, guild) {
    if (!member) return false;
    const roles = member.roles.cache;
    return (
        roles.has(STAFF_ROLE_IDS.trial) ||
        roles.has(STAFF_ROLE_IDS.mod) ||
        roles.has(STAFF_ROLE_IDS.headMod) ||
        roles.has(STAFF_ROLE_IDS.admin) ||
        roles.has(STAFF_ROLE_IDS.headAdmin) ||
        roles.has(STAFF_ROLE_IDS.coOwner) ||
        roles.has(STAFF_ROLE_IDS.owner) ||
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        (guild && guild.ownerId === member.id)
    );
}

const applyEscalation = async (guild, targetUser, targetMember, reason, moderatorName) => {
    db.offences[targetUser.id] = (db.offences[targetUser.id] || 0) + 1;
    const count = db.offences[targetUser.id];
    let actionTaken = "WARN";

    try {
        if (count === 2) { actionTaken = "🔇 10M MUTE"; if (targetMember) await targetMember.timeout(10 * 60000, reason); }
        else if (count === 3) { actionTaken = "🔇 30M MUTE"; if (targetMember) await targetMember.timeout(30 * 60000, reason); }
        else if (count === 4 || count === 5) { actionTaken = "👢 KICK"; if (targetMember?.kickable) await targetMember.kick(reason); }
        else if (count === 6) { actionTaken = "⏰ 1D BAN"; await guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: 86400 }); }
        else if (count >= 7) { actionTaken = "🔨 PERM BAN"; await guild.members.ban(targetUser.id, { reason }); }
    } catch (e) { console.error("Ladder Action Failed:", e.message); }

    const newCaseId = db.cases.length > 0 ? Math.max(...db.cases.map(c => c.id)) + 1 : 1;

    db.cases.push({
        id: newCaseId,
        type: actionTaken, user: targetUser.tag, userId: targetUser.id,
        reason: reason, moderator: moderatorName, timestamp: new Date()
    });

    await db.save();
    //-- Return both so the log can use them
    return { action: actionTaken, caseId: newCaseId };
};

client.once('clientReady', async () => {
    console.log(`🛡️ Online: ${client.user.tag}`);

    // 1. Define your rotating statuses
    const statusMessages = [
        { text: "OsQarek's Universe", type: 'Watching', activity: ActivityType.Watching, presence: 'idle' },
        { text: "OsQarek's Universe Game on ROBLOX", type: 'Playing', activity: ActivityType.Playing, presence: 'dnd' },
        { text: "for /help", type: 'Listening', activity: ActivityType.Listening, presence: 'online' },
        { text: "the Universe expand", type: 'Watching', activity: ActivityType.Watching, presence: 'idle' }
    ];

    let currentIndex = 0;

    // 2. The Rotation Function (Updates status AND logs it)
    const rotateStatus = async () => {
        const status = statusMessages[currentIndex];

        try {
            // Update the Bot's Presence
            client.user.setPresence({
                activities: [{ name: status.text, type: status.activity }],
                status: status.presence,
            });
        } catch (err) {
            console.error("Failed to update or log status rotation:", err);
        }

        // Increment for the next run
        currentIndex = (currentIndex + 1) % statusMessages.length;
    };

    // 3. Start the cycle immediately on startup
    rotateStatus();

    // 4. Set the interval (1800000ms = 30 minutes)
    setInterval(rotateStatus, 1800000);

    // 5. Initial Startup Alert
    if (db.modLogChannel) {
        const guild = client.guilds.cache.first();
        if (guild) {
            logAction(guild, '🚀 System Online', 'All modules active. Status cycler & logging started.', 0x00FF00);
        }
    }

    // 6. Verify Channel Embed — post/refresh the standing verify button.
    const verifyEmbedGuild = client.guilds.cache.first();
    if (verifyEmbedGuild) {
        ensureVerifyEmbed(verifyEmbedGuild).catch((err) => {
            console.error("❌ ensureVerifyEmbed crashed:", err.message);
        });
    }

    // 7. Startup Stats Sync — fire-and-forget so it doesn't block the rest of
    // startup or command handling. It reports its own progress via logAction,
    // so nothing here needs to await or watch it.
    const syncGuild = client.guilds.cache.first();
    if (syncGuild) {
        runStartupStatsSync(syncGuild).catch((err) => {
            console.error("❌ Startup sync crashed:", err.message);
        });
    }
});

// --- AUTOMATIC ACCOUNT AGE GUARD ---
client.on('guildMemberAdd', async (member) => {
    try {
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const accountAge = Date.now() - member.user.createdTimestamp;

        // If account is less than 7 days old
        if (accountAge < ONE_WEEK_MS) {
            const ageInDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));

            console.log(`🛡️ Guard: Kicking ${member.user.tag} (Account age: ${ageInDays} days)`);

            // 1. Try to DM the user before kicking
            try {
                await member.send(`🛡️ **OsQarek's Universe: Security Guard**\nYour account is only **${ageInDays}** days old. We require accounts to be at least 7 days old to join. Please try again once your account is older!`);
            } catch (dmErr) {
                console.log(`Could not DM ${member.user.tag} (DMs closed).`);
            }

            // 2. Kick the member
            await member.kick(`Auto-Guard: Account age (${ageInDays}d) is under 7 day requirement.`);

            // 3. Log to ModLog (Optional - uses your existing db.modLogChannel)
            if (db.modLogChannel) {
                const guild = member.guild;
                const logChannel = guild.channels.cache.get(db.modLogChannel);
                if (logChannel) {
                    const guardEmbed = new EmbedBuilder()
                        .setTitle('🛡️ Auto-Guard: Member Kicked')
                        .setDescription(`**User:** ${member.user.tag}\n**ID:** ${member.id}\n**Account Age:** ${ageInDays} days`)
                        .setColor(0xFF0055)
                        .setTimestamp();
                    logChannel.send({ embeds: [guardEmbed] });
                }
            }
        }
    } catch (err) {
        console.error("❌ Auto-Guard Error:", err.message);
    }
});

// --- COMMAND HANDLER ---
client.on('interactionCreate', async (interaction) => {
    // 1. FIREWALL: Check if user is banned from bot
    if (db.ignoredUsers && db.ignoredUsers.includes(interaction.user.id)) {
        return interaction.reply({
            content: "🚫 Your access to the Universe Bot has been restricted.",
            flags: MessageFlags.Ephemeral
        }).catch(() => { });
    }

    // Line 425: Master Deferral Logic
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // 1. Silent check: If already deferred/replied by a ghost line, stop here.
        if (interaction.deferred || interaction.replied) return;

        try {
            // 2. Use flags: [64] is the modern way to do ephemeral (private) replies.
            await interaction.deferReply({
                flags: (commandName === 'loa' || commandName === 'help') ? [64] : []
            });
        } catch (err) {
            // 3. The "Nuclear" fix: If it's already deferred, just ignore the error and move on.
            if (err.code === 40060 || err.message.includes('already been sent')) {
                return;
            }
            // Any other failure (e.g. 10062 Unknown interaction — the interaction expired,
            // often from a deploy/restart racing the 3s ack window) means this interaction
            // can never be replied to. Stop here instead of falling through into command
            // logic that will try to editReply() an interaction that was never acknowledged.
            console.error("Critical Defer Error:", err);
            return;
        }
    }

    // Buttons should NOT be deferred globally.
    // Each button handler will reply/update itself.


    // 3. BUTTON LOGIC
    if (interaction.isButton()) {
        const staffRoles = ['850513087399329823', '850513944329191445', '771423764511981599', '1511810524818440243'];
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
            interaction.member.roles.cache.some(r => staffRoles.includes(r.id));

        // Reaction Roles Patch
        if (interaction.customId.startsWith('rr_')) {
            const roleId = interaction.customId.replace('rr_', '');
            const role = interaction.guild.roles.cache.get(roleId);

            if (!role) {
                return interaction.editReply({ content: "❌ That role no longer exists." });
            }

            try {
                if (interaction.member.roles.cache.has(roleId)) {
                    await interaction.member.roles.remove(role);
                    // Use .reply instead of .followUp
                    return interaction.reply({ content: `💫 Removed **${role.name}**.`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    // Use .reply instead of .followUp
                    return interaction.reply({ content: `✨ Granted **${role.name}**!`, ephemeral: true });
                }
            } catch (err) {
                console.error("❌ Role Permission Error:", err);
                // This usually happens if the bot's role is lower than the role it's giving
                return interaction.reply({
                    content: "❌ I can't manage that role. Please check my role position in Server Settings!",
                    ephemeral: true
                });
            }
        }

        // LOA MANAGEMENT
        if (interaction.customId.startsWith('loa_')) {
            if (!isAdmin) return interaction.reply({ content: "❌ Permission Denied.", ephemeral: true });

            const [, action, targetId] = interaction.customId.split('_');
            const originalEmbed = interaction.message.embeds[0];

            if (action === 'approve') {
                // 🛠️ FUZZY SCRAPER: Looks for "End" or "Reason" regardless of emojis or case
                const dateField = originalEmbed.fields.find(f => f.name.toLowerCase().includes('end'));
                const startField = originalEmbed.fields.find(f => f.name.toLowerCase().includes('start'));
                const reasonField = originalEmbed.fields.find(f => f.name.toLowerCase().includes('reason'));

                // 🧼 DATA CLEANER: Strips emojis so the Auto-Expiry checker only gets numbers/dashes
                const rawDuration = dateField ? dateField.value : "";
                const duration = rawDuration.replace(/[^\d\- :]/g, '').trim();
                const reason = reasonField ? reasonField.value : "No reason provided";

                // 🛡️ SAFETY GATE: If duration is missing, we stop the crash BEFORE it hits the DB
                if (!duration || duration.length < 5) {
                    return interaction.reply({
                        content: "⚠️ **Error:** I couldn't find a valid date in that embed. Please deny this and ask them to resubmit with the correct format.",
                        ephemeral: true
                    });
                }

                let startDateObj = new Date(); // default: starts now, same as before
                if (startField) {
                    const rawStart = startField.value.replace(/[^\d\- :]/g, '').trim();
                    const startParts = rawStart.split(/[- :]/);
                    if (startParts.length >= 5) {
                        const parsedStart = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);
                        if (!isNaN(parsedStart.getTime())) startDateObj = parsedStart;
                    }
                }

                const isScheduled = startDateObj > new Date();

                db.loa[targetId] = {
                    status: isScheduled ? 'Scheduled' : 'Approved',
                    timestamp: Math.floor(Date.now() / 1000),
                    startDate: Math.floor(startDateObj.getTime() / 1000),
                    duration: duration,
                    reason: reason
                };
            } else {
                delete db.loa[targetId];
            }

            await db.save();

            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setTitle(action === 'approve' ? (db.loa[targetId]?.status === 'Scheduled' ? '🕓 LOA APPROVED (Scheduled)' : '✅ LOA APPROVED') : '❌ LOA DENIED')
                .setColor(action === 'approve' ? 0x00FF00 : 0xFF0000)
                .addFields({ name: 'Decision By', value: `${interaction.user.tag}`, inline: false });

            return interaction.update({ embeds: [updatedEmbed], components: [] });
        }

        // DM MODMAIL REPLY
        if (interaction.customId.startsWith('dmreply_')) {
            const targetId = interaction.customId.replace('dmreply_', '');

            const modal = new ModalBuilder()
                .setCustomId(`dmreplymodal_${targetId}`)
                .setTitle('Reply to DM');

            const input = new TextInputBuilder()
                .setCustomId('dmreply_content')
                .setLabel('Your reply')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(2000);

            modal.addComponents(new ActionRowBuilder().addComponents(input));

            return interaction.showModal(modal);
        }
    } // End of Button Logic

    // MODAL SUBMIT: DM MODMAIL REPLY
    if (interaction.isModalSubmit() && interaction.customId.startsWith('dmreplymodal_')) {
        const targetId = interaction.customId.replace('dmreplymodal_', '');
        const replyContent = interaction.fields.getTextInputValue('dmreply_content');

        try {
            const targetUser = await client.users.fetch(targetId);

            const replyEmbed = new EmbedBuilder()
                .setTitle('📬 Staff Reply')
                .setDescription(replyContent)
                .setColor(0x2ECC71)
                .setTimestamp();

            await targetUser.send({ embeds: [replyEmbed] });

            // Confirm in the relay channel and re-attach a Reply button so the
            // conversation can continue back and forth.
            const confirmEmbed = new EmbedBuilder()
                .setTitle('✅ Reply Sent')
                .setDescription(replyContent)
                .addFields({ name: 'To', value: `${targetUser.tag} (${targetUser.id})`, inline: false })
                .setColor(0x2ECC71)
                .setFooter({ text: `Sent by ${interaction.user.tag}` })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`dmreply_${targetId}`)
                    .setLabel('Reply')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({ embeds: [confirmEmbed], components: [row] });
        } catch (err) {
            console.error('❌ Failed to send DM reply:', err.message);
            await interaction.reply({ content: `❌ Could not DM that user (DMs closed or blocked).`, ephemeral: true });
        }
        return;
    }


    // 4. SLASH COMMAND HANDLER (Merged into main event)
    if (interaction.isChatInputCommand()) {
        try {
            const { commandName, options, guild, member, user, channel } = interaction;

            console.log(`DEBUG: Deferred command /${interaction.commandName}`);

            const staffRolesIds = {
                trial: '826829037136510986',
                mod: '772558550555295794',
                headMod: '801828933800296478',
                admin: '850513087399329823',
                headAdmin: '850513944329191445',
                coOwner: '1511810524818440243',
                owner: '771423764511981599'
            };

            // Hierarchy Check
            const isOwner = member.roles.cache.has(staffRolesIds.owner) || member.roles.cache.has(staffRolesIds.coOwner) || guild.ownerId === user.id;
            const isHeadAdmin = member.roles.cache.has(staffRolesIds.headAdmin) || user.id === '778819029041152010' || isOwner;
            const isAtLeastAdmin = member.roles.cache.has(staffRolesIds.admin) || isHeadAdmin || member.permissions.has(PermissionFlagsBits.Administrator);
            const isMod = member.roles.cache.has(staffRolesIds.mod) || member.roles.cache.has(staffRolesIds.headMod) || isAtLeastAdmin;

            // Added definition for entry-level staff commands like /warnings
            const isTrial = member.roles.cache.has(staffRolesIds.trial) || isMod;

            console.log(`DEBUG: Reached Staff Role check for /${interaction.commandName}`);

            // Check disabled commands
            if (!Array.isArray(db.disabledCommands)) db.disabledCommands = [];
            if (db.disabledCommands.includes(commandName.toLowerCase()) && !isHeadAdmin) {
                return interaction.editReply({ content: `❌ \`/${commandName}\` is disabled.` });
            }

            const disabledModule = getDisabledModuleForCommand(commandName);
            if (disabledModule) {
                const [moduleKey] = disabledModule;
                return interaction.editReply({
                    content: `🚫 The ${MODULE_LABELS[moduleKey] || 'requested'} module is currently disabled.`
                });
            }

            const modularHandler = commandHandlers[commandName];
            if (modularHandler) {
                return modularHandler({
                    interaction,
                    options,
                    guild,
                    member,
                    user,
                    channel,
                    client,
                    db,
                    isOwner,
                    isHeadAdmin,
                    isAtLeastAdmin,
                    isMod,
                    isTrial,
                    createEmbed,
                    logAction,
                    safeSave,
                    queueSave,
                    getCachedMembers,
                });
            }

            // --- 3. SYSTEM & ADMIN COMMANDS ---
            if (commandName === 'help') {
                const helpEmbed = createEmbed({
                    title: '🛡️ OsQarek\'s Universe | Command List',
                    description: 'Navigate the Universe with the commands below. Permission levels apply.',
                    thumbnail: client.user.displayAvatarURL(),
                    footer: 'OsQarek\'s Universe',
                    fields: [
                        {
                            name: '👤 Public & Fun',
                            value: '`ping`, `pfp`, `diceroll`, `randomletter`, `ship`, `osqareksocials`, `serverinfo`, `userinfo`, `afk`, `offences`, `random`, `reminder`, `joke`, `dadjoke`, `randomfact`, `cat`, `dog`, `coinflip`, `poll`, `latest-updates`,'
                        },
                        {
                            name: '🎮 Game & AI',
                            value: '`ask-rules`, `summarize`, `suggest`, `quizlist`, `quizcreate`, `startquiz`, `delquiz`, `apply`, `join`, `leave`'
                        },
                        {
                            name: '🎵 Music Engine',
                            value: '`play`, `skip`, `queue`, `clearqueue`, `pause`, `resume`, `volume`, `nowplaying`, `autoplay`, `247`'
                        },
                        {
                            name: '👮 Staff (Trial+)',
                            value: '`warn`, `mute`, `unmute`, `kick`, `softban`, `purge`, `notes`, `warnings`, `loa`, `case`, `dm`, `addnote`'
                        },
                        {
                            name: '⚔️ Moderation & Stats',
                            value: '`lockdown`, `slowmode`, `reason`, `staffstats`, `allstaffstats`, `staff-leaderboard`'
                        },
                        {
                            name: '⚙️ Admin',
                            value: '`ban`, `unban`, `banlist`, `modlog`, `setloachannel`, `setchatlog`, `togglecommand`, `delwarn`, `clearwarns`, `ignorechannel`, `addmod`, `deletemod`, `announce`, `globalannounce`, `role`, `messagereset`, `restart`, `reactionrole`, `userignore`, `staffdm`, `latest-action`,'
                        },
                        {
                            name: '👑 Owners',
                            value: '`strike remove`, `strike add`, `strikes`, `aitoggle`, `staff-reset`'
                        }
                    ],
                });

                await interaction.editReply({ embeds: [helpEmbed] });
            }
            if (commandName === 'ping-all-staff') {
                const reason = interaction.options.getString('reason');
                const staffRoleId = '1266661585380708473';

                if (interaction.isChatInputCommand()) {
                    // Only defer if we haven't replied or deferred yet
                    if (!interaction.deferred && !interaction.replied) {
                        try {
                            await interaction.deferReply({
                                ephemeral: (commandName === 'loa' || commandName === 'help')
                            });
                        } catch (err) {
                            console.error("Failed to defer interaction:", err);
                        }
                    }
                }

                const members = await getCachedMembers(interaction.guild, { ttl: 300000 });
                const staffMembers = members.filter(m => m.roles.cache.has(staffRoleId) && !m.user.bot);

                if (staffMembers.size === 0) {
                    return interaction.editReply("No staff members found with that role.");
                }

                let dmCount = 0;

                const dmPromises = staffMembers.map(async (member) => {
                    try {
                        const embed = new EmbedBuilder()
                            .setTitle('🚨 **URGENT STAFF ALERT:**')
                            .setDescription(`You have been pinged by **${interaction.user.tag}** in **${interaction.guild.name}**.`)
                            // FIX 2: Wrap fields in an array [ ] to fix the Sapphire/Shapeshift validator error
                            .addFields([
                                { name: 'Reason', value: reason }
                            ])
                            .setColor(0xFF0000)
                            .setTimestamp();

                        await member.send({ embeds: [embed] });
                        dmCount++;
                    } catch (err) {
                        console.log(`Could not DM ${member.user.tag}.`);
                    }
                });

                await Promise.all(dmPromises);

                const pingList = staffMembers.map(m => `<@${m.id}>`).join(' ');

                const publicEmbed = new EmbedBuilder()
                    .setTitle('Staff Notified')
                    .setDescription(`**Reason:** ${reason}\n\n**Notified:** ${dmCount} staff members via DM.`)
                    .setColor(0x5865F2)
                    .setFooter({ text: `Requested by ${interaction.user.username}` });

                await interaction.editReply({
                    content: `⚠️ **Attention Staff:** ${pingList}`,
                    embeds: [publicEmbed]
                });
            }
            if (commandName === 'userinfo') {
                const target = interaction.options.getMember('target') || interaction.member;

                const embed = new EmbedBuilder()
                    .setTitle(`👤 User Info: ${target.user.tag}`)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .setColor(0x00FFFF)
                    .addFields(
                        { name: '🆔 User ID', value: `\`${target.id}\``, inline: true },
                        { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                        { name: '🚀 Created Account', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: '🎭 Top Role', value: `${target.roles.highest}`, inline: true }
                    );

                // FIXED: Changed .reply to .editReply
                return await interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'serverinfo') {
                const { guild } = interaction;

                const embed = new EmbedBuilder()
                    .setTitle(`🏰 ${guild.name} | Universe Specs`)
                    .setThumbnail(guild.iconURL({ dynamic: true }))
                    .setColor(0xFF00FF)
                    .addFields(
                        { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
                        { name: '👥 Members', value: `\`${guild.memberCount}\``, inline: true },
                        { name: '✨ Boosts', value: `Level ${guild.premiumTier}`, inline: true },
                        { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
                    );

                // FIXED: Changed .reply to .editReply
                return await interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'ping') return interaction.editReply(`🏓 Latency: **${client.ws.ping}ms**`);
            if (commandName === 'serverinfo') return interaction.editReply(`🏰 **${guild.name}** | Members: ${guild.memberCount} | Owner: <@${guild.ownerId}>`);
            if (commandName === 'restart' && isHeadAdmin) {
                logAction(guild, '🚀 Restart', `By: ${user.tag}`, 0xFF0000);
                await interaction.editReply("🚀 Restarting..."); process.exit(0);
            }
            if (commandName === 'togglecommand' && isAtLeastAdmin) {
                const cmd = options.getString('command').toLowerCase();
                if (db.disabledCommands.includes(cmd)) db.disabledCommands = db.disabledCommands.filter(c => c !== cmd);
                else db.disabledCommands.push(cmd);
                await db.save();
                logAction(guild, '⚙️ Toggle', `Command /${cmd} toggled by ${user.tag}`);
                return interaction.editReply(`✅ Toggled \`/${cmd}\`.`);
            }

            // --- 2. CONFIGURATION ---
            if (commandName === 'modlog' && isAtLeastAdmin) {
                db.modLogChannel = options.getChannel('channel').id; await db.save();
                return interaction.editReply("✅ Mod Log set.");
            }
            if (commandName === 'setchatlog' && isAtLeastAdmin) {
                db.chatLogChannel = options.getChannel('channel').id; await db.save();
                return interaction.editReply("✅ Chat Log set.");
            }
            if (commandName === 'setloachannel' && isAtLeastAdmin) {
                db.loaChannel = options.getChannel('channel').id;
                await db.save();
                return interaction.editReply(`✅ LOA Request channel set to <#${db.loaChannel}>`);
            }
            if (commandName === 'aitoggle') {
                const status = interaction.options.getBoolean('status');
                const moderator = interaction.member;

                const OWNER_ROLE_ID = '771423764511981599';
                const CO_OWNER_ROLE_ID = '1511810524818440243';

                if (!moderator.roles.cache.has(OWNER_ROLE_ID) && !moderator.roles.cache.has(CO_OWNER_ROLE_ID)) {
                    return interaction.editReply("❌ Only Owner/Co-Owner can toggle the AI.");
                }

                db.aiEnabled = status;
                await db.save();

                const embed = new EmbedBuilder()
                    .setTitle('🌌 AI System Update')
                    .setDescription(`The Universe AI has been set to: **${status ? 'ENABLED' : 'DISABLED'}**`)
                    .setColor(status ? '#00FF99' : '#FF0055') // Neon Green for ON, Neon Pink for OFF
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'addmod' && isAtLeastAdmin) {
                const r = options.getRole('role'); if (!db.modRoles.includes(r.id)) db.modRoles.push(r.id);
                await db.save(); return interaction.editReply(`✅ Mod role ${r.name} added.`);
            }
            if (commandName === 'deletemod' && isAtLeastAdmin) {
                db.modRoles = db.modRoles.filter(id => id !== options.getRole('role').id);
                await db.save(); return interaction.editReply("✅ Mod role removed.");
            }
            if (commandName === 'ignorechannel' && isAtLeastAdmin) {
                // -- 1. Get the channel ID and ensure it is a String
                const cid = String((options.getChannel('channel') || channel).id);

                // -- 2. Check if it's already in the list
                const index = db.ignoredChannels.indexOf(cid);
                let status = "";

                if (index > -1) {
                    //-- It's already there, so remove it
                    db.ignoredChannels.splice(index, 1);
                    status = "is no longer ignored";
                } else {
                    //-- It's not there, so add it
                    db.ignoredChannels.push(cid);
                    status = "is now being ignored";
                }

                //-- 3. Save and Respond
                await db.save();
                return interaction.editReply(`✅ <#${cid}> ${status}.`);
            }
            if (commandName === 'music') {
                const subcommand = interaction.options.getSubcommand();
                const serverQueue = queue.get(interaction.guildId);
                const member = interaction.member;

                switch (subcommand) {
                    case 'join': {
                        const voiceChannel = member.voice.channel;
                        if (!voiceChannel) return interaction.editReply("❌ You must be in a voice channel.");

                        joinVoiceChannel({
                            channelId: voiceChannel.id,
                            guildId: interaction.guildId,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                        });
                        return interaction.editReply(`✅ Joined **${voiceChannel.name}**.`);
                    }

                    case 'nowplaying': {
                        // 1. Check if the queue exists
                        if (!serverQueue || !serverQueue.songs.length) {
                            return interaction.editReply("❌ Nothing is currently playing.");
                        }

                        const song = serverQueue.songs[0];

                        // 2. Build the Now Playing Embed
                        const embed = createEmbed({
                            title: "🎶 Now Playing",
                            description: `**[${song.title}](${song.url})**`,
                            thumbnail: song.thumbnail,
                            footer: `Requested by ${member.displayName}`,
                            timestamp: false,
                            fields: [
                                { name: "👤 Artist", value: song.artist, inline: true },
                                { name: "⏱️ Duration", value: formatDuration(song.duration), inline: true }
                            ],
                        });

                        // 3. Finalize the reply
                        try {
                            await interaction.editReply({ embeds: [embed] });
                        } catch (err) {
                            console.error("❌ Now Playing Error:", err);
                            // Fallback if editReply fails
                            if (!interaction.replied) {
                                await interaction.followUp({ embeds: [embed] }).catch(() => { });
                            }
                        }
                        break;
                    }

                    case 'play': {
                        if (db.musicEnabled === false) return interaction.editReply('🎵 Music module is currently disabled.');
                        console.log("DEBUG: Music Play started");
                        const query = interaction.options.getString('query');
                        if (!member.voice.channel) return interaction.editReply("❌ You must be in a voice channel.");

                        try {
                            let results = [];
                            console.log(`DEBUG: Searching SoundCloud for: ${query}`);

                            if (query.includes("soundcloud.com")) {
                                const scTrack = await play.soundcloud(query).catch(() => null);
                                if (!scTrack) return interaction.editReply("❌ Could not load that SoundCloud link.");

                                results = [{
                                    title: scTrack.name || scTrack.title,
                                    url: scTrack.url,
                                    streamURL: scTrack.streamURL,
                                    artist: scTrack.publisher?.artist || "Unknown Artist",
                                    duration: scTrack.durationInSec || 0,
                                    thumbnail: scTrack.thumbnail,
                                }];
                            } else {
                                const searchResults = await play.search(query, {
                                    limit: 5,
                                    source: { soundcloud: "tracks" }
                                });
                                console.log(`DEBUG: Found ${searchResults?.length || 0} results`);

                                if (!searchResults || searchResults.length === 0) {
                                    return interaction.editReply("❌ No SoundCloud results found.");
                                }

                                // FIX: Enforce 5 result limit to prevent BASE_TYPE_BAD_LENGTH error
                                results = searchResults.slice(0, 5).map(t => ({
                                    title: t.name || t.title,
                                    url: t.url,
                                    streamURL: t.streamURL,
                                    artist: t.publisher?.artist || "Unknown Artist",
                                    duration: t.durationInSec || 0,
                                    thumbnail: t.thumbnail
                                }));
                            }

                            if (results.length === 1) {
                                console.log("DEBUG: One result found, jumping to finalization");
                                if (typeof finalizeSongSelection !== 'function') {
                                    return interaction.editReply("❌ Internal Error: finalizeSongSelection is not defined.");
                                }

                                // PATCH: Catch 404s during finalization to stop indefinite "thinking"
                                await finalizeSongSelection(interaction, member, results[0]).catch(err => {
                                    console.error("❌ STREAM ERROR:", err.message);
                                    return interaction.editReply("❌ This track is unavailable (404). It may be geo-blocked or private.");
                                });
                                return;
                            }

                            const embed = createEmbed({
                                title: "🎧 Choose a SoundCloud Track",
                                description: results.map((r, i) => `**${i + 1}.** [${r.title}](${r.url})\n👤 *${r.artist}* • ⏱️ ${formatDuration(r.duration)}`).join("\n\n"),
                                footer: "Select a track using the buttons below",
                                timestamp: false,
                            });

                            const row = new ActionRowBuilder();
                            results.forEach((_, i) => {
                                row.addComponents(new ButtonBuilder().setCustomId(`sc_select_${i}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
                            });

                            const msg = await interaction.editReply({ embeds: [embed], components: [row] });
                            const filter = btn => btn.user.id === interaction.user.id && btn.customId.startsWith("sc_select_");
                            const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

                            collector.on("collect", async btn => {
                                const index = parseInt(btn.customId.split("_")[2]);
                                const chosen = results[index];
                                await btn.update({ content: `🎶 Selected: **${chosen.title}**`, embeds: [], components: [] }).catch(() => { });
                                collector.stop();

                                // PATCH: Catch stream failures for button selections
                                await finalizeSongSelection(interaction, member, chosen).catch(err => {
                                    console.error("❌ STREAM ERROR:", err.message);
                                    return interaction.editReply("❌ This track is unavailable (404).");
                                });
                            });

                            collector.on("end", (collected, reason) => {
                                if (reason === 'time' && collected.size === 0) {
                                    interaction.editReply({ content: "⏳ Selection timed out.", embeds: [], components: [] }).catch(() => { });
                                }
                            });

                        } catch (err) {
                            console.error("❌ PLAY ERROR:", err);
                            return interaction.editReply("❌ Error processing your request.").catch(() => { });
                        }
                        break;
                    }
                    case 'skip': {
                        if (!serverQueue || !serverQueue.songs.length) return interaction.editReply("❌ Nothing to skip.");
                        serverQueue.songs.shift();
                        if (!serverQueue.songs.length) {
                            serverQueue.player.stop(true);
                            serverQueue.connection.destroy();
                            queue.delete(interaction.guildId);
                            return interaction.editReply("⏭️ Skipped. Queue is now empty.");
                        }
                        await playSong(interaction.guildId, serverQueue.songs[0]);
                        return interaction.editReply("⏭️ Skipped to the next track.");
                    }

                    case 'queue': {
                        if (!serverQueue || !serverQueue.songs.length) return interaction.editReply("📜 The queue is empty.");
                        const lines = serverQueue.songs.map((s, i) => `**${i === 0 ? "▶️" : i}.** [${s.title}](${s.url})`).slice(0, 20);
                        const embed = createEmbed({
                            title: "📜 Current Queue",
                            description: lines.join("\n"),
                            footer: `Total tracks: ${serverQueue.songs.length}`,
                            timestamp: false,
                        });
                        return interaction.editReply({ embeds: [embed] });
                    }

                    case 'pause': {
                        if (!serverQueue) return interaction.editReply("❌ Nothing is playing.");
                        return interaction.editReply(serverQueue.player.pause() ? "⏸️ Paused the music." : "❌ Music is already paused.");
                    }

                    case 'resume': {
                        if (!serverQueue) return interaction.editReply("❌ Nothing is playing.");
                        return interaction.editReply(serverQueue.player.unpause() ? "▶️ Resumed the music." : "❌ Music is already playing.");
                    }
                    case 'volume': {
                        const serverQueue = queue.get(interaction.guild.id);

                        if (!serverQueue) {
                            return interaction.editReply("❌ No music is currently playing.");
                        }

                        const level = options.getNumber('level');

                        // Updated safety check to allow up to 1000%
                        if (level < 0 || level > 1000) {
                            return interaction.editReply("❌ Please provide a volume between 0 and 1000.");
                        }

                        const volumeFactor = level / 100; // 1000 becomes 10.0

                        // 1. Update the saved volume in your queue object
                        serverQueue.volume = volumeFactor;

                        // 2. Apply it immediately to the current song resource
                        const currentResource = serverQueue.player.state.resource;

                        if (currentResource && currentResource.volume) {
                            currentResource.volume.setVolume(volumeFactor);

                            let response = `🔊 Volume set to **${level}%**`;

                            // Dynamic warnings based on how high they push it
                            if (level > 200) {
                                response += "\n☢️ **WARNING:** Extreme volume levels will cause heavy distortion!";
                            } else if (level > 100) {
                                response += "\n⚠️ *Note: Volumes above 100% may cause audio distortion.*";
                            }

                            return interaction.editReply(response);
                        } else {
                            return interaction.editReply("⚠️ Volume updated for future tracks, but the current stream doesn't support live adjustments.");
                        }
                    }

                    case 'leave': {
                        const connection = getVoiceConnection(interaction.guildId);
                        if (!connection) return interaction.editReply("❌ I'm not in a voice channel.");
                        connection.destroy();
                        queue.delete(interaction.guildId);
                        return interaction.editReply("👋 Left the voice channel and cleared the queue.");
                    }

                    case 'autoplay': {
                        if (!serverQueue) return interaction.editReply("❌ No active queue.");
                        serverQueue.autoplay = !serverQueue.autoplay;
                        return interaction.editReply(`🔁 Autoplay is now **${serverQueue.autoplay ? 'ENABLED' : 'DISABLED'}**.`);
                    }

                    case '247': {
                        stayInVC = !stayInVC;
                        return interaction.editReply(`🛰️ 24/7 mode is now **${stayInVC ? 'ENABLED' : 'DISABLED'}**.`);
                    }

                    case 'clear': {
                        if (!serverQueue) return interaction.editReply("❌ There is no active queue to clear.");
                        serverQueue.songs = [serverQueue.songs[0]];
                        return interaction.editReply("🧹 Cleared all upcoming songs from the queue.");
                    }
                }

                // FINAL PATCH: Fallback to ensure the "Thinking" state is cleared if a subcommand ends early
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply("✅ Command processed.").catch(() => { });
                }
                return;
            }
            if (commandName === 'staffdm') {
                const staffRoles = [
                    '826829037136510986', // Trial Mod
                    '772558550555295794', // Mod
                    '801828933800296478', // Head Mod
                    '850513087399329823', // Admin
                    '850513944329191445', // Head Admin
                    '771423764511981599', // Owner
                    '1511810524818440243'  // Co-Owner
                ];

                // Permission check: Admin+ only
                if (
                    !member.roles.cache.some(r => staffRoles.includes(r.id)) &&
                    !member.permissions.has(PermissionFlagsBits.Administrator)
                ) {
                    return interaction.editReply("❌ You do not have permission to use this command.");
                }

                const msg = options.getString('message');
                const guildMembers = await getCachedMembers(guild, { ttl: 300000 });

                // Filter all members with ANY staff role
                const staffMembers = guildMembers.filter(m =>
                    m.roles.cache.some(r => staffRoles.includes(r.id))
                );

                let sent = 0;
                let failed = 0;

                // Build the embed once (reused for all DMs)
                const embed = createEmbed({
                    title: "📢 Staff Announcement",
                    description: msg,
                    footer: `Sent by ${interaction.user.tag}`,
                });

                for (const [, staff] of staffMembers) {
                    try {
                        await staff.send({ embeds: [embed] });
                        sent++;
                    } catch {
                        failed++;
                    }
                }

                return interaction.editReply(
                    `📨 Staff DM sent.\n\n` +
                    `👥 Total staff: **${staffMembers.size}**\n` +
                    `✅ Delivered: **${sent}**\n` +
                    `⚠️ Failed (DMs closed): **${failed}**`
                );
            }

            if (false && commandName === 'staff-leaderboard') {
                // 1. Ensure the stats object exists
                const stats = db.staffStats || {};
                const entries = Object.entries(stats);

                if (entries.length === 0) {
                    return interaction.editReply({ content: "📊 No staff activity recorded yet." });
                }

                // 2. Sort staff by total activity (sum of all actions)
                const sortedStaff = entries.sort(([, a], [, b]) => {
                    const totalA = (a.messages || 0) + (a.warns || 0) + (a.kicks || 0) + (a.bans || 0);
                    const totalB = (b.messages || 0) + (b.warns || 0) + (b.kicks || 0) + (b.bans || 0);
                    return totalB - totalA;
                }).slice(0, 10); // Top 10

                // 3. Build the leaderboard string
                const leaderboard = sortedStaff.map(([id, data], index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';
                    return `${medal} <@${id}>\n` +
                        `💬 **Msgs:** \`${data.messages || 0}\` | ⚖️ **Warns:** \`${data.warns || 0}\`\n` +
                        `👢 **Kicks:** \`${data.kicks || 0}\` | 🔨 **Bans:** \`${data.bans || 0}\` | ⚡ **Strikes:** \`${data.strikes || 0}\`\n` +
                        `──────────────`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle('🏆 OsQarek’s Universe | Staff Leaderboard')
                    .setDescription(leaderboard)
                    .setColor(0xFFA500) // Orange/Gold
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .setTimestamp()
                    .setFooter({ text: 'Weekly Activity reset on Mondays' });

                return await interaction.editReply({ embeds: [embed] });
            } if (false && commandName === 'staff-leaderboard') {
                const stats = db.staffStats || {};
                const entries = Object.entries(stats);

                if (entries.length === 0) {
                    return interaction.editReply({ content: "📊 No staff activity recorded yet." });
                }

                // 2. Sort staff by total activity (sum of all actions)
                const sortedStaff = entries.sort(([, a], [, b]) => {
                    const totalA = (a.messages || 0) + (a.warns || 0) + (a.kicks || 0) + (a.bans || 0);
                    const totalB = (b.messages || 0) + (b.warns || 0) + (b.kicks || 0) + (b.bans || 0);
                    return totalB - totalA;
                }).slice(0, 10); // Top 10

                // 3. Build the leaderboard string
                const leaderboard = sortedStaff.map(([id, data], index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';
                    return `${medal} <@${id}>\n` +
                        `💬 **Msgs:** \`${data.messages || 0}\` | ⚖️ **Warns:** \`${data.warns || 0}\`\n` +
                        `👢 **Kicks:** \`${data.kicks || 0}\` | 🔨 **Bans:** \`${data.bans || 0}\` | ⚡ **Strikes:** \`${data.strikes || 0}\`\n` +
                        `──────────────`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle('🏆 OsQarek’s Universe | Staff Leaderboard')
                    .setDescription(leaderboard)
                    .setColor(0xFFA500) // Orange/Gold
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .setTimestamp()
                    .setFooter({ text: 'Weekly Activity reset on Mondays' });

                return await interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'latest-update') {
                const { EmbedBuilder } = require('discord.js');

                const updateEmbed = new EmbedBuilder()
                    .setTitle('🚀 OsQarek’s Universe | Bot Update v1.4.2')
                    .setDescription('**Latest stability patches and feature additions.**')
                    .setColor(0x00FF00) // Vibrant Green
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .addFields(
                        {
                            name: '🛡️ Stability Fixes',
                            value: '• Resolved intermittent crashes during high load.\n• Optimized database queries for faster response times.'
                        }
                    )
                    .setFooter({ text: 'Universe Utilities', iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp();

                // Since you have a global defer, use editReply
                return await interaction.editReply({ embeds: [updateEmbed] });
            }
            if (commandName === 'latest-action') {
                const modLogs = db.modLogs || [];

                if (modLogs.length === 0) {
                    return interaction.editReply({ content: "📂 No moderation actions recorded yet." });
                }

                // 🕒 Get the last 5 actions and reverse them so the newest is at the top
                const recentActions = modLogs.slice(-5).reverse();

                const embed = new EmbedBuilder()
                    .setTitle('🛰️ OsQarek’s Universe | Recent Activity')
                    .setColor(0x00FFFF)
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .setTimestamp();

                const logList = recentActions.map((log, index) => {
                    const time = `<t:${Math.floor(log.timestamp / 1000)}:R>`;
                    const actionEmoji = log.action.includes('Ban') ? '🔨' : log.action.includes('LOA') ? '📂' : '📝';

                    return `**${index + 1}. ${actionEmoji} ${log.action}**\n` +
                        `👤 **Target:** ${log.target}\n` +
                        `🛡️ **Moderator:** ${log.moderator} | ${time}\n` +
                        `📄 **Reason:** \`${log.reason || 'None'}\`\n` +
                        `──────────────`;
                }).join('\n');

                embed.setDescription(logList);

                return await interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'summarize') {
                const messages = await interaction.channel.messages.fetch({ limit: 50 });
                const textContent = messages.map(m => `${m.author.username}: ${m.content}`).join('\n');

                const response = await hf.chatCompletion({
                    model: "Qwen/Qwen3.8-27B",
                    provider: "featherless-ai",
                    messages: [
                        { role: "system", content: "Summarize the following chat conversation in 3 bullet points." },
                        { role: "user", content: textContent }
                    ]
                });

                const summaryEmbed = createEmbed({
                    title: '🛰️ Channel Summary (Last 50 Msgs)',
                    description: response.choices[0].message.content,
                    timestamp: false,
                });

                await interaction.editReply({ embeds: [summaryEmbed] });
            }
            if (commandName === 'strike') {
                const sub = interaction.options.getSubcommand();
                const target = interaction.options.getMember('target');
                const reason = interaction.options.getString('reason');
                const moderator = interaction.member;

                // IDs
                const OWNER_ROLE_ID = '771423764511981599';
                const CO_OWNER_ROLE_ID = '1511810524818440243';
                const STAFF_ONLY_LOG = '1478171273422045277';

                if (!moderator.roles.cache.has(OWNER_ROLE_ID) && !moderator.roles.cache.has(CO_OWNER_ROLE_ID)) {
                    return interaction.editReply("❌ Only Owner/Co-Owner can manage strikes.");
                }

                // Switched from db.offences to db.staffStrikes
                if (!db.staffStrikes[target.id]) db.staffStrikes[target.id] = 0;

                let embed = createEmbed();

                if (sub === 'add') {
                    db.staffStrikes[target.id] += 1;
                    const count = db.staffStrikes[target.id];

                    embed.setTitle('⚠️ Staff Strike Added')
                        .setColor(count >= 3 ? '#FF0055' : BRAND_COLOR)
                        .setDescription(`**${target.user.tag}** now has **${count}/3** strikes.\n**Reason:** ${reason}`);

                    db.cases.push({ id: db.cases.length + 1, user: target.id, type: 'Staff Strike', reason, moderator: moderator.user.tag });
                } else {
                    if (db.staffStrikes[target.id] <= 0) return interaction.editReply("Target has no strikes.");

                    db.staffStrikes[target.id] -= 1;
                    const count = db.staffStrikes[target.id];

                    embed.setTitle('✅ Staff Strike Removed')
                        .setColor('#00FF99')
                        .setDescription(`Removed 1 strike from **${target.user.tag}**.\n**Remaining:** ${count}\n**Reason:** ${reason}`);

                    db.cases.push({ id: db.cases.length + 1, user: target.id, type: 'Strike Removal', reason, moderator: moderator.user.tag });
                }

                await db.save();

                // 1. DM the Staff Member
                try { await target.send({ embeds: [embed] }); } catch (e) { }

                // 2. Private Staff Log
                const staffLog = interaction.guild.channels.cache.get(STAFF_ONLY_LOG);
                if (staffLog) {
                    await staffLog.send({ embeds: [embed] });
                }

                // 3. Interaction Reply
                await interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'strikes') {
                const target = interaction.options.getUser('target');
                const strikeCount = db.staffStrikes[target.id] || 0;

                const embed = createEmbed({
                    title: '📋 Staff Strike Record',
                    description: `**${target.tag}** currently has **${strikeCount}** strike(s).`,
                    color: strikeCount >= 3 ? '#FF0055' : BRAND_COLOR,
                });

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'mute' && isTrial) {
                const target = options.getUser('target');
                const m = options.getInteger('minutes') || 10;
                const reason = options.getString('reason') || 'No reason provided';

                await guild.members.cache.get(target.id).timeout(m * 60000, reason);

                logAction(guild, '🔇 Mute', `**User:** ${target.tag}\n**Duration:** ${m}m\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`, 0xFFA500);
                return interaction.editReply(`🔇 Muted ${target.tag} for ${m} minutes.`);
            }

            if (commandName === 'unmute' && isTrial) {
                const target = options.getMember('target');
                if (!target.communicationDisabledUntil) return interaction.editReply("❌ User is not muted.");

                await target.timeout(null);

                logAction(guild, '🔊 Unmute', `**User:** ${target.user.tag}\n**Moderator:** ${user.tag}`, 0x00FF00);
                return interaction.editReply(`🔊 Unmuted **${target.user.tag}**.`);
            }
            if (commandName === 'pfp') {
                if (db.utilitiesEnabled === false) return interaction.editReply('🚫 The Utilities module is currently disabled.');
                const user = interaction.options.getUser('target') || interaction.user;
                const pfpEmbed = createEmbed({
                    title: `${user.username}'s Profile Picture`,
                    image: user.displayAvatarURL({ size: 1024, dynamic: true }),
                    timestamp: false,
                });
                await interaction.editReply({ embeds: [pfpEmbed] });
            }
            if (commandName === 'userignore') {
                const target = interaction.options.getUser('target');

                // Check for Admin permissions (matching your Help category)
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.editReply("❌ You need **Administrator** permissions to banish users from the Universe.");
                }

                if (!db.ignoredUsers) db.ignoredUsers = [];

                const isIgnored = db.ignoredUsers.includes(target.id);

                if (isIgnored) {
                    db.ignoredUsers = db.ignoredUsers.filter(id => id !== target.id);
                    await interaction.editReply(`✨ **${target.username}** has been unbanned from using the bot.`);
                } else {
                    db.ignoredUsers.push(target.id);
                    await interaction.editReply(`🌌 **${target.username}** is now banned from using all bot features.`);
                }

                await db.save(); // Ensure this persists on your Mac mini
            }
            if (commandName === 'banlist') {
                if (!isMod) return interaction.editReply("❌ You do not have permission to view the ban list.");

                const bans = await guild.bans.fetch().catch((err) => {
                    console.error("❌ Failed to fetch ban list:", err.message);
                    return null;
                });

                if (!bans) return interaction.editReply("❌ I couldn't fetch the ban list. Check my permissions.");
                if (!bans.size) return interaction.editReply("✅ There are no banned users.");

                const lines = bans
                    .map((ban) => `**${ban.user.tag}** (\`${ban.user.id}\`)${ban.reason ? ` - ${ban.reason}` : ''}`)
                    .slice(0, 20);

                const embed = createEmbed({
                    title: `🔨 Ban List (${bans.size})`,
                    description: lines.join('\n'),
                    footer: bans.size > 20 ? 'Showing the first 20 bans' : 'OsQarek\'s Universe',
                    timestamp: false,
                });

                return interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'diceroll') {
                const roll = Math.floor(Math.random() * 6) + 1;
                return interaction.editReply(`🎲 The universe rolled a **${roll}**!`);
            }
            if (commandName === 'randomletter') {
                const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
                let result = "";
                for (let i = 0; i < 3; i++) {
                    result += letters[Math.floor(Math.random() * letters.length)];
                }

                const signalEmbed = createEmbed({
                    title: '🛰️ Incoming Transmission',
                    description: `The universe sent a 3-letter signal: **${result}**`,
                    footer: "OsQarek's Universe • Signal Received",
                    timestamp: false,
                });

                return interaction.editReply({ embeds: [signalEmbed] });
            }
            if (commandName === 'fun') {
                if (db.funEnabled === false) return interaction.editReply('🚫 The Fun module is currently disabled.');
                const subcommand = interaction.options.getSubcommand();

                switch (subcommand) {
                    case 'joke':
                    case 'dadjoke': {
                        const response = await fetch('https://icanhazdadjoke.com/', {
                            headers: { 'Accept': 'application/json' }
                        });
                        const data = await response.json();
                        return interaction.editReply(data.joke);
                    }

                    case 'fact': {
                        const response = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
                        const data = await response.json();
                        return interaction.editReply(data.text);
                    }

                    case 'cat': {
                        const response = await fetch('https://api.thecatapi.com/v1/images/search');
                        const data = await response.json();
                        return interaction.editReply(data[0].url);
                    }

                    case 'dog': {
                        const response = await fetch('https://dog.ceo/api/breeds/image/random');
                        const data = await response.json();
                        return interaction.editReply(data.message);
                    }

                    case 'coinflip': {
                        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
                        return interaction.editReply(`🪙 The coin landed on: **${result}**!`);
                    }

                    case 'diceroll': {
                        const roll = Math.floor(Math.random() * 6) + 1;
                        return interaction.editReply(`🎲 The universe rolled a **${roll}**!`);
                    }

                    case 'randomletter': {
                        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
                        let result = "";
                        for (let i = 0; i < 3; i++) {
                            result += letters[Math.floor(Math.random() * letters.length)];
                        }

                        const signalEmbed = createEmbed({
                            title: '🛰️ Incoming Transmission',
                            description: `The universe sent a 3-letter signal: **${result}**`,
                            footer: "OsQarek's Universe • Signal Received",
                            timestamp: false,
                        });

                        return interaction.editReply({ embeds: [signalEmbed] });
                    }
                }
            }
            if (commandName === 'osqareksocials') {
                const socialEmbed = createEmbed({
                    title: '🔗 Official OsQarek Links',
                    description: 'Stay connected with the OsQarek across all platforms!',
                    thumbnail: client.user.displayAvatarURL(),
                    footer: 'OsQarek\'s Universe • Official Socials',
                    timestamp: false,
                    fields: [
                        { name: '🎮 Roblox', value: '[Follow OsQarek on Roblox!](https://www.roblox.com/users/3232149484/profile?friendshipSourceType=PlayerSearch)', inline: true },
                        { name: '🏰 OsQarek\'s Universe', value: '[Play the Game](https://www.roblox.com/games/122256355143828/OsQareks-Universe)', inline: true },
                        { name: '📺 YouTube', value: '[Subscribe](https://www.youtube.com/channel/UCzbWsgIRlrg1yTzD1SwsBAw)', inline: true },
                        { name: '🐦 Twitter', value: '[Follow](https://x.com/OQarek)', inline: true },
                        { name: '📸 Instagram', value: '[Follow](https://www.instagram.com/oscarek2304/)', inline: true },
                        { name: '🎵 Spotify', value: '[Listen](https://open.spotify.com/artist/1pJNyBvcufHketSgMj3upF?si=2c403446d85648cc)', inline: true },
                    ],
                });

                await interaction.editReply({ embeds: [socialEmbed] });
            }

            if (commandName === 'slowmode' && isMod) {
                const seconds = options.getInteger('seconds');
                await channel.setRateLimitPerUser(seconds);

                logAction(guild, '⏳ Slowmode', `**Channel:** ${channel}\n**Set to:** ${seconds}s\n**Moderator:** ${user.tag}`, 0x3498DB);
                return interaction.editReply(`✅ Slowmode set to **${seconds}s**.`);
            }

            // --- POLLS ---
            if (commandName === 'poll') {
                if (db.utilitiesEnabled === false) return interaction.editReply('🚫 The Utilities module is currently disabled.');
                const question = interaction.options.getString('question');
                const pollEmbed = new EmbedBuilder()
                    .setTitle('📊 New Poll')
                    .setDescription(question)
                    .setColor(0x9B59B6)
                    .setFooter({ text: `Asked by ${interaction.user.username}` });

                const message = await interaction.editReply({ embeds: [pollEmbed], fetchReply: true });
                await message.react('👍');
                await message.react('👎');
            }

            if (commandName === 'quiz' && options.getSubcommand() === 'create') {
                if (db.quizEnabled === false) return interaction.editReply('🚫 The Quiz module is currently disabled.');
                // 1. Check if user is banned from quizzes
                if (db.quizBanned && db.quizBanned.includes(user.id)) {
                    return interaction.editReply("❌ You are banned from creating quizzes.");
                }

                const name = options.getString('name').toLowerCase();
                const question = options.getString('question');
                const answer = options.getString('answer');

                // 2. Ensure the quiz database object exists
                if (!db.customQuizzes) db.customQuizzes = {};
                if (!db.customQuizzes[name]) db.customQuizzes[name] = [];

                // 3. Add to DB as unapproved (approved: false)
                db.customQuizzes[name].push({
                    question,
                    answer,
                    creator: user.id,
                    approved: false
                });
                await db.save();

                // 4. Build the Review Embed for Staff
                const reviewEmbed = new EmbedBuilder()
                    .setTitle("📝 New Quiz Submission")
                    .setColor(0xF1C40F)
                    .addFields(
                        { name: "Quiz Name", value: name, inline: true },
                        { name: "Creator", value: `<@${user.id}>`, inline: true },
                        { name: "Question", value: question },
                        { name: "Answer", value: `||${answer}||` }
                    )
                    .setFooter({ text: "Use buttons below to moderate this question." })
                    .setTimestamp();

                const buttons = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`qapp_approve_${name}_${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`qapp_deny_${name}_${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`qapp_ban_${name}_${user.id}`).setLabel('Ban Creator').setStyle(ButtonStyle.Secondary)
                );

                // 5. Send to Mod Log and Check for Channel
                const logChanId = db.loaChannel;
                const logChan = logChanId ? guild.channels.cache.get(logChanId) : null;

                if (logChan) {
                    await logChan.send({ embeds: [reviewEmbed], components: [buttons] }).catch(err => {
                        console.error("Failed to send to Mod Log:", err);
                    });
                    return interaction.editReply("✅ Question submitted! Staff will review it in the Mod Log.");
                } else {
                    // Fallback: If Mod Log isn't set, we notify the user but still save it
                    return interaction.editReply("⚠️ Question saved, but the Mod Log channel is not set! Staff cannot approve this yet.");
                }
            }

            if (commandName === 'quiz' && options.getSubcommand() === 'start') {
                const name = options.getString('name').toLowerCase();
                const shuffle = options.getBoolean('shuffle');

                // 1. Check if the quiz exists at all
                if (!db.customQuizzes || !db.customQuizzes[name]) {
                    return interaction.editReply("❌ That quiz doesn't exist.");
                }

                // 2. Filter for ONLY approved questions
                let quizData = db.customQuizzes[name].filter(q => q.approved === true);

                // 3. Check if there are any approved questions to play
                if (quizData.length === 0) {
                    return interaction.editReply("❌ This quiz has no approved questions yet. Please wait for staff to review them!");
                }

                // 4. Shuffle if requested
                if (shuffle) quizData = quizData.sort(() => Math.random() - 0.5);

                await interaction.editReply(`🎯 Starting quiz: **${name}**! Check the channel below.`);

                let score = 0;
                const filter = m => m.author.id === user.id;

                // Game Loop
                for (const [index, q] of quizData.entries()) {
                    const embed = new EmbedBuilder()
                        .setTitle(`Quiz: ${name}`)
                        .setDescription(`**Question ${index + 1}:**\n${q.question}`)
                        .setFooter({ text: `Score: ${score} | Type your answer in the chat!` })
                        .setColor(0x3498DB);

                    await interaction.channel.send({ content: `<@${user.id}>`, embeds: [embed] });

                    try {
                        // Wait 15 seconds for an answer
                        const collected = await interaction.channel.awaitMessages({
                            filter,
                            max: 1,
                            time: 15000,
                            errors: ['time']
                        });

                        const userAns = collected.first().content.toLowerCase().trim();
                        if (userAns === q.answer.toLowerCase().trim()) {
                            score++;
                            await interaction.channel.send("✅ **Correct!**");
                        } else {
                            await interaction.channel.send(`❌ **Wrong!** The correct answer was: \`${q.answer}\``);
                        }
                    } catch (e) {
                        await interaction.channel.send(`⏰ **Time's up!** The answer was: \`${q.answer}\``);
                    }
                }

                const finalEmbed = new EmbedBuilder()
                    .setTitle("🏁 Quiz Complete!")
                    .setDescription(`${user.username}, you finished **${name}** with a score of **${score}/${quizData.length}**!`)
                    .setColor(0x2ECC71);

                return interaction.channel.send({ embeds: [finalEmbed] });
            }

            if (commandName === 'quiz' && options.getSubcommand() === 'list') {
                const quizzes = Object.keys(db.customQuizzes || {});
                if (quizzes.length === 0) return interaction.editReply("📚 No custom quizzes found.");

                const list = quizzes.map(q => `• **${q}** (${db.customQuizzes[q].length} questions)`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle("📚 Available Quizzes")
                    .setDescription(list)
                    .setColor(0x3498DB);

                return interaction.editReply({ embeds: [embed] });
            }
            // --- DELETE ENTIRE QUIZ ---
            if (commandName === 'quiz' && options.getSubcommand() === 'delete') {
                const name = interaction.options.getString('name').toLowerCase();
                if (!db.customQuizzes?.[name]) return interaction.editReply("❌ Quiz not found.");

                delete db.customQuizzes[name];
                await db.save();
                await interaction.editReply(`🗑️ Entire quiz **${name}** and all its questions have been deleted.`);
            }
            // --- 4. RECORDS & NOTES ---
if (commandName === 'warn' && options.getSubcommand() === 'delete') {
    if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
    const target = options.getUser('target');

    const userCases = db.cases.filter(c => c.userId === target.id);
    if (userCases.length === 0) {
        return interaction.editReply("❌ That user has no cases to remove.");
    }

    const lastCaseIndex = db.cases.map(c => c.userId).lastIndexOf(target.id);
    db.cases.splice(lastCaseIndex, 1);

    db.offences[target.id] = db.cases.filter(c => c.userId === target.id).length;

    await db.save();
    logAction(guild, '➖ Warn Removed', `User: ${target.tag}\nMod: ${user.tag}`);
    return interaction.editReply("✅ Removed 1 offence and deleted the most recent case.");
}
if (commandName === 'warn' && options.getSubcommand() === 'clear') {
                if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Administrator+** to use this.");
                const target = options.getUser('target'); db.offences[target.id] = 0; await db.save();
                logAction(guild, '♻️ Warns Cleared', `User: ${target.tag}\nMod: ${user.tag}`);
                return interaction.editReply("✅ Cleared all offences.");
            }
            if (commandName === 'warn' && options.getSubcommandGroup(false) === 'offense' && options.getSubcommand() === 'clear') {
                if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Administrator+** to use this.");
                const target = options.getUser('target');
                db.offences[target.id] = 0;
                await db.save();
                logAction(guild, '♻️ Offence Count Cleared', `User: ${target.tag}\nMod: ${user.tag}`);
                return interaction.editReply(`✅ Cleared **${target.tag}**'s offence count. Their case history has been kept.`);
            }
            if (commandName === 'notes' && options.getSubcommand() === 'add' && isTrial) {
                const target = options.getUser('target'); if (!db.notes[target.id]) db.notes[target.id] = [];
                db.notes[target.id].push({ text: options.getString('note'), mod: user.tag });
                await db.save(); return interaction.editReply("✅ Note added.");
            }
            if (commandName === 'notes' && options.getSubcommand() === 'view' && isTrial) {
                const target = options.getUser('target');
                const list = (db.notes[target.id] || []).map((n, i) => `**#${i + 1}** ${n.text} (${n.mod})`).join('\n') || "None";
                return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`Notes: ${target.tag}`).setDescription(list)] });
            }
            if (commandName === 'quiz' && options.getSubcommand() === 'ban') {
                // Check for Admin permissions (or use your existing mod check logic)
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.editReply("❌ You don't have permission to use this command.");
                }

                const target = interaction.options.getUser('target');
                const status = interaction.options.getBoolean('status');

                if (!db.quizBanned) db.quizBanned = [];

                if (status) {
                    if (!db.quizBanned.includes(target.id)) {
                        db.quizBanned.push(target.id);
                        await db.save();
                    }
                    await interaction.editReply(`🚫 **${target.username}** has been banned from creating quizzes.`);
                } else {
                    db.quizBanned = db.quizBanned.filter(id => id !== target.id);
                    await db.save();
                    await interaction.editReply(`✅ **${target.username}** is no longer banned from creating quizzes.`);
                }
            }
            if (commandName === 'notes' && options.getSubcommand() === 'delete' && isTrial) {
                const target = options.getUser('target'); const idx = options.getInteger('index') - 1;
                if (db.notes[target.id]?.[idx]) { db.notes[target.id].splice(idx, 1); await db.save(); return interaction.editReply("✅ Deleted."); }
                return interaction.editReply("❌ Not found.");
            }
            if (commandName === 'warn' && options.getSubcommand() === 'offences') {
                const target = options.getUser('target') || user;
                return interaction.editReply(`📊 ${target.tag} has **${db.offences[target.id] || 0}** offences.`);
            }
            if (commandName === 'quiz' && options.getSubcommand() === 'trivia' && options.getString('type') === 'states') {
                let statePool = [
                    { name: 'Alabama', code: 'al', flag: 'https://flagcdn.com/w320/us-al.png' },
                    { name: 'Alaska', code: 'ak', flag: 'https://flagcdn.com/w320/us-ak.png' },
                    { name: 'Arizona', code: 'az', flag: 'https://flagcdn.com/w320/us-az.png' },
                    { name: 'Arkansas', code: 'ar', flag: 'https://flagcdn.com/w320/us-ar.png' },
                    { name: 'California', code: 'ca', flag: 'https://flagcdn.com/w320/us-ca.png' },
                    { name: 'Colorado', code: 'co', flag: 'https://flagcdn.com/w320/us-co.png' },
                    { name: 'Connecticut', code: 'ct', flag: 'https://flagcdn.com/w320/us-ct.png' },
                    { name: 'Delaware', code: 'de', flag: 'https://flagcdn.com/w320/us-de.png' },
                    { name: 'Florida', code: 'fl', flag: 'https://flagcdn.com/w320/us-fl.png' },
                    { name: 'Georgia', code: 'ga', flag: 'https://flagcdn.com/w320/us-ga.png' },
                    { name: 'Hawaii', code: 'hi', flag: 'https://flagcdn.com/w320/us-hi.png' },
                    { name: 'Idaho', code: 'id', flag: 'https://flagcdn.com/w320/us-id.png' },
                    { name: 'Illinois', code: 'il', flag: 'https://flagcdn.com/w320/us-il.png' },
                    { name: 'Indiana', code: 'in', flag: 'https://flagcdn.com/w320/us-in.png' },
                    { name: 'Iowa', code: 'ia', flag: 'https://flagcdn.com/w320/us-ia.png' },
                    { name: 'Kansas', code: 'ks', flag: 'https://flagcdn.com/w320/us-ks.png' },
                    { name: 'Kentucky', code: 'ky', flag: 'https://flagcdn.com/w320/us-ky.png' },
                    { name: 'Louisiana', code: 'la', flag: 'https://flagcdn.com/w320/us-la.png' },
                    { name: 'Maine', code: 'me', flag: 'https://flagcdn.com/w320/us-me.png' },
                    { name: 'Maryland', code: 'md', flag: 'https://flagcdn.com/w320/us-md.png' },
                    { name: 'Massachusetts', code: 'ma', flag: 'https://flagcdn.com/w320/us-ma.png' },
                    { name: 'Michigan', code: 'mi', flag: 'https://flagcdn.com/w320/us-mi.png' },
                    { name: 'Minnesota', code: 'mn', flag: 'https://flagcdn.com/w320/us-mn.png' },
                    { name: 'Mississippi', code: 'ms', flag: 'https://flagcdn.com/w320/us-ms.png' },
                    { name: 'Missouri', code: 'mo', flag: 'https://flagcdn.com/w320/us-mo.png' },
                    { name: 'Montana', code: 'mt', flag: 'https://flagcdn.com/w320/us-mt.png' },
                    { name: 'Nebraska', code: 'ne', flag: 'https://flagcdn.com/w320/us-ne.png' },
                    { name: 'Nevada', code: 'nv', flag: 'https://flagcdn.com/w320/us-nv.png' },
                    { name: 'New Hampshire', code: 'nh', flag: 'https://flagcdn.com/w320/us-nh.png' },
                    { name: 'New Jersey', code: 'nj', flag: 'https://flagcdn.com/w320/us-nj.png' },
                    { name: 'New Mexico', code: 'nm', flag: 'https://flagcdn.com/w320/us-nm.png' },
                    { name: 'New York', code: 'ny', flag: 'https://flagcdn.com/w320/us-ny.png' },
                    { name: 'North Carolina', code: 'nc', flag: 'https://flagcdn.com/w320/us-nc.png' },
                    { name: 'North Dakota', code: 'nd', flag: 'https://flagcdn.com/w320/us-nd.png' },
                    { name: 'Ohio', code: 'oh', flag: 'https://flagcdn.com/w320/us-oh.png' },
                    { name: 'Oklahoma', code: 'ok', flag: 'https://flagcdn.com/w320/us-ok.png' },
                    { name: 'Oregon', code: 'or', flag: 'https://flagcdn.com/w320/us-or.png' },
                    { name: 'Pennsylvania', code: 'pa', flag: 'https://flagcdn.com/w320/us-pa.png' },
                    { name: 'Rhode Island', code: 'ri', flag: 'https://flagcdn.com/w320/us-ri.png' },
                    { name: 'South Carolina', code: 'sc', flag: 'https://flagcdn.com/w320/us-sc.png' },
                    { name: 'South Dakota', code: 'sd', flag: 'https://flagcdn.com/w320/us-sd.png' },
                    { name: 'Tennessee', code: 'tn', flag: 'https://flagcdn.com/w320/us-tn.png' },
                    { name: 'Texas', code: 'tx', flag: 'https://flagcdn.com/w320/us-tx.png' },
                    { name: 'Utah', code: 'ut', flag: 'https://flagcdn.com/w320/us-ut.png' },
                    { name: 'Vermont', code: 'vt', flag: 'https://flagcdn.com/w320/us-vt.png' },
                    { name: 'Virginia', code: 'va', flag: 'https://flagcdn.com/w320/us-va.png' },
                    { name: 'Washington', code: 'wa', flag: 'https://flagcdn.com/w320/us-wa.png' },
                    { name: 'West Virginia', code: 'wv', flag: 'https://flagcdn.com/w320/us-wv.png' },
                    { name: 'Wisconsin', code: 'wi', flag: 'https://flagcdn.com/w320/us-wi.png' },
                    { name: 'Wyoming', code: 'wy', flag: 'https://flagcdn.com/w320/us-wy.png' }
                ];

                let statesFinished = 0;
                let isGameActive = true;
                let sessionScores = {}; // Local score tracking

                await interaction.editReply({ content: "🏁 **The 50 State Marathon is starting!** Get ready..." });

                const showFinalResults = async () => {
                    const sorted = Object.entries(sessionScores)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 5); // Get top 5

                    let scoreboard = sorted.length > 0
                        ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
                        : "No one scored this time!";

                    const resultsEmbed = new EmbedBuilder()
                        .setTitle("🏆 Quiz Results")
                        .setDescription(`**Game Over!** Here is how you did:\n\n${scoreboard}`)
                        .setColor(0xF1C40F)
                        .setFooter({ text: `Total States Covered: ${statesFinished}/50` });

                    await interaction.channel.send({ embeds: [resultsEmbed] });
                };

                const startNewRound = async () => {
                    if (!isGameActive) return await showFinalResults();

                    if (statePool.length === 0) {
                        isGameActive = false;
                        await interaction.channel.send("🏆 **The Marathon is complete!** All 50 states found.");
                        return await showFinalResults();
                    }

                    const randomIndex = Math.floor(Math.random() * statePool.length);
                    const state = statePool[randomIndex];
                    statePool.splice(randomIndex, 1);

                    statesFinished++;

                    const quizEmbed = new EmbedBuilder()
                        .setTitle(`🏁 State Quiz (${statesFinished}/50)`)
                        .setDescription('**Which state does this flag belong to?**\nYou have 60 seconds!')
                        .setImage(state.flag)
                        .setColor(0x3498DB);

                    await interaction.channel.send({ embeds: [quizEmbed] });

                    const filter = m => {
                        const guess = m.content.toLowerCase();
                        if (guess === 'stop quiz') return true;
                        return guess === state.name.toLowerCase() || guess === state.code.toLowerCase();
                    };

                    const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
                    let answered = false;

                    collector.on('collect', async m => {
                        if (m.content.toLowerCase() === 'stop quiz') {
                            isGameActive = false;
                            await m.reply("🛑 **Quiz stopped.** Calculating final scores...");
                            collector.stop();
                            return;
                        }

                        answered = true;

                        // Session tracking
                        sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

                        // Database tracking
                        if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
                        db.stats[m.author.id].triviaPoints = (db.stats[m.author.id].triviaPoints || 0) + 1;
                        await db.save();

                        await m.reply(`🌟 **Correct!** It was **${state.name}**. Next round starting...`);
                        collector.stop();
                    });

                    collector.on('end', async () => {
                        if (!isGameActive) return;

                        if (!answered) {
                            await interaction.channel.send(`⏰ **Time's up!** The answer was **${state.name}**. Moving on...`);
                        }
                        setTimeout(startNewRound, 2000);
                    });
                };

                startNewRound();
            }
            if (commandName === 'quiz' && options.getSubcommand() === 'trivia' && options.getString('type') === 'countries') {
                let countryPool = [
                    // --- EASY / WELL KNOWN ---
                    { name: 'United States', code: 'us', flag: 'https://flagcdn.com/w320/us.png' },
                    { name: 'United Kingdom', code: 'gb', flag: 'https://flagcdn.com/w320/gb.png' },
                    { name: 'Canada', code: 'ca', flag: 'https://flagcdn.com/w320/ca.png' },
                    { name: 'France', code: 'fr', flag: 'https://flagcdn.com/w320/fr.png' },
                    { name: 'Germany', code: 'de', flag: 'https://flagcdn.com/w320/de.png' },
                    { name: 'Japan', code: 'jp', flag: 'https://flagcdn.com/w320/jp.png' },
                    { name: 'Brazil', code: 'br', flag: 'https://flagcdn.com/w320/br.png' },
                    { name: 'Australia', code: 'au', flag: 'https://flagcdn.com/w320/au.png' },
                    { name: 'Italy', code: 'it', flag: 'https://flagcdn.com/w320/it.png' },
                    { name: 'Mexico', code: 'mx', flag: 'https://flagcdn.com/w320/mx.png' },
                    { name: 'South Korea', code: 'kr', flag: 'https://flagcdn.com/w320/kr.png' },
                    { name: 'China', code: 'cn', flag: 'https://flagcdn.com/w320/cn.png' },
                    { name: 'India', code: 'in', flag: 'https://flagcdn.com/w320/in.png' },
                    { name: 'Spain', code: 'es', flag: 'https://flagcdn.com/w320/es.png' },
                    { name: 'Argentina', code: 'ar', flag: 'https://flagcdn.com/w320/ar.png' },
                    { name: 'Greece', code: 'gr', flag: 'https://flagcdn.com/w320/gr.png' },
                    { name: 'Turkey', code: 'tr', flag: 'https://flagcdn.com/w320/tr.png' },
                    { name: 'Switzerland', code: 'ch', flag: 'https://flagcdn.com/w320/ch.png' },
                    { name: 'Sweden', code: 'se', flag: 'https://flagcdn.com/w320/se.png' },
                    { name: 'Egypt', code: 'eg', flag: 'https://flagcdn.com/w320/eg.png' },

                    // --- MEDIUM ---
                    { name: 'Vietnam', code: 'vn', flag: 'https://flagcdn.com/w320/vn.png' },
                    { name: 'Norway', code: 'no', flag: 'https://flagcdn.com/w320/no.png' },
                    { name: 'Poland', code: 'pl', flag: 'https://flagcdn.com/w320/pl.png' },
                    { name: 'Ukraine', code: 'ua', flag: 'https://flagcdn.com/w320/ua.png' },
                    { name: 'Iceland', code: 'is', flag: 'https://flagcdn.com/w320/is.png' },
                    { name: 'New Zealand', code: 'nz', flag: 'https://flagcdn.com/w320/nz.png' },
                    { name: 'Portugal', code: 'pt', flag: 'https://flagcdn.com/w320/pt.png' },
                    { name: 'Thailand', code: 'th', flag: 'https://flagcdn.com/w320/th.png' },
                    { name: 'South Africa', code: 'za', flag: 'https://flagcdn.com/w320/za.png' },
                    { name: 'Ireland', code: 'ie', flag: 'https://flagcdn.com/w320/ie.png' },
                    { name: 'Jamaica', code: 'jm', flag: 'https://flagcdn.com/w320/jm.png' },
                    { name: 'Finland', code: 'fi', flag: 'https://flagcdn.com/w320/fi.png' },
                    { name: 'Morocco', code: 'ma', flag: 'https://flagcdn.com/w320/ma.png' },
                    { name: 'Israel', code: 'il', flag: 'https://flagcdn.com/w320/il.png' },

                    // --- DIFFICULT / TERRITORIES ---
                    { name: 'Bhutan', code: 'bt', flag: 'https://flagcdn.com/w320/bt.png' },
                    { name: 'Kazakhstan', code: 'kz', flag: 'https://flagcdn.com/w320/kz.png' },
                    { name: 'Eswatini', code: 'sz', flag: 'https://flagcdn.com/w320/sz.png' },
                    { name: 'Kiribati', code: 'ki', flag: 'https://flagcdn.com/w320/ki.png' },
                    { name: 'Seychelles', code: 'sc', flag: 'https://flagcdn.com/w320/sc.png' },
                    { name: 'Saint Lucia', code: 'lc', flag: 'https://flagcdn.com/w320/lc.png' },
                    { name: 'Grenada', code: 'gd', flag: 'https://flagcdn.com/w320/gd.png' },
                    { name: 'Greenland', code: 'gl', flag: 'https://flagcdn.com/w320/gl.png' },
                    { name: 'Faroe Islands', code: 'fo', flag: 'https://flagcdn.com/w320/fo.png' },
                    { name: 'Guam', code: 'gu', flag: 'https://flagcdn.com/w320/gu.png' },
                    { name: 'French Polynesia', code: 'pf', flag: 'https://flagcdn.com/w320/pf.png' },
                    { name: 'Gibraltar', code: 'gi', flag: 'https://flagcdn.com/w320/gi.png' },
                    { name: 'American Samoa', code: 'as', flag: 'https://flagcdn.com/w320/as.png' },
                    { name: 'Isle of Man', code: 'im', flag: 'https://flagcdn.com/w320/im.png' },
                    { name: 'Curacao', code: 'cw', flag: 'https://flagcdn.com/w320/cw.png' },
                    { name: 'Aruba', code: 'aw', flag: 'https://flagcdn.com/w320/aw.png' }
                ];

                let roundsFinished = 0;
                let isGameActive = true;
                let sessionScores = {};

                await interaction.editReply({ content: "🌍 **The Global Flag Marathon is starting!** Get ready..." });

                const startNewRound = async () => {
                    if (!isGameActive) return;

                    if (countryPool.length === 0) {
                        await interaction.channel.send("🏆 **The World Tour is over!** You finished all 50 locations.");
                        return showFinalResults();
                    }

                    const randomIndex = Math.floor(Math.random() * countryPool.length);
                    const country = countryPool[randomIndex];
                    countryPool.splice(randomIndex, 1);
                    roundsFinished++;

                    const quizEmbed = new EmbedBuilder()
                        .setTitle(`🌍 Country/Territory Quiz (${roundsFinished}/50)`)
                        .setDescription('**Which country or territory does this flag belong to?**\nYou have 60 seconds!')
                        .setImage(country.flag)
                        .setColor(0x2ECC71);

                    await interaction.channel.send({ embeds: [quizEmbed] });

                    const filter = m => {
                        const guess = m.content.toLowerCase();
                        return guess === 'stop quiz' || guess === country.name.toLowerCase() || guess === country.code.toLowerCase();
                    };

                    const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
                    let answered = false;

                    collector.on('collect', async m => {
                        if (m.content.toLowerCase() === 'stop quiz') {
                            isGameActive = false;
                            await m.reply("🛑 **Quiz stopped.** Showing final scores...");
                            collector.stop();
                            return;
                        }

                        answered = true;
                        sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

                        // Database tracking
                        if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
                        db.stats[m.author.id].triviaPoints++;
                        await db.save();

                        await m.reply(`🌟 **Correct!** It was **${country.name}** (${country.code.toUpperCase()}). Next round starting...`);
                        collector.stop();
                    });

                    collector.on('end', async () => {
                        if (!isGameActive) return showFinalResults();

                        if (!answered) {
                            await interaction.channel.send(`⏰ **Time's up!** The answer was **${country.name}**. Moving on...`);
                        }
                        setTimeout(startNewRound, 2000);
                    });
                };

                const showFinalResults = async () => {
                    const sorted = Object.entries(sessionScores)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 5);

                    let scoreboard = sorted.length > 0
                        ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
                        : "No one scored this time!";

                    const resultsEmbed = new EmbedBuilder()
                        .setTitle("🏆 Final Leaderboard")
                        .setDescription(scoreboard)
                        .setColor(0xF1C40F)
                        .setFooter({ text: `Total Locations: ${roundsFinished}/50` });

                    await interaction.channel.send({ embeds: [resultsEmbed] });
                };

                startNewRound();
            }
            if (commandName === 'quiz' && options.getSubcommand() === 'trivia' && options.getString('type') === 'canada') {
                let canadaPool = [
                    { name: 'Ontario', code: 'on', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Flag_of_Ontario.svg/320px-Flag_of_Ontario.svg.png' },
                    { name: 'Quebec', code: 'qc', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Flag_of_Quebec.svg/320px-Flag_of_Quebec.svg.png' },
                    { name: 'Nova Scotia', code: 'ns', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Flag_of_Nova_Scotia.svg/320px-Flag_of_Nova_Scotia.svg.png' },
                    { name: 'New Brunswick', code: 'nb', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Flag_of_New_Brunswick.svg/320px-Flag_of_New_Brunswick.svg.png' },
                    { name: 'Manitoba', code: 'mb', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Flag_of_Manitoba.svg/320px-Flag_of_Manitoba.svg.png' },
                    { name: 'British Columbia', code: 'bc', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Flag_of_British_Columbia.svg/320px-Flag_of_British_Columbia.svg.png' },
                    { name: 'Prince Edward Island', code: 'pe', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Flag_of_Prince_Edward_Island.svg/320px-Flag_of_Prince_Edward_Island.svg.png' },
                    { name: 'Saskatchewan', code: 'sk', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/Flag_of_Saskatchewan.svg/320px-Flag_of_Saskatchewan.svg.png' },
                    { name: 'Alberta', code: 'ab', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f5/Flag_of_Alberta.svg/320px-Flag_of_Alberta.svg.png' },
                    { name: 'Newfoundland and Labrador', code: 'nl', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Flag_of_Newfoundland_and_Labrador.svg/320px-Flag_of_Newfoundland_and_Labrador.svg.png' },
                    { name: 'Northwest Territories', code: 'nt', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Flag_of_the_Northwest_Territories.svg/320px-Flag_of_the_Northwest_Territories.svg.png' },
                    { name: 'Yukon', code: 'yt', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Flag_of_Yukon.svg/320px-Flag_of_Yukon.svg.png' },
                    { name: 'Nunavut', code: 'nu', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/Flag_of_Nunavut.svg/320px-Flag_of_Nunavut.svg.png' }
                ].sort(() => Math.random() - 0.5);

                let roundsFinished = 0;
                let isGameActive = true;
                let sessionScores = {};

                await interaction.editReply({ content: "🇨🇦 **The Canadian Sprint is starting!** (13 Rounds)" });

                const startNewRound = async () => {
                    if (!isGameActive) return;

                    if (canadaPool.length === 0) {
                        await interaction.channel.send("🏆 **Sprint complete!**");
                        return showFinalResults();
                    }

                    const current = canadaPool.shift();
                    roundsFinished++;

                    const quizEmbed = new EmbedBuilder()
                        .setTitle(`🇨🇦 Canada Quiz (${roundsFinished}/13)`)
                        .setDescription('**Identify this Province or Territory!**')
                        .setImage(current.flag)
                        .setColor(0xFF0000);

                    await interaction.channel.send({ embeds: [quizEmbed] });

                    const filter = m => {
                        const guess = m.content.toLowerCase();
                        return guess === 'stop quiz' || guess === current.name.toLowerCase() || guess === current.code.toLowerCase();
                    };

                    const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
                    let answered = false;

                    collector.on('collect', async m => {
                        if (m.content.toLowerCase() === 'stop quiz') {
                            isGameActive = false;
                            await m.reply("🛑 **Quiz stopped.**");
                            collector.stop();
                            return;
                        }

                        answered = true;
                        sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

                        if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
                        db.stats[m.author.id].triviaPoints++;
                        await db.save();

                        await m.reply(`🌟 **Correct!** That was **${current.name}**. Next one...`);
                        collector.stop();
                    });

                    collector.on('end', async () => {
                        if (!isGameActive) return showFinalResults();
                        if (!answered) {
                            await interaction.channel.send(`⏰ **Time's up!** The answer was **${current.name}**.`);
                        }
                        setTimeout(startNewRound, 2000);
                    });
                };

                const showFinalResults = async () => {
                    const sorted = Object.entries(sessionScores)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 5);

                    let scoreboard = sorted.length > 0
                        ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
                        : "No points this round!";

                    const resultsEmbed = new EmbedBuilder()
                        .setTitle("🏆 Final Canadian Standings")
                        .setDescription(scoreboard)
                        .setColor(0xF1C40F);

                    await interaction.channel.send({ embeds: [resultsEmbed] });
                };

                startNewRound();
            }
            if (commandName === 'stateleaderboard') {
                // Sort all users by their triviaPoints
                const sorted = Object.entries(db.stats)
                    .filter(([id, stats]) => stats.triviaPoints > 0)
                    .sort(([, a], [, b]) => b.triviaPoints - a.triviaPoints)
                    .slice(0, 10); // Top 10

                const lbEmbed = new EmbedBuilder()
                    .setTitle('🏆 State Quiz Leaderboard')
                    .setColor(0xF1C40F);

                let list = sorted.map(([id, stats], index) => {
                    return `**#${index + 1}** <@${id}> — \`${stats.triviaPoints}\` Points`;
                }).join('\n');

                lbEmbed.setDescription(list || "No points awarded yet. Start a quiz with `/statequiz`!");
                return interaction.editReply({ embeds: [lbEmbed] });
            }
            if (commandName === 'ship') {
                let u1 = interaction.options.getUser('user1');
                let u2 = interaction.options.getUser('user2');

                if (!u1 || !u2) {
                    const members = await interaction.channel.members.filter(m => !m.user.bot);
                    const randoms = members.random(2);
                    u1 = u1 || randoms[0].user;
                    u2 = u2 || randoms[1].user;
                }

                const lovePercent = Math.floor(Math.random() * 101);
                const shipEmbed = createEmbed({
                    title: '💖 Universe Matchmaker',
                    description: `**${u1.username}** & **${u2.username}**\n\n**Match:** ${lovePercent}%`,
                    color: lovePercent > 50 ? '#FF00FF' : BRAND_COLOR,
                });

                await interaction.editReply({ embeds: [shipEmbed] });
            }
            if (commandName === 'ask-rules') {
                const question = interaction.options.getString('question');

                // Updated Rules & Warning System Context for the AI
                const rulesText = `
            OsQarek’s Universe Rules:
            1. Respectful communication, no bullying.
            2. No spam (except in #spam).
            3. Respect privacy.
            4. No self-promotion (except in #self-promo).
            5. Follow Discord ToS.
            6. No NSFW.
            
            Warning System (Escalation Ladder):
            - 1st offence: Official Warn
            - 2nd offence: 10m mute
            - 3rd offence: 30m mute
            - 4th offence: Kick
            - 5th offence: Kick
            - 6th offence: 1d ban
            - 7th offence: Permanent ban
            `;

                const response = await hf.chatCompletion({
                    model: "Qwen/Qwen3.8-27B",
                    provider: "featherless-ai",
                    messages: [
                        {
                            role: "system",
                            content: `You are the Rules Assistant for OsQarek's Universe. Be helpful but firm. Use these rules and the specific warning ladder to answer: ${rulesText}`
                        },
                        { role: "user", content: question }
                    ]
                });

                // Added a small "Dark Neon" purple dot to identify AI responses
                await interaction.editReply(`🔮 **Universe AI:** ${response.choices[0].message.content}`);
            }
            if (commandName === 'reactionrole') {
                const text = interaction.options.getString('text');
                const role = interaction.options.getRole('role');
                const targetChannel = interaction.options.getChannel('channel');
                const time = interaction.options.getInteger('time');

                // Permissions Check
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return interaction.editReply("❌ Only higher-ups can distribute cosmic roles.");
                }

                const roleEmbed = createEmbed({
                    title: '🌌 Universe Role Assignment',
                    description: text,
                    fields: [{ name: 'Role', value: `${role}`, inline: true }],
                });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`rr_${role.id}`)
                        .setLabel(`Get ${role.name}`)
                        .setStyle(ButtonStyle.Primary)
                );

                const sentMessage = await targetChannel.send({ embeds: [roleEmbed], components: [row] });
                await interaction.editReply(`✅ Reaction role sent to ${targetChannel}!`);

                // Handle optional expiration timer
                if (time) {
                    setTimeout(async () => {
                        const disabledRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`expired_${role.id}`)
                                .setLabel('Expired')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true)
                        );
                        await sentMessage.edit({ components: [disabledRow] }).catch(() => { });
                    }, time * 1000);
                }
            }

            if (commandName === 'warn' && options.getSubcommand() === 'view' && isTrial) {
                const target = options.getUser('target');

                const userCases = (db.cases || []).filter(c => c.userId === target.id);

                const history = userCases.map(c => {
                    let caseTime = null;

                    const possibleFields = [c.timestamp, c.createdAt, c.date, c.time, c.issuedAt];
                    for (const field of possibleFields) {
                        if (field && !isNaN(new Date(field).getTime())) {
                            caseTime = new Date(field).getTime();
                            break;
                        }
                    }

                    if (!caseTime) {
                        const timeKey = Object.keys(c).find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('date'));
                        if (timeKey && !isNaN(new Date(c[timeKey]).getTime())) {
                            caseTime = new Date(c[timeKey]).getTime();
                        }
                    }

                    if (caseTime) {
                        const unixSeconds = Math.floor(caseTime / 1000);
                        // Changed from :R to :f for the exact date and time
                        return `#${c.id} [${c.type.toUpperCase()}] ${c.reason} — <t:${unixSeconds}:f>`;
                    } else {
                        return `#${c.id} [${c.type.toUpperCase()}] ${c.reason} — *(No date logged)*`;
                    }
                }).join('\n') || "No history found for this user.";

                const embed = new EmbedBuilder()
                    .setTitle(`📜 Infraction History: ${target.username}`)
                    .setDescription(history)
                    .setColor(userCases.length > 0 ? 0xE74C3C : 0x2ECC71)
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'apply') {
                // --- TOGGLE CHECK ---
                if (db.disabledCommands && db.disabledCommands.includes('apply')) {
                    return interaction.editReply("❌ **Applications are currently closed.** Please check back later!");
                }

                const applyEmbed = new EmbedBuilder()
                    .setTitle('📝 Staff Application')
                    .setDescription(
                        "We are always looking for dedicated members to join the **OsQarek's Universe** team!\n\n" +
                        "**Requirements:**\n" +
                        "• Must be 13+ years old.\n" +
                        "• Must be active in the community.\n" +
                        "• Must have a positive attitude and willingness to help others.\n" +
                        "• Must be at least level 10\n" +
                        "• Must have at least 1000 messages (do *g.m* to check).\n" +
                        "• Must be in the server for at least 2 weeks.\n" +
                        "• Must have under 3 warnings (Ping <@933260214097035276> or <@778819029041152010> to check.)\n"
                    )
                    .addFields({
                        name: '🔗 How to Apply',
                        value: '[Click here to open the Google Form](https://forms.gle/9M2CBRCdCsJZ6ytV8)'
                    })
                    .setColor(0x3498DB)
                    .setFooter({ text: 'Good luck with your application!' })
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Open Application')
                        .setURL('https://forms.gle/9M2CBRCdCsJZ6ytV8')
                        .setStyle(ButtonStyle.Link)
                );

                return interaction.editReply({ embeds: [applyEmbed], components: [row] });

            }
            if (commandName === 'case') {
                if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
                const c = db.cases.find(x => x.id === options.getInteger('id'));
                if (!c) return interaction.editReply("❌ Case not found.");
                return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`Case #${c.id}`).addFields({ name: 'User', value: c.user }, { name: 'Reason', value: c.reason })] });
            }
            if (commandName === 'slowmode' && isMod) {
                const seconds = options.getInteger('seconds');
                await channel.setRateLimitPerUser(seconds);
                return interaction.editReply(`✅ Slowmode set to **${seconds}s**.`);
            }

            if (commandName === 'unmute' && isTrial) {
                const target = options.getMember('target');
                if (!target.communicationDisabledUntil) return interaction.editReply("❌ User is not muted.");
                await target.timeout(null);
                logAction(guild, '🔊 Unmute', `User: ${target.user.tag}\nMod: ${user.tag}`, 0x00FF00);
                return interaction.editReply(`🔊 Unmuted **${target.user.tag}**.`);
            }
            if (commandName === 'syncstats' && isAtLeastAdmin) {
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.deferReply();
                }

                try {
                    const syncStartedAt = Date.now();
                    const runAudit = interaction.options.getBoolean('audit') || false;
                    const isDryRun = interaction.options.getBoolean('dryrun') || false;
                    const isDebug = interaction.options.getBoolean('debug') || false;

                    // 1. Calculate Start Timestamp (Last Monday)
                    const lastMonday = new Date();
                    lastMonday.setHours(0, 0, 0, 0);
                    const day = lastMonday.getDay();
                    const diff = (day === 0 ? 6 : day - 1);
                    lastMonday.setDate(lastMonday.getDate() - diff);
                    const startTimestamp = lastMonday.getTime();

                    const guild = interaction.guild;
                    const allMembers = await guild.members.fetch();
                    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

                    let auditLog = { kicked: 0, flagged: [], failed: 0, debugAges: [] };
                    let modeText = isDryRun ? '🧪 (Mode: Dry Run)' : (runAudit ? '🛡️ (Mode: Active Audit)' : '📊 (Mode: Stats Only)');

                    // Exclude the bot's own automated log channels from the scan — they're filled
                    // with bot-generated action-log embeds (not staff conversation), and on servers
                    // that have been running a while they can balloon into hundreds of thousands of
                    // messages, dwarfing every real channel and wrecking the ETA/scan time for zero
                    // useful signal (log entries are authored by the bot, not by staff members).
                    const excludedLogChannelIds = new Set([db.modLogChannel, db.chatLogChannel].filter(Boolean));

                    const channelsToScan = guild.channels.cache.filter(c =>
                        c.isTextBased() &&
                        c.permissionsFor(guild.members.me).has(['ViewChannel', 'ReadMessageHistory']) &&
                        !excludedLogChannelIds.has(c.id)
                    );
                    const totalChannelsToScan = channelsToScan.size;

                    // Small helper to render a millisecond duration as "Xm Ys" or "X.Ys"
                    const formatDuration = (ms) => {
                        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
                        const minutes = Math.floor(totalSeconds / 60);
                        const remSeconds = totalSeconds % 60;
                        const tenths = Math.floor((ms % 1000) / 100);
                        return minutes > 0 ? `${minutes}m ${remSeconds}s` : `${remSeconds}.${tenths}s`;
                    };

                    // This now walks each channel's FULL history (to rebuild all-time stats), which
                    // takes much longer than a single Monday-to-now pass, so the old per-channel
                    // estimate is no longer accurate — this is a rough floor, not a real ETA. It gets
                    // replaced with a live, measured ETA once scanning actually starts (see below).
                    const estSeconds = Math.ceil(channelsToScan.size * 1.5);
                    const timeString = estSeconds < 60 ? `${estSeconds}s` : `${Math.floor(estSeconds / 60)}m ${estSeconds % 60}s`;

                    const skippedLogNote = excludedLogChannelIds.size > 0
                        ? ` (skipping ${excludedLogChannelIds.size} bot log channel${excludedLogChannelIds.size > 1 ? 's' : ''})`
                        : '';
                    await interaction.editReply(`🔍 **Syncing Universe System...** ${modeText}\nScanning **${channelsToScan.size}** channels${skippedLogNote} (full history). **ETA: at least ~${timeString}, likely longer.**`);

                    // 2. Security Audit Logic
                    for (const [id, member] of allMembers) {
                        if (member.user.bot || member.id === guild.ownerId) continue;
                        const accountAge = Date.now() - member.user.createdTimestamp;
                        const ageInDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));

                        if (isDebug && auditLog.debugAges.length < 10) {
                            auditLog.debugAges.push(`${member.user.username}: ${ageInDays}d`);
                        }

                        if (accountAge < ONE_WEEK_MS) {
                            if (isDryRun) {
                                auditLog.flagged.push(`${member.user.tag} (${ageInDays}d)`);
                            } else if (runAudit) {
                                try {
                                    await member.send(`🛡️ **OsQarek's Universe: Security Audit**\nYour account is only ${ageInDays} days old. We require 7 days.`).catch(() => { });
                                    await member.kick(`Retroactive Audit: Account age (${ageInDays}d) < 7d`);
                                    auditLog.kicked++;
                                } catch (err) {
                                    auditLog.failed++;
                                }
                            }
                        }
                    }

                    // 3. Staff Message Sync (Updated to use lastMonday)
                    const staffIds = allMembers.filter(m =>
                        m.roles.cache.has('826829037136510986') ||
                        m.roles.cache.has('772558550555295794') ||
                        m.roles.cache.has('850513087399329823') ||
                        m.roles.cache.has('1511810524818440243') ||
                        m.roles.cache.has('771423764511981599')
                    ).map(m => m.id);

                    if (!db.stats) db.stats = {};
                    staffIds.forEach(id => {
                        if (!db.stats[id]) db.stats[id] = { count: 0, allTime: 0 };
                        db.stats[id].count = 0;
                        db.stats[id].allTime = 0;
                    });

                    // Scan the FULL history of every channel (not just back to last Monday)
                    // so we can rebuild both the weekly count and a true all-time count in one pass.
                    let scannedCount = 0;
                    let allTimeScannedCount = 0;
                    let channelsDone = 0;
                    let pagesFetched = 0; // one "page" = one 100-message fetch call, our real progress unit
                    let lastProgressEditAt = Date.now();
                    let skippedChannels = [];

                    // Discord.js has no built-in timeout on message fetches. On hosts with flaky
                    // egress to Discord, a single fetch can stall forever with no error and no
                    // resolution — the await just hangs, which freezes the whole sync (this is
                    // exactly what "stuck at page X for 30 minutes with no movement" looks like).
                    // Race every fetch against a hard timeout so a stalled request can't block us.
                    const FETCH_TIMEOUT_MS = 20000;
                    const MAX_RETRIES_PER_PAGE = 3;

                    // Persist progress every CLUSTER_SIZE channels instead of a single db.save()
                    // at the very end. A full-history scan over many channels can run for minutes;
                    // saving only once at the end means a crash/restart mid-scan (host flakiness,
                    // Discord API hiccups, etc.) loses everything accumulated so far. Saving in
                    // clusters bounds how much work can be lost to at most one cluster's worth.
                    const CLUSTER_SIZE = 5;
                    let lastSaveError = null;
                    // Generic guard against calls that neither resolve nor reject — just hang.
                    // .catch() alone does NOT protect against this (it only handles rejections),
                    // which is exactly how this command has kept freezing partway through: any
                    // Discord/DB call that stalls silently blocks the `await` forever with no
                    // error to catch. Race everything network-facing against a hard timeout.
                    const withTimeout = (promise, ms, label) => {
                        // Swallow a late rejection from the real call after we've already timed
                        // out and moved on, so it doesn't surface as an unhandled rejection later.
                        promise.catch(() => { });
                        let timer;
                        const timeoutPromise = new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
                        });
                        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
                    };
                    const DB_SAVE_TIMEOUT_MS = 15000;
                    const EDIT_TIMEOUT_MS = 10000;

                    // cache: false is critical for large scans. Discord.js caches every fetched
                    // message in channel.messages.cache by default and never evicts it during
                    // this loop. Across ~900K messages that cache grows unbounded until GC
                    // thrashes (looks exactly like a freeze) or the process OOMs outright — we
                    // only need each page's data long enough to tally it, not to keep it around.
                    const fetchPageWithTimeout = (channel, before) =>
                        withTimeout(channel.messages.fetch({ limit: 100, before, cache: false }), FETCH_TIMEOUT_MS, `Fetch in #${channel.name}`);

                    // Posts a throttled progress + ETA update. Uses pagesFetched (not just completed
                    // channels) as the unit of progress, so a single channel with a huge history still
                    // produces visible movement instead of the message sitting still until it's done.
                    const postProgress = async ({ currentChannelName, force = false } = {}) => {
                        const now = Date.now();
                        if (!force && now - lastProgressEditAt < 5000) return;
                        lastProgressEditAt = now;

                        const elapsedSoFar = now - syncStartedAt;
                        const avgPerChannel = channelsDone > 0 ? elapsedSoFar / channelsDone : null;
                        const channelsRemaining = totalChannelsToScan - channelsDone;
                        const percent = Math.floor((channelsDone / totalChannelsToScan) * 100);

                        // Until we've finished at least one full channel we don't have a reliable
                        // per-channel average yet, so show "Calculating..." instead of a guess.
                        const etaLine = avgPerChannel === null
                            ? `**ETA remaining: Calculating...**`
                            : `**ETA remaining: ~${formatDuration(avgPerChannel * channelsRemaining)}**`;

                        const scanningLine = currentChannelName
                            ? `Currently scanning: **#${currentChannelName}** (page ${pagesFetched})\n`
                            : '';

                        try {
                            await withTimeout(
                                interaction.editReply(
                                    `🔍 **Syncing Universe System...** ${modeText}\n` +
                                    `Scanned **${channelsDone}/${totalChannelsToScan}** channels (${percent}%) — full history.\n` +
                                    scanningLine +
                                    `${etaLine}\n` +
                                    `💬 Staff messages found so far: **${allTimeScannedCount}** all-time / **${scannedCount}** this week.`
                                ),
                                EDIT_TIMEOUT_MS,
                                'Progress editReply'
                            );
                        } catch (editErr) {
                            // A stalled/failed progress update should never block the scan itself —
                            // log it and keep going; the next tick will just catch us up.
                            console.error(`⚠️ syncstats: progress editReply failed/stalled: ${editErr.message}`);
                        }
                    };

                    // --- CHECKPOINT / RESUME ---
                    // Every MESSAGE_CHECKPOINT messages scanned (across the whole sync, all
                    // authors — not just staff hits), pause and post a "Continue" button rather
                    // than blasting through a potentially huge full-history scan in one go. This
                    // gives staff a natural point to bail out or step away without losing work,
                    // and keeps a single sync from monopolizing the interaction/rate limits for
                    // an unbounded stretch. Progress is saved to the DB before pausing.
                    const MESSAGE_CHECKPOINT = 10000;
                    let totalMessagesProcessed = 0;
                    let nextCheckpoint = MESSAGE_CHECKPOINT;

                    const pauseForContinue = async () => {
                        try {
                            await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() at checkpoint');
                        } catch (saveErr) {
                            console.error("❌ syncstats: checkpoint save failed/stalled:", saveErr.message);
                        }

                        const continueId = `syncstats_continue_${interaction.id}_${nextCheckpoint}`;
                        const continueRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(continueId)
                                .setLabel('▶️ Continue Scan')
                                .setStyle(ButtonStyle.Primary)
                        );

                        let checkpointMsg;
                        try {
                            checkpointMsg = await withTimeout(
                                interaction.followUp({
                                    content:
                                        `⏸️ **Checkpoint reached — ${totalMessagesProcessed.toLocaleString()} messages scanned so far.**\n` +
                                        `Progress has been saved (**${allTimeScannedCount}** staff messages all-time / **${scannedCount}** this week found so far).\n` +
                                        `Click below to continue scanning.`,
                                    components: [continueRow]
                                }),
                                EDIT_TIMEOUT_MS,
                                'Checkpoint followUp'
                            );
                        } catch (followUpErr) {
                            // Couldn't post the checkpoint message at all — don't hang the whole
                            // scan waiting on a button nobody can see. Log it and keep scanning;
                            // progress up to this point is already saved above.
                            console.error(`⚠️ syncstats: checkpoint followUp failed/stalled, skipping this pause: ${followUpErr.message}`);
                            return;
                        }

                        try {
                            const clickInteraction = await checkpointMsg.awaitMessageComponent({
                                filter: (btn) => btn.user.id === interaction.user.id && btn.customId === continueId,
                                time: 24 * 60 * 60 * 1000 // 24h — give staff plenty of time to come back and click
                            });
                            await clickInteraction.update({
                                content: `▶️ **Resuming scan...** (${totalMessagesProcessed.toLocaleString()} messages scanned so far)`,
                                components: []
                            });
                        } catch (err) {
                            // No click received in time — stop the scan cleanly instead of hanging forever.
                            await checkpointMsg.edit({
                                content:
                                    `⏹️ **Scan paused and abandoned** — no continue click received in time.\n` +
                                    `Progress up to **${totalMessagesProcessed.toLocaleString()}** messages was saved; re-run \`/syncstats\` to continue rebuilding stats.`,
                                components: []
                            }).catch(() => { });
                            const abandonError = new Error('Sync paused and abandoned (no continue click received).');
                            abandonError.syncPausedAbandoned = true;
                            throw abandonError;
                        }
                    };

                    for (const [id, channel] of channelsToScan) {
                        let lastId = null;
                        let fetching = true;
                        let retriesLeft = MAX_RETRIES_PER_PAGE;
                        while (fetching) {
                            try {
                                const messages = await fetchPageWithTimeout(channel, lastId);
                                retriesLeft = MAX_RETRIES_PER_PAGE; // reset once a page actually succeeds
                                pagesFetched++;
                                if (messages.size === 0) break;
                                for (const msg of messages.values()) {
                                    totalMessagesProcessed++;
                                    if (staffIds.includes(msg.author.id)) {
                                        db.stats[msg.author.id].allTime++;
                                        allTimeScannedCount++;
                                        if (msg.createdTimestamp >= startTimestamp) {
                                            db.stats[msg.author.id].count++;
                                            scannedCount++;
                                        }
                                    }
                                }
                                lastId = messages.last()?.id;
                                if (messages.size < 100) fetching = false;
                            } catch (err) {
                                if (retriesLeft > 0) {
                                    retriesLeft--;
                                    console.error(`⚠️ syncstats: fetch failed in #${channel.name} (${retriesLeft} retries left): ${err.message}`);
                                    continue; // retry the same page
                                }
                                console.error(`❌ syncstats: giving up on #${channel.name} after repeated failures/timeouts: ${err.message}`);
                                skippedChannels.push(channel.name);
                                fetching = false;
                            }

                            // Progress ticks here too (throttled inside postProgress), so a single
                            // channel with thousands of pages still visibly updates while it works.
                            await postProgress({ currentChannelName: channel.name });

                            // Checkpoint: pause every MESSAGE_CHECKPOINT messages and wait for a
                            // continue click. A single page (100 messages) can never cross more
                            // than one checkpoint boundary, but loop just in case a checkpoint
                            // straddles a retry/skip.
                            while (totalMessagesProcessed >= nextCheckpoint) {
                                await pauseForContinue();
                                nextCheckpoint += MESSAGE_CHECKPOINT;
                            }
                        }

                        channelsDone++;

                        // Belt-and-suspenders: even with cache:false on the fetch itself, messages
                        // can still land in the cache via live gateway events firing in this
                        // channel while we're scanning it. Clear it once we're done with the
                        // channel so nothing lingers for the rest of the (possibly hours-long) scan.
                        channel.messages.cache.clear();

                        // Cluster save: persist whatever we've accumulated so far every
                        // CLUSTER_SIZE channels, rather than waiting for the entire scan to
                        // finish. Failures here are logged but don't abort the scan — we'll
                        // just retry on the next cluster boundary (or the final save below).
                        if (channelsDone % CLUSTER_SIZE === 0 || channelsDone === totalChannelsToScan) {
                            try {
                                await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() cluster save');
                                lastSaveError = null;
                                console.log(`💾 syncstats: persisted progress after ${channelsDone}/${totalChannelsToScan} channels (${allTimeScannedCount} all-time messages so far).`);
                            } catch (saveErr) {
                                lastSaveError = saveErr;
                                console.error(`❌ syncstats: cluster save failed/stalled at ${channelsDone}/${totalChannelsToScan} channels:`, saveErr.message);
                            }
                        }
                    }

                    await postProgress({ force: true });

                    // Final safety-net save in case the last cluster boundary didn't line up
                    // exactly with totalChannelsToScan, or the last cluster save failed.
                    try {
                        await withTimeout(db.save(), DB_SAVE_TIMEOUT_MS, 'db.save() final save');
                        lastSaveError = null;
                    } catch (saveErr) {
                        lastSaveError = saveErr;
                        console.error("❌ syncstats: final save failed/stalled:", saveErr.message);
                    }

                    // 4. Final Output Construction
                    // Updated text to reflect Monday
                    const elapsedMs = Date.now() - syncStartedAt;
                    const elapsedString = formatDuration(elapsedMs);

                    let finalReport = `✅ **Sync Complete!** (took **${elapsedString}**)\nFound **${scannedCount}** staff messages since **Monday, ${lastMonday.toDateString()}**.\n📚 Found **${allTimeScannedCount}** staff messages **all-time** (full channel history).\n🔎 Scanned **${totalMessagesProcessed.toLocaleString()}** messages total (all authors).\n👑 **Current Owner ID:** \`${guild.ownerId}\``;

                    if (skippedChannels.length > 0) {
                        finalReport += `\n⚠️ **Skipped ${skippedChannels.length} channel(s)** after repeated fetch timeouts (their all-time counts may be incomplete): \`${skippedChannels.join(', ')}\``;
                    }

                    if (lastSaveError) {
                        finalReport += `\n⚠️ **Warning:** the final database save failed (\`${lastSaveError.message}\`). Stats were persisted through the last successful cluster save, but the very latest counts may not be saved — consider re-running.`;
                    }

                    if (isDebug) {
                        finalReport += `\n⚙️ **Debug (Sample Ages):** \`${auditLog.debugAges.join(', ')}\``;
                    }

                    if (isDryRun) {
                        const list = auditLog.flagged.length > 0 ?
                            `\n🧪 **Dry Run:** Found **${auditLog.flagged.length}** accounts under 7 days: \`${auditLog.flagged.slice(0, 10).join(', ')}\`` :
                            "\n🧪 **Dry Run:** No underage accounts found.";
                        finalReport += list;
                    } else if (runAudit) {
                        finalReport += `\n🛡️ **Audit:** Kicked **${auditLog.kicked}** accounts. (Failed: ${auditLog.failed})`;
                    }

                    return await interaction.editReply(finalReport);

                } catch (error) {
                    if (error.syncPausedAbandoned) {
                        // Already reported to the user via the checkpoint message edit — no need
                        // to also overwrite the deferred reply with a scary "Sync Failed" message.
                        return;
                    }
                    console.error("SyncStats Error:", error);
                    return await interaction.editReply(`❌ **Sync Failed:** ${error.message}`);
                }
            }

            if (commandName === 'warn' && options.getSubcommand() === 'add') {
                if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
                const target = options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided.';
                const targetMember = target ? guild.members.cache.get(target.id) : null;

                if (target.id === user.id) return interaction.editReply("❌ You cannot warn yourself.");
                if (targetMember && targetMember.roles.cache.has('772558550555295794')) {
                    return interaction.editReply("❌ You cannot warn another staff member. Use `/strike` instead.");
                }

                const { action, caseId } = await applyEscalation(guild, target, targetMember, reason, user.tag);
                logAction(guild, `🛡️ Case #${caseId} | ${action}`, `**Target:** ${target.tag}\n**Moderator:** ${user.tag}\n**Reason:** ${reason}`, 0xFFCC00);
                return interaction.editReply(`✅ **${target.tag}** warned. Result: **${action}** (Case #${caseId})`);
            }

            if (commandName === 'mod') {
                if (db.moderationEnabled === false) return interaction.editReply('🚫 The Moderation module is currently disabled.');
                const subcommand = interaction.options.getSubcommand();
                const target = options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided.';
                const targetMember = target ? guild.members.cache.get(target.id) : null;

                switch (subcommand) {
                    case 'kick':
                        if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
                        const kickEvidence = options.getAttachment('evidence');
                        if (!kickEvidence) return interaction.editReply("❌ Evidence (an attachment) is required to use `/mod kick`.");

                        await logActionWithEvidence(
                            guild,
                            target,
                            '👢 Kick',
                            `**User:** ${target.tag}\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`,
                            0xFF4500,
                            '👢 You have been kicked',
                            `**Server:** ${guild.name}\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`,
                            kickEvidence
                        );

                        await targetMember.kick(reason);
                        return interaction.editReply(`👢 Kicked ${target.tag}.`);

                    case 'ban':
                        if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Admin+** to use this.");
                        await guild.members.ban(target, { reason: reason });
                        logAction(guild, '🔨 Ban', `**User:** ${target.tag}\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`, 0xFF0000);
                        return interaction.editReply(`🔨 Banned ${target.tag}.`);

                    case 'unban':
                        if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Admin+** to use this.");
                        const unbanId = options.getString('id');
                        await guild.members.unban(unbanId);
                        logAction(guild, '🔓 Unban', `**ID:** ${unbanId}\n**Moderator:** ${user.tag}`, 0x00FF00);
                        return interaction.editReply(`🔓 Unbanned ID: ${unbanId}.`);

                    case 'mute':
                        if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
                        const muteEvidence = options.getAttachment('evidence');
                        if (!muteEvidence) return interaction.editReply("❌ Evidence (an attachment) is required to use `/mod mute`.");

                        const minutes = options.getInteger('minutes');
                        await targetMember.timeout(minutes * 60 * 1000, reason);

                        await logActionWithEvidence(
                            guild,
                            target,
                            '🔇 Mute',
                            `**User:** ${target.tag}\n**Duration:** ${minutes}m\n**Moderator:** ${user.tag}\n**Reason:** ${reason}`,
                            0x808080,
                            '🔇 You have been muted',
                            `**Server:** ${guild.name}\n**Duration:** ${minutes} minutes\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`,
                            muteEvidence
                        );

                        return interaction.editReply(`🔇 Muted ${target.tag} for ${minutes} minutes.`);

                    case 'unmute':
                        if (!isTrial) return interaction.editReply("❌ You need **Trial Moderator+** to use this.");
                        await targetMember.timeout(null);
                        logAction(guild, '🔊 Unmute', `**User:** ${target.tag}\n**Moderator:** ${user.tag}`, 0x00FF00);
                        return interaction.editReply(`🔊 Removed timeout for ${target.tag}.`);

                    case 'softban':
                        if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Admin+** to use this.");
                        await guild.members.ban(target, { deleteMessageSeconds: 604800, reason: `Softban: ${reason}` });
                        await guild.members.unban(target);
                        logAction(guild, '☁️ Softban', `**User:** ${target.tag}\n**Reason:** ${reason}\n**Moderator:** ${user.tag}`, 0xFFFF00);
                        return interaction.editReply(`☁️ Softbanned ${target.tag} (Messages cleared).`);

                    case 'purge':
                        if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
                        const amount = options.getInteger('amount');

                        // Perform the deletion first
                        const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);

                        // Instead of editReply, send a new message and auto-delete it
                        if (deleted) {
                            await interaction.channel.send(`🧹 Purged **${deleted.size}** messages.`).then(msg => {
                                setTimeout(() => msg.delete().catch(() => { }), 5000);
                            });
                        }

                        logAction(guild, '🧹 Purge', `**Amount:** ${amount}\n**Channel:** ${interaction.channel.name}\n**Moderator:** ${user.tag}`, 0x3498DB);
                        break;

                    case 'lockdown':
                        if (!isAtLeastAdmin) return interaction.editReply("❌ You need **Admin+** to use this.");
                        const status = options.getBoolean('status');
                        await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: !status });
                        logAction(guild, status ? '🔒 Lockdown' : '🔓 Unlock', `**Channel:** ${interaction.channel.name}\n**Moderator:** ${user.tag}`, 0xE74C3C);
                        return interaction.editReply(status ? `🔒 Channel locked.` : `🔓 Channel unlocked.`);

                    case 'dm':
                        if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
                        const messageContent = options.getString('message');

                        // Create the Neon DM Embed
                        const dmEmbed = {
                            color: 0x2ECC71, // Neon Green matching your image
                            description: `### Message from OsQarek's Universe Staff Team\n\n${messageContent}` //
                        };

                        try {
                            await target.send({ embeds: [dmEmbed] });
                            // Log the DM action
                            logAction(guild, '📬 Staff DM Sent', `**Recipient:** ${target.tag}\n**Moderator:** ${user.tag}\n**Message:** ${messageContent}`, 0x2ECC71);
                            return interaction.editReply(`✅ DM successfully sent to **${target.tag}**.`);
                        } catch (e) {
                            return interaction.editReply(`❌ Could not DM **${target.tag}** (DMs closed or blocked).`);
                        }
                }
            }


            if (commandName === 'staffstats' && options.getSubcommand() === 'all') {
                if (db.staffToolsEnabled === false) return interaction.editReply('🚫 The Staff Tools module is currently disabled.');
                // 1. Permission Check
                const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
                // Use interaction.member to ensure it's defined
                const hasPerms = interaction.member.roles.cache.some(r => adminRoles.includes(r.id)) ||
                    interaction.member.permissions.has(PermissionFlagsBits.Administrator);

                if (!hasPerms) {
                    return interaction.editReply("❌ You do not have permission to view global staff stats.");
                }

                const requirements = [
                    { roleId: '771423764511981599', name: 'Owner', min: 0, promo: 100 },
                    { roleId: '1511810524818440243', name: 'Co-Owner', min: 0, promo: 100 },
                    { roleId: '850513944329191445', name: 'Head Administrator', min: 750, promo: 99999 },
                    { roleId: '850513087399329823', name: 'Administrator', min: 500, promo: 1250 },
                    { roleId: '801828933800296478', name: 'Head Moderator', min: 300, promo: 750 },
                    { roleId: '772558550555295794', name: 'Moderator', min: 175, promo: 500 },
                    { roleId: '826829037136510986', name: 'Trial Moderator', min: 100, promo: 400 }
                ];

                const statsEmbed = new EmbedBuilder()
                    .setTitle('📊 Global Staff Performance')
                    .setDescription('Loading stats...') // Placeholder for empty results
                    .setFooter({ text: 'Stats synced weekly starting every Monday' }) // Clarify the start day
                    .setColor(0x3498DB)
                    .setTimestamp();

                let description = "";
                const allMembers = await interaction.guild.members.fetch();

                // Loop through database stats
                for (const [userId, stats] of Object.entries(db.stats || {})) {
                    const staffMember = allMembers.get(userId);
                    if (!staffMember) continue;

                    // Find highest matching role
                    const req = requirements.find(r => staffMember.roles.cache.has(r.roleId));
                    if (!req) continue;

                    const msgCount = stats.count || 0;
                    const allTimeCount = stats.allTime || 0;

                    // Progress Calculations
                    const minPercent = req.min === 0 ? 100 : Math.min(Math.round((msgCount / req.min) * 100), 100);
                    const promoPercent = Math.min(Math.round((msgCount / req.promo) * 100), 100);

                    // Visual progress indicator (Optional but looks great)
                    const progressEmoji = minPercent >= 100 ? '✅' : '⚠️';

                    description += `${progressEmoji} **${staffMember.user.username}** (${req.name})\n`;
                    description += `💬 \`${msgCount}\` | 📚 All-Time: \`${allTimeCount}\` | 📉 Min: \`${minPercent}%\` | 🚀 Promo: \`${promoPercent}%\` \n\n`;
                }

                statsEmbed.setDescription(description || "No staff activity recorded since last Monday.");

                return interaction.editReply({ embeds: [statsEmbed] });
            }

            if (commandName === 'staffstats' && options.getSubcommand() === 'view') {
                const staffRoles = [
                    '826829037136510986', // Trial
                    '772558550555295794', // Mod
                    '801828933800296478', // Head Mod
                    '850513087399329823', // Admin
                    '850513944329191445', // Head Admin
                    '1511810524818440243', // Co-Owner
                    '771423764511981599'  // Owner
                ];

                const isStaff = interaction.member.roles.cache.some(r => staffRoles.includes(r.id));
                if (!isStaff) return interaction.editReply("❌ This command is for OsQarek's Universe Staff only.");

                try {
                    const targetMember = interaction.options.getMember('staff') || interaction.member;

                    if (!db.stats) db.stats = {};
                    const msgCount = db.stats[targetMember.id]?.count || 0;
                    const allTimeCount = db.stats[targetMember.id]?.allTime || 0;

                    const requirements = [
                        { roleId: '771423764511981599', name: 'Owner', min: 0, promo: 100 },
                        { roleId: '1511810524818440243', name: 'Co-Owner', min: 0, promo: 100 },
                        { roleId: '850513944329191445', name: 'Head Administrator', min: 750, promo: 99999 },
                        { roleId: '850513087399329823', name: 'Administrator', min: 500, promo: 1250 },
                        { roleId: '801828933800296478', name: 'Head Moderator', min: 300, promo: 750 },
                        { roleId: '772558550555295794', name: 'Moderator', min: 175, promo: 500 },
                        { roleId: '826829037136510986', name: 'Trial Moderator', min: 100, promo: 400 }
                    ];

                    const currentReq = requirements.find(r => targetMember.roles.cache.has(r.roleId)) || { name: 'Staff', min: 1, promo: 1 };

                    // Calculation logic
                    const minGoal = currentReq.min || 1;
                    const promoGoal = currentReq.promo || 1;
                    const minProgress = Math.min(((msgCount / minGoal) * 100), 100).toFixed(1);
                    const promoProgress = Math.min(((msgCount / promoGoal) * 100), 100).toFixed(1);

                    const embed = {
                        title: `📊 Weekly Stats: ${targetMember.user.username}`, // Using username for modern Discord compatibility
                        description: `Tracking activity for the current cycle.`,
                        color: msgCount >= currentReq.min ? 0x2ECC71 : 0xE74C3C,
                        fields: [
                            { name: '💬 Messages Sent (This Cycle)', value: `**${msgCount}**`, inline: true },
                            { name: '📚 All-Time Messages', value: `**${allTimeCount}**`, inline: true },
                            {
                                name: '📉 Weekly Minimum',
                                value: `${msgCount >= currentReq.min ? '✅' : '❌'} (${msgCount}/${minGoal}) — **${minProgress}%**`,
                                inline: true
                            },
                            {
                                name: '📈 Promotion Goal',
                                value: `${msgCount >= currentReq.promo ? '✅' : '❌'} (${msgCount}/${promoGoal}) — **${promoProgress}%**`,
                                inline: true
                            }
                        ],
                        footer: { text: `Rank: ${currentReq.name} | Cycle starts every Monday` },
                        timestamp: new Date()
                    };

                    return interaction.editReply({ embeds: [embed] });

                } catch (err) {
                    console.error("❌ StaffStats Error:", err);
                    return interaction.editReply(`❌ **Error:** Could not retrieve stats.`);
                }
            }
            if (commandName === 'messagereset' && isAtLeastAdmin) {
                // 1. Reset only the WEEKLY counts; all-time totals are preserved.
                if (!db.stats) db.stats = {};
                for (const id of Object.keys(db.stats)) {
                    db.stats[id].count = 0;
                }
                await db.save();

                // 2. Log the action with a timestamp for the audit trail
                // Using user.username for modern Discord compatibility
                logAction(guild, '♻️ Stats Reset', `All weekly message counts have been reset by ${interaction.user.username} (all-time totals untouched)`, 0xFF0000);

                // 3. Inform the admin with a clear confirmation message
                return interaction.editReply("✅ **Weekly message counts have been reset to 0 for all staff.**\n📅 The new tracking cycle has officially started.\n📚 All-time totals were not affected.");
            }
            if (commandName === 'staffstats' && options.getSubcommand() === 'leaderboard') {
                await interaction.deferReply();

                // 1. Aggregate Staff Actions (Matching your "type" and "moderator" fields)
                const staffActions = {};

                db.cases.forEach(c => {
                    const mod = c.moderator; // Your JSON uses "moderator" (name) not "moderatorId"
                    if (!mod || mod === "System") return;

                    if (!staffActions[mod]) {
                        staffActions[mod] = { warns: 0, kicks: 0, bans: 0, total: 0 };
                    }

                    // Matching your type format: "👢 KICK", "⚠️ WARN", etc.
                    const type = c.type.toUpperCase();
                    if (type.includes('WARN')) staffActions[mod].warns++;
                    if (type.includes('KICK')) staffActions[mod].kicks++;
                    if (type.includes('BAN')) staffActions[mod].bans++;

                    staffActions[mod].total++;
                });

                // 2. Sort Weekly Messages (Top 5)
                // Note: Since db.stats might use User IDs, keep the <@ID> format
                const topWeekly = Object.entries(db.stats || {})
                    .sort(([, a], [, b]) => (b.count || 0) - (a.count || 0))
                    .slice(0, 5)
                    .map(([id, stats], i) => `**${i + 1}.** <@${id}>: \`${stats.count || 0}\``)
                    .join('\n') || '*No message data recorded*';

                // 2b. Sort All-Time Messages (Top 5)
                const topAllTime = Object.entries(db.stats || {})
                    .sort(([, a], [, b]) => (b.allTime || 0) - (a.allTime || 0))
                    .slice(0, 5)
                    .map(([id, stats], i) => `**${i + 1}.** <@${id}>: \`${stats.allTime || 0}\``)
                    .join('\n') || '*No message data recorded*';

                // 3. Sort All-Time Actions
                const topMods = Object.entries(staffActions)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .slice(0, 5)
                    .map(([name, stats], i) => {
                        // Since "name" is a string like "cydo_15", we display it directly
                        return `**${i + 1}.** **${name}**: \`${stats.total}\` (W: ${stats.warns} | K: ${stats.kicks} | B: ${stats.bans})`;
                    })
                    .join('\n') || '*No moderation cases found*';

                // 4. Warnings (Most "offensive" users)
                const topWarns = Object.entries(db.notes || {})
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([id, count], i) => `**${i + 1}.** <@${id}>: \`${count}\` warnings`)
                    .join('\n') || '*Clear record across the board*';

                const embed = new EmbedBuilder()
                    .setTitle('📊 OsQarek’s Universe - Staff Leaderboard')
                    .setColor(0x2b2d31) // Modern Discord dark theme color
                    .addFields(
                        { name: '✉️ Top Weekly Activity', value: topWeekly, inline: false },
                        { name: '📚 Top All-Time Activity', value: topAllTime, inline: false },
                        { name: '🛡️ Top Moderators (Total Actions)', value: topMods, inline: false },
                        { name: '⚠️ User Watchlist (Most Warnings)', value: topWarns, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: `OsQarek's Universe • ${db.cases.length} Total Cases` });

                await interaction.editReply({ embeds: [embed] });
            }
            if (commandName === 'role' && isAtLeastAdmin) {
                const action = options.getString('action');
                const target = options.getMember('target');
                const role = options.getRole('role');

                if (role.position >= member.roles.highest.position) return interaction.editReply("❌ You cannot manage a role higher than yours.");

                if (action === 'add') {
                    await target.roles.add(role);
                    return interaction.editReply(`✅ Added **${role.name}** to ${target.user.tag}.`);
                } else {
                    await target.roles.remove(role);
                    return interaction.editReply(`✅ Removed **${role.name}** from ${target.user.tag}.`);
                }
            }
            if (commandName === 'clearall' && isAtLeastAdmin) {
                const position = channel.position;
                const newChannel = await channel.clone();
                await channel.delete();
                await newChannel.setPosition(position);
                await newChannel.send("☢️ **Channel Nuked.**");
                // No need to editReply because the old channel is gone!
            }
            if (commandName === 'reason' && isMod) {
                const c = db.cases.find(x => x.id === options.getInteger('id'));
                if (c) { c.reason = options.getString('new_reason'); await db.save(); return interaction.editReply("✅ Case updated."); }
            }

            // --- 5. MISC & UTILITY ---
            if (commandName === 'announce') {
                if (!isMod) return interaction.editReply("❌ You need **Moderator+** to use this.");
                const chan = options.getChannel('channel') || channel;
                chan.send({ embeds: [new EmbedBuilder().setDescription(options.getString('message')).setColor(0x3498DB)] });
                return interaction.editReply("✅ Announcement sent.");
            }
            if (commandName === 'globalannounce' && isAtLeastAdmin) {
                const announcement = options.getString('message');
                let successCount = 0;

                const announceEmbed = new EmbedBuilder()
                    .setTitle('📢 Server-Wide Announcement')
                    .setDescription(announcement)
                    .setColor(0xFF4500) //-- Bold orange
                    .setTimestamp();

                // -- 1. Get all text channels in THIS server
                const channels = guild.channels.cache.filter(c =>
                    c.isTextBased() &&
                    c.permissionsFor(client.user).has(PermissionFlagsBits.SendMessages)
                );

                await interaction.editReply(`📡 Attempting to send to ${channels.size} channels...`);

                // -- 2. Loop through and send
                for (const [id, chan] of channels) {
                    try {
                        await chan.send({ embeds: [announceEmbed] });
                        successCount++;
                        //-- Small delay to prevent hitting Discord's rate limits
                        await new Promise(res => setTimeout(res, 500));
                    } catch (e) {
                        console.error(`Could not send to ${chan.name}`);
                    }
                }

                return interaction.editReply(`✅ Finished! Sent to **${successCount}** channels.`);
            }
            // --- OWNER-ONLY STATUS COMMAND ---
            if (commandName === 'status') {
                // 1. Permission Check
                const adminRoles = ['850513087399329823', '771423764511981599', '1511810524818440243'];
                const hasPerms = member.roles.cache.some(r => adminRoles.includes(r.id)) || member.permissions.has(PermissionFlagsBits.Administrator);

                if (!hasPerms) {
                    return interaction.editReply("❌ You do not have permission to change the bot's status.");
                }

                const choice = options.getString('preset');

                // 2. Map the choice to the preset data
                const presets = {
                    'universe': { text: "OsQarek's Universe", type: ActivityType.Watching, presence: 'idle' },
                    'game': { text: "OsQarek's Universe Game on ROBLOX", type: ActivityType.Playing, presence: 'dnd' },
                    'help': { text: "for /help", type: ActivityType.Listening, presence: 'online' },
                    'expand': { text: "the Universe expand", type: ActivityType.Watching, presence: 'idle' }
                };

                const status = presets[choice];

                // 3. Apply the Status
                client.user.setPresence({
                    activities: [{ name: status.text, type: status.type }],
                    status: status.presence
                });

                // 4. Log the change
                if (db.modLogChannel) {
                    logAction(guild, '🔄 Status Updated', `**Admin:** ${user.tag}\n**New Status:** ${status.text}\n**Presence:** ${status.presence}`, 0x3498DB);
                }

                return interaction.editReply(`✅ Status manually set to: **${status.text}**`);
            }
            if (commandName === 'random') {
                const members = await guild.members.fetch();
                const rand = members.random();
                return interaction.editReply(`🎲 Random pick: ${rand}`);
            }

            if (commandName === 'afk') {
                const reason = options.getString('reason') || 'AFK';
                db.afk[user.id] = { reason: reason, timestamp: Date.now() };
                await db.save();

                if (member.manageable && !member.displayName.startsWith('[AFK] ')) {
                    member.setNickname(`[AFK] ${member.displayName}`).catch(() => { });
                }
                return interaction.editReply(`💤 I've set your AFK: **${reason}**`);
            }

            if (commandName === 'reminder') {
                const timeInput = options.getString('time');
                const task = options.getString('task');
                const date = dayjs(timeInput);

                if (!date.isValid() || date.isBefore(dayjs())) {
                    return interaction.editReply({
                        content: "❌ Invalid date/time. Please use `YYYY-MM-DD HH:mm`."
                    });
                }

                const endTimestamp = date.valueOf();
                db.reminders.push({
                    userId: user.id,
                    channelId: interaction.channelId,
                    task: task,
                    expiresAt: endTimestamp
                });
                await db.save();

                const embed = new EmbedBuilder()
                    .setTitle('⏰ Reminder Set')
                    .setDescription(`**Task:** ${task}`)
                    .addFields(
                        { name: 'Scheduled For', value: `<t:${Math.floor(endTimestamp / 1000)}:F>`, inline: false }
                    )
                    .setColor(0x00FF00);

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'loa' && options.getSubcommand() === 'request') {
            const durationInput = options.getString('duration');
            const reason = options.getString('reason') || 'No reason provided';
            const dateRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

                if (!dateRegex.test(durationInput)) {
                    return interaction.editReply({ content: "❌ **Invalid Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
                }

                const parts = durationInput.split(/[- :]/);
                const dateObj = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);

                if (isNaN(dateObj.getTime()) || dateObj < new Date()) {
                    return interaction.editReply({ content: "❌ **Invalid Date!** Must be in the future.", flags: MessageFlags.Ephemeral });
                }

                const startInput = options.getString('start'); // optional — preset a future start
                if (startInput) {
                    if (!dateRegex.test(startInput)) {
                        return interaction.editReply({ content: "❌ **Invalid Start Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
                    }
                    const startParts = startInput.split(/[- :]/);
                    const startDateObj = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);
                    if (isNaN(startDateObj.getTime())) {
                        return interaction.editReply({ content: "❌ **Invalid Start Date!**", flags: MessageFlags.Ephemeral });
                    }
                    if (startDateObj >= dateObj) {
                        return interaction.editReply({ content: "❌ **Start date must be before the end date.**", flags: MessageFlags.Ephemeral });
                    }
                }

                if (!db.loaChannel) return interaction.editReply("❌ LOA channel is not set up.");
                const loaChan = guild.channels.cache.get(db.loaChannel);

                const loaEmbed = new EmbedBuilder()
                    .setTitle('📂 New LOA Request')
                    .setColor(0xFFA500)
                    .addFields(
                        { name: 'Staff Member', value: `<@${user.id}>`, inline: true },
                        ...(startInput ? [{ name: 'Start Date/Time', value: `🕓 ${startInput}`, inline: true }] : []),
                        { name: 'End Date/Time', value: `📅 ${durationInput}`, inline: true },
                        { name: 'Reason', value: reason }
                    );

                const buttons = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`loa_approve_${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`loa_deny_${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
                );

                await loaChan.send({ embeds: [loaEmbed], components: [buttons] });
                return interaction.editReply(
                    startInput
                        ? `✅ Your LOA request has been submitted, preset to start \`${startInput}\`.`
                        : `✅ Your LOA request has been submitted.`
                );
            }

            if (commandName === 'loa' && options.getSubcommand() === 'list') {
                const entries = Object.entries(db.loa || {});
                if (entries.length === 0) return interaction.editReply({ content: "📋 No active staff LOAs." });

                const list = entries.map(([id, data]) => {
                    // 🛡️ FALLBACK: If duration or reason is missing, show a clean message
                    const duration = data.duration || "Not Recorded";
                    const reason = data.reason || "No reason provided";
                    const statusLine = data.status === 'Scheduled'
                        ? `🕓 **Scheduled** — starts <t:${data.startDate}:f>`
                        : `✅ **Active**`;

                    return `👤 <@${id}>\n${statusLine}\n⏳ **Ends:** ${duration}\n📄 **Reason:** ${reason}\n──────────────`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle('📋 Current Staff LOAs')
                    .setDescription(list)
                    .setColor(0x3498DB);

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'loa' && options.getSubcommand() === 'end') {
                const targetUser = options.getMember('staff') || member;
                const isSelf = targetUser.id === user.id;
                const roles = { admin: '850513087399329823', owner: '771423764511981599', coOwner: '1511810524818440243' };
                const hasManagementPerms = member.roles.cache.has(roles.admin) || member.roles.cache.has(roles.owner) || member.roles.cache.has(roles.coOwner) || member.permissions.has(PermissionFlagsBits.Administrator);

                if (!isSelf && !hasManagementPerms) return interaction.editReply("❌ Permission denied.");
                if (!db.loa[targetUser.id]) return interaction.editReply("❌ No active LOA found.");

                delete db.loa[targetUser.id];
                await db.save();
                if (typeof logAction === 'function') {
                    logAction(guild, '📂 LOA Ended', `**Staff:** ${targetUser.user.tag}\n**Ended By:** ${user.tag}`, 0x00FF00);
                }
                return interaction.editReply(`✅ Successfully ended the LOA for **${targetUser.user.tag}**.`);
            }

            if (commandName === 'loa' && options.getSubcommand() === 'adminset') {
    const hasManagementPerms = member.roles.cache.has('850513087399329823') || 
                               member.roles.cache.has('771423764511981599') || 
                               member.roles.cache.has('1511810524818440243') || 
                               member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasManagementPerms) return interaction.editReply({ content: "❌ Permission denied.", flags: MessageFlags.Ephemeral });

    const targetMember = options.getMember('user');
    if (!targetMember) return interaction.editReply({ content: "❌ Could not find that user.", flags: MessageFlags.Ephemeral });

    const durationInput = options.getString('duration');
    const startInput = options.getString('start'); // optional — YYYY-MM-DD HH:mm, preset a future LOA
    const reason = options.getString('reason') || 'No reason provided';
    const dateRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

    if (!dateRegex.test(durationInput)) {
        return interaction.editReply({ content: "❌ **Invalid Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
    }

    const parts = durationInput.split(/[- :]/);
    const dateObj = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);

    if (isNaN(dateObj.getTime()) || dateObj < new Date()) {
        return interaction.editReply({ content: "❌ **Invalid Date!** Must be in the future.", flags: MessageFlags.Ephemeral });
    }

    let startDateObj = new Date(); // defaults to "now" if no start given, same as old behavior
    if (startInput) {
        if (!dateRegex.test(startInput)) {
            return interaction.editReply({ content: "❌ **Invalid Start Format!** Use: `YYYY-MM-DD HH:mm`", flags: MessageFlags.Ephemeral });
        }
        const startParts = startInput.split(/[- :]/);
        startDateObj = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);

        if (isNaN(startDateObj.getTime())) {
            return interaction.editReply({ content: "❌ **Invalid Start Date!**", flags: MessageFlags.Ephemeral });
        }
        if (startDateObj >= dateObj) {
            return interaction.editReply({ content: "❌ **Start date must be before the end date.**", flags: MessageFlags.Ephemeral });
        }
    }

    const isScheduled = startDateObj > new Date();

    db.loa[targetMember.id] = {
        status: isScheduled ? 'Scheduled' : 'Approved',
        timestamp: Math.floor(Date.now() / 1000),
        startDate: Math.floor(startDateObj.getTime() / 1000),
        duration: durationInput,
        reason: reason
    };
    await db.save();

    if (typeof logAction === 'function') {
        logAction(
            guild,
            isScheduled ? '📂 LOA Pre-Scheduled' : '📂 LOA Admin Set',
            `**Staff:** ${targetMember.user.tag}\n${isScheduled ? `**Starts:** ${startInput}\n` : ''}**End Date:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`,
            0xFFA500
        );
    }

    // Let the staff member know their LOA was set on their behalf, rather than them finding out cold
    try {
        const dmMessage = isScheduled
            ? `📂 **LOA Scheduled:** An admin has pre-scheduled a Leave of Absence for you in **${guild.name}**.\n**Starts:** ${startInput}\n**Ends:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`
            : `📂 **LOA Set:** An admin has placed you on Leave of Absence in **${guild.name}**, effective immediately.\n**Ends:** ${durationInput}\n**Reason:** ${reason}\n**Set By:** ${user.tag}`;

        await targetMember.send(dmMessage);
    } catch (err) {
        console.log(`Could not DM ${targetMember.user.tag} about their admin-set LOA (DMs likely closed).`);
    }

    return interaction.editReply(
        isScheduled
            ? `✅ LOA has been **pre-scheduled** for **${targetMember.user.tag}**, starting \`${startInput}\` until \`${durationInput}\`.`
            : `✅ LOA has been set for **${targetMember.user.tag}** until \`${durationInput}\`.`
    );
}
            if (commandName === 'emoji-names') {
                const prefix = interaction.options.getString('prefix');
                const suffix = interaction.options.getString('suffix');
                const isRestoring = !prefix && !suffix;

                const members = await interaction.guild.members.fetch();
                const manageableMembers = members.filter(m => !m.user.bot && m.manageable);

                await interaction.editReply(`✨ *Emoji Name Started...** [Targeting ${manageableMembers.size} users]`);

                let count = 0;
                for (const member of manageableMembers.values()) {
                    try {
                        if (isRestoring) {
                            if (member.nickname) { await member.setNickname(null); count++; }
                        } else {
                            const newNick = `${prefix || ''} ${member.displayName} ${suffix || ''}`.trim();
                            if (newNick !== member.displayName && newNick.length <= 32) {
                                await member.setNickname(newNick);
                                count++;
                            }
                        }
                        await new Promise(r => setTimeout(r, 1500));
                    } catch (err) {
                        console.error(`Error: ${err.message}`);
                    }
                }
                await interaction.followUp(`✅ **Emoji Name Complete:** ${count} usernames updated.`);
            }
            if (commandName === 'nickname') {
                const target = interaction.options.getMember('target');
                const newName = interaction.options.getString('name');
                const shouldModerate = interaction.options.getBoolean('moderate') || false;
                const reason = interaction.options.getString('reason') || 'No reason provided';

                if (!target.manageable) return await interaction.editReply("❌ I don't have permission to modify that user.");

                let finalName = newName;
                const modTag = `ModeratedNickname#${target.id.slice(-4)}`;
                if (shouldModerate) finalName = modTag;

                try {
                    // 1. Send DM to the User (if moderated)
                    if (shouldModerate) {
                        const userEmbed = new EmbedBuilder()
                            .setTitle('🛡️ Nickname Moderated')
                            .setDescription(`Your nickname in **${interaction.guild.name}** was updated to meet server standards.`)
                            .addFields(
                                { name: 'New Nickname', value: `\`${modTag}\``, inline: true },
                                { name: 'Reason', value: reason, inline: true }
                            )
                            .setColor(0xFF0000)
                            .setTimestamp();

                        await target.send({ embeds: [userEmbed] }).catch(() => console.log("User DMs closed."));
                    }

                    // 2. Apply the Nickname Change
                    await target.setNickname(finalName);

                    // 3. Log to Mod-Logs
                    const logChannel = interaction.guild.channels.cache.get(db.modLogChannel);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('📝 Nickname Action')
                            .setColor(shouldModerate ? 0xFF0000 : 0x00FF00)
                            .addFields(
                                { name: 'Target', value: `${target.user.tag} (${target.id})`, inline: false },
                                { name: 'Moderator', value: `${interaction.user.tag}`, inline: false },
                                { name: 'Action', value: shouldModerate ? 'Manual Moderation' : 'Manual Rename', inline: true },
                                { name: 'New Name', value: `\`${finalName || 'Reset to Default'}\``, inline: true },
                                { name: 'Reason', value: reason, inline: false }
                            )
                            .setTimestamp();

                        await logChannel.send({ embeds: [logEmbed] });
                    }

                    await interaction.editReply(`✅ **${target.user.tag}** has been updated.`);

                } catch (err) {
                    await interaction.editReply(`❌ Error: ${err.message}`);
                }
            }
            if (commandName === 'ban-prank') {
                // 1. Get the target from options
                const target = interaction.options.getMember('target');
                if (!target) return interaction.editReply("❌ User not found in the Universe.");

                // 2. Create the scary "Ban" Embed
                const fakeBanEmbed = new EmbedBuilder()
                    .setTitle('🔨 User Permanently Banned')
                    .setDescription(`User **${target.user.tag}** (ID: ${target.id}) has been removed from OsQarek’s Universe.`)
                    .addFields(
                        { name: 'Reason', value: '`Breaking Rule #1: Excessive awesomeness.`' },
                        { name: 'Moderator', value: `${interaction.user.tag}` }
                    )
                    .setColor(0xFF0000) // Scary Red
                    .setThumbnail(target.user.displayAvatarURL())
                    .setTimestamp();

                // 3. USE editReply (because it's already deferred)
                await interaction.editReply({ embeds: [fakeBanEmbed] });

                // 4. Wait 5 seconds for the panic to set in, then follow up
                setTimeout(async () => {
                    try {
                        await interaction.followUp({
                            content: `🤡 **APRIL FOOLS!** Gotcha, ${target}! You aren't actually banned.`,
                            ephemeral: false
                        });
                    } catch (err) {
                        console.error("Failed to send prank reveal:", err);
                    }
                }, 5000);
            }
            if (commandName === 'keyboard-fix') {
                // 1. Start the "Fix" process
                await interaction.editReply("🛠️ **Scanning keyboard drivers...** `[24%]`");

                // 2. Wait 2 seconds for a "Realistic" feel
                setTimeout(async () => {
                    try {
                        // 3. The Prank Reveal
                        await interaction.editReply({
                            content: "⚠️ **CRITICAL ERROR:** Your device has detected a keyboard malfunction. PLeasE rEStArt yOUr sYStEm tO FIx tHE tYpInG iSSuE. 🤡 **APRIL FOOLS!** Your keyboard is fine.",
                            ephemeral: true
                        });
                    } catch (err) {
                        console.error("Keyboard fix prank failed:", err);
                    }
                }, 2500);
            }
            if (commandName === 'nuke-server') {
                // 🛡️ Define permissions inside the block
                const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

                if (!isAdmin) return interaction.editReply({ content: "❌ Permission Denied. Only the Chairman can initiate a wipe.", ephemeral: true });

                // 🧨 Use editReply because the interaction is already deferred!
                await interaction.editReply("🧨 **Initializing Server Wipe...** `[0%]`");

                const steps = [18, 42, 71, 89, 99];

                for (const percent of steps) {
                    await new Promise(r => setTimeout(r, 1200));
                    await interaction.editReply(`🧨 **Deleting Channels... [${percent}%]**\n\`Current Target: #${interaction.channel.name}\``);
                }

                await new Promise(r => setTimeout(r, 2000));
                return interaction.editReply("🤡 **APRIL FOOLS!** No channels were harmed. Your server is safe...for now..");
            }
            if (commandName === 'reset-levels') {
                const target = interaction.options.getMember('target') || interaction.member;

                await interaction.editReply(`🗄️ **Database Syncing...** \`Connecting to <@437808476106784770>\OsQarek's Universe...\``);

                await new Promise(r => setTimeout(r, 2000));

                const errorEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Critical Database Error')
                    .setDescription(`Data corruption detected for user **${target.user.tag}**.`)
                    .addFields({ name: 'Action', value: '`Resetting XP and Level to 0...`' })
                    .setColor(0xFF0000)
                    .setFooter({ text: 'Error Code: 0x5950X_FOOL' });

                await interaction.editReply({ embeds: [errorEmbed] });

                setTimeout(() => {
                    interaction.followUp({ content: `🤡 **APRIL FOOLS!** Your levels are safe, ${target}. I wouldn't touch your XP!`, ephemeral: false });
                }, 6000);
            }
            if (commandName === 'nerd-mode') {
                const target = interaction.options.getMember('target');

                // 🛡️ Safety Check: Ensure the target actually exists
                if (!target) return interaction.editReply({ content: "❌ Target user not found in the Universe.", ephemeral: true });

                if (!db.nerds) db.nerds = [];

                // Toggle the Nerd status
                if (db.nerds.includes(target.id)) {
                    db.nerds = db.nerds.filter(id => id !== target.id);

                    // Hide the confirmation so the victim doesn't see you turned it off
                    await interaction.editReply({ content: `✅ **Actually...** Nerd Mode is now DISABLED for ${target.user.tag}.`, ephemeral: true });
                } else {
                    db.nerds.push(target.id);

                    // Hide the confirmation so the victim doesn't know who "Nerded" them
                    await interaction.editReply({ content: `🤓 **Actually...** Nerd Mode is now ENABLED for ${target.user.tag}.`, ephemeral: true });
                }

                // Save to your Mac Mini's DB
                await db.save();
            }
        } catch (err) {
            console.error(`❌ Command Error on /${interaction.commandName}:`, err);

            // If we already told Discord to wait (deferred) or already replied, we MUST use editReply
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: `❌ **Error:** ${err.message}`,
                    components: []
                }).catch((editErr) => {
                    // Previously this failure was swallowed silently, which is exactly
                    // what makes a broken command look like it's stuck on "thinking..."
                    // forever with zero clue why. Always log it now.
                    console.error(`❌ Also failed to deliver the error message for /${interaction.commandName}:`, editErr);
                });
            } else {
                // If the command crashed instantly before deferring
                await interaction.reply({
                    content: `❌ **Error:** ${err.message}`,
                    ephemeral: true
                }).catch((replyErr) => {
                    console.error(`❌ Also failed to send the fallback reply for /${interaction.commandName}:`, replyErr);
                });
            }
        }

        // SAFETY NET: if commandName didn't match any `if` block below — typically because
        // the command name registered with Discord doesn't match what this handler checks
        // for — nothing above ever calls editReply/followUp. Since the interaction was
        // already deferred earlier, that leaves it stuck on "is thinking..." until Discord's
        // 15-minute interaction token expires. Close that gap.
        // (interaction.replied is NOT used here — editReply() on a deferred reply never
        // sets it true, so checking it would fire a bogus warning after every normal command.)
        if (!KNOWN_COMMAND_NAMES.has(interaction.commandName)) {
            await interaction.editReply({
                content: `⚠️ \`/${interaction.commandName}\` was acknowledged but has no matching handler. This usually means the command name registered with Discord doesn't match any case checked here — check for a naming mismatch.`
            }).catch(() => { });
        }
    }
});


// --- CHAT LOGGING ---
client.on('messageDelete', async (msg) => {
    // ... (Your messageDelete logic)
    if (msg.partial) {
        try { await msg.fetch(); }
        catch (e) { return; }
    }
    if (!msg.guild || !db.chatLogChannel || msg.author?.bot) return;

    const isIgnored = db.ignoredChannels.some(id => String(id) === String(msg.channel.id));
    if (isIgnored) return;

    const logChan = msg.guild.channels.cache.get(db.chatLogChannel);
    if (!logChan) return;

    const embed = new EmbedBuilder()
        .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
        .setTitle('🗑️ Message Deleted')
        .setDescription(msg.content || "*No text content (likely an image)*")
        .addFields(
            { name: 'Channel', value: `<#${msg.channel.id}>`, inline: true },
            { name: 'User ID', value: `\`${msg.author.id}\``, inline: true }
        )
        .setColor(0xFF0000)
        .setTimestamp();

    logChan.send({ embeds: [embed] }).catch(() => { });
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
    // 1. Handle Partials
    if (oldMsg.partial) {
        try { await oldMsg.fetch(); }
        catch (e) { return; } // If we can't fetch it, we can't log it safely
    }

    // 2. Ignore: Bots, Missing DB, and Link Unfurls (The "3 times" fix)
    if (!newMsg.guild || !db.chatLogChannel || newMsg.author?.bot || oldMsg.content === newMsg.content) return;

    const isIgnored = db.ignoredChannels.some(id => String(id) === String(newMsg.channel.id));
    if (isIgnored) return;

    const logChan = newMsg.guild.channels.cache.get(db.chatLogChannel);
    if (!logChan) return;

    // 3. The "None" Fix: Provide a descriptive string if the cache is empty
    const oldContent = oldMsg.content || "*Original message not in cache (sent before bot restart)*";
    const newContent = newMsg.content || "*No content*";

    const embed = new EmbedBuilder()
        .setAuthor({ name: newMsg.author.tag, iconURL: newMsg.author.displayAvatarURL() })
        .setTitle('✏️ Message Edited')
        .addFields([ // Wrapped in [ ] to fix the Validator crash
            { name: 'Old', value: oldContent.slice(0, 1024) },
            { name: 'New', value: newContent.slice(0, 1024) },
            { name: 'Channel', value: `<#${newMsg.channel.id}>`, inline: true },
            { name: 'User ID', value: `\`${newMsg.author.id}\``, inline: true }
        ])
        .setColor(0xFFA500)
        .setTimestamp();

    // 4. The Jump Button
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('Jump to Message')
                .setStyle(ButtonStyle.Link)
                .setURL(newMsg.url)
        );

    logChan.send({ embeds: [embed], components: [row] }).catch(() => { });
});

// --- MESSAGE TRACKING & AUTO-MOD ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // --- SUGGESTION CHANNEL ---
    // Anything typed in this channel gets deleted and reposted as a suggestion
    // embed with vote/deny/staff-warn reactions, instead of using /suggest.
    if (process.env.SUGGEST_CHANNEL && message.channel.id === process.env.SUGGEST_CHANNEL) {
        if (!message.content?.trim() && message.attachments.size === 0) return;

        const suggestEmbed = createEmbed({
            description: message.content ? `**Suggestion:**\n${message.content}` : '**Suggestion:**',
            footer: 'Staff and members can vote below!',
            image: message.attachments.first()?.url,
        }).setAuthor({ name: `Suggestion from ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });

        try {
            await message.delete();
        } catch (err) {
            console.error('❌ Failed to delete suggestion message:', err.message);
        }

        try {
            const msg = await message.channel.send({ embeds: [suggestEmbed] });
            await msg.react('✅');
            await msg.react('❌');
            await msg.react('⚠️');

            if (!db.suggestions) db.suggestions = {};
            db.suggestions[msg.id] = { authorId: message.author.id, authorTag: message.author.tag };
            await db.save();
        } catch (err) {
            console.error('❌ Failed to post suggestion embed:', err.message);
        }

        return;
    }

    // 🤓 APRIL FOOLS: AI NERD MODE RESPONSE
    if (db.nerds?.includes(message.author.id)) {
        // 30% chance to trigger so it feels more "random" and less like a broken bot
        if (Math.random() < 0.3) {
            try {
                // PATCH: Passing "nerd" to trigger the pedantic persona in your Unified AI function
                const correction = await askAI(message.content, "nerd");

                message.reply(correction)
                    .then(msg => {
                        // Delete the evidence after 60 seconds
                        setTimeout(() => msg.delete().catch(() => { }), 60000);
                    })
                    .catch(err => console.error("Nerd Mode Reply Error:", err));
            } catch (error) {
                console.error("Nerd Mode AI Error:", error);
            }
        }
    }
    // END APRIL FOOLS

    // 1. Message Tracking
    if (!db.stats) db.stats = {};
    if (!db.stats[message.author.id]) db.stats[message.author.id] = { count: 0, allTime: 0 };
    db.stats[message.author.id].count++;
    db.stats[message.author.id].allTime = (db.stats[message.author.id].allTime || 0) + 1;
    if (db.stats[message.author.id].count % 10 === 0) queueSave();


    // 2. AFK System
    if (!db.afk) db.afk = {}; // PATCH: Safety initialization to prevent crash on fresh db

    // --- Part A: Returning from AFK ---
    if (db.afk[message.author.id]) {
        delete db.afk[message.author.id];
        await db.save();

        // Robust Nickname Restore
        if (message.member.manageable && message.member.displayName.startsWith('[AFK]')) {
            const newNick = message.member.displayName.replace(/^\[AFK\]\s*/i, '');
            message.member.setNickname(newNick === message.author.username ? null : newNick).catch(() => { });
        }

        message.channel.send(`👋 Welcome back ${message.author}! Your AFK has been removed.`)
            .then(m => setTimeout(() => m.delete().catch(() => { }), 5000));
    }

    // --- Part B: Mentioning an AFK User ---
    if (message.mentions.users.size > 0) {
        message.mentions.users.forEach(u => {
            const afkData = db.afk[u.id];
            if (afkData) {
                const timeAgo = (typeof dayjs !== 'undefined') ? dayjs(afkData.timestamp).fromNow() : "recently";
                message.reply(`💤 **${u.tag}** is currently AFK: ${afkData.reason} (${timeAgo})`)
                    .then(m => setTimeout(() => m.delete().catch(() => { }), 7000));
            }
        });
    }

    //// 3. Auto-Mod
    if (db.automodEnabled !== false) {
        const isIgnored = db.ignoredChannels?.some(id => String(id) === String(message.channel.id)) || false;
        const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

        if (!isIgnored && !isAdmin) {
            const fallbackWords = [...(db.bannedWords || [])];

            const result = await checkMessage(
                message.content,
                {
                    authorTag: message.author.tag,
                    authorId: message.author.id,
                    channelId: message.channel.id,
                },
                {
                    // Respects the bot's existing AI toggle — when it's off,
                    // checkMessage skips Hugging Face entirely and just runs
                    // the scam-pattern + fallbackWords checks below.
                    aiEnabled: db.aiEnabled !== false,
                    fallbackWords,
                    // Route self-harm alerts through the existing mod log
                    // channel instead of a separate webhook.
                    notifier: async ({ text, scores, meta }) => {
                        if (!db.modLogChannel) {
                            console.warn('Self-harm flag raised but no modLogChannel configured.');
                            return;
                        }
                        const logChannel = message.guild.channels.cache.get(db.modLogChannel);
                        if (!logChannel) return;

                        const alertEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Possible Self-Harm Risk Detected')
                            .setDescription(
                                `**User:** ${meta.authorTag} (${meta.authorId})\n` +
                                `**Channel:** <#${meta.channelId}>\n` +
                                `**Confidence:** ${((scores.suicide || 0) * 100).toFixed(0)}%\n\n` +
                                `**Message (left in place, NOT deleted):**\n${text}`
                            )
                            .setColor(0xE0AF68)
                            .setTimestamp();

                        await logChannel.send({ embeds: [alertEmbed] }).catch(() => {});
                    },
                }
            );

            if (result.action === 'delete') {
                await message.delete().catch(() => {});
                const { action, caseId } = await applyEscalation(
                    message.guild,
                    message.author,
                    message.member,
                    `Auto-Mod (${result.reason}${result.matchedWord ? `: ${result.matchedWord}` : ''})`,
                    'SYSTEM'
                );
                logAction(
                    message.guild,
                    `🚨 Auto-Mod | Case #${caseId}`,
                    `User: ${message.author.tag}\nReason: ${result.reason}\nAction: ${action}`,
                    0xFF0000
                );
            }
                        // result.action === 'alert_moderator' → the notifier above already
            // posted the alert. The message is intentionally left untouched.
        }
    } // end automodEnabled check
});

// --- SUGGESTION CHANNEL REACTIONS ---
// ⚠️ is staff-only: anyone else's ⚠️ reaction gets stripped immediately.
// When staff use it, it issues a real warning (via the same escalation ladder
// as /strike and auto-mod) against whoever posted the suggestion.
client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;
        if (!process.env.SUGGEST_CHANNEL) return;
        if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
        if (!reaction || reaction.message.channel.id !== process.env.SUGGEST_CHANNEL) return;
        if (reaction.emoji.name !== '⚠️') return;

        const guild = reaction.message.guild;
        if (!guild) return;

        const member = await guild.members.fetch(user.id).catch(() => null);

        if (!isStaffMember(member, guild)) {
            await reaction.users.remove(user.id).catch(() => {});
            return;
        }

        const suggestion = db.suggestions?.[reaction.message.id];
        if (!suggestion) {
            // No record of who posted this one (e.g. reacted on an old/legacy
            // suggestion) — leave the reaction as a manual flag only.
            return;
        }

        const targetMember = await guild.members.fetch(suggestion.authorId).catch(() => null);
        const targetUser = targetMember?.user || await client.users.fetch(suggestion.authorId).catch(() => null);
        if (!targetUser) return;

        const { action, caseId } = await applyEscalation(
            guild,
            targetUser,
            targetMember,
            'Suggestion flagged by staff (⚠️ reaction)',
            user.tag
        );

        logAction(
            guild,
            `⚠️ Suggestion Warned | Case #${caseId}`,
            `User: ${targetUser.tag}\nStaff: ${user.tag}\nAction: ${action}\nSuggestion: ${reaction.message.url}`,
            0xE0AF68
        );
    } catch (err) {
        console.error('❌ Suggestion reaction handler error:', err.message);
    }
});

// --- LOA AUTO-EXPIRY CHECKER ---
setInterval(async () => {
    const now = new Date();
    let changed = false;

    for (const userId in db.loa) {
        const loaData = db.loa[userId];

        // 🛡️ GUARD: Skip if the data is missing, not approved, or has no duration string
        if (!loaData || loaData.status !== 'Approved' || !loaData.duration) {
            continue;
        }

        try {
            const parts = loaData.duration.split(/[- :]/);

            // Ensure we actually have all date parts (Year, Month, Day, Hour, Minute)
            if (parts.length < 5) {
                console.log(`⚠️ Skipping malformed LOA duration for ${userId}: ${loaData.duration}`);
                continue;
            }

            const expiryDate = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);

            // Check if the date is actually valid before comparing
            if (isNaN(expiryDate.getTime())) continue;

            if (now >= expiryDate) {
                console.log(`⏰ LOA Expired for: ${userId}`);

                delete db.loa[userId];
                changed = true;

                const guild = client.guilds.cache.first();

                // 2. Send DM to the staff member
                try {
                    const targetUser = await client.users.fetch(userId).catch(() => null);
                    if (targetUser && guild) {
                        await targetUser.send(`📅 **LOA Ended:** Your Leave of Absence in **${guild.name}** has reached its end date. Welcome back!`).catch(() => { });
                    }
                } catch (err) {
                    console.log(`Could not DM user ${userId}.`);
                }

                // 3. Log to Mod Logs
                if (guild && db.modLogChannel && typeof logAction === 'function') {
                    logAction(guild, '📂 LOA Auto-Expired', `<@${userId}>'s Leave of Absence has reached its end date and was automatically removed.`, 0x00FF00);
                }
            }
        } catch (err) {
            console.error(`❌ Error processing LOA expiry for ${userId}:`, err);
        }
    }

    if (changed) await db.save();
}, 5000);

// --- LOA AUTO-ACTIVATION CHECKER (pre-scheduled LOAs) ---
setInterval(async () => {
    const now = new Date();
    let changed = false;

    for (const userId in db.loa) {
        const loaData = db.loa[userId];

        // Only care about entries waiting to start
        if (!loaData || loaData.status !== 'Scheduled' || !loaData.startDate) {
            continue;
        }

        try {
            const startDate = new Date(loaData.startDate * 1000);
            if (isNaN(startDate.getTime())) continue;

            if (now >= startDate) {
                console.log(`▶️ LOA activated (start date reached) for: ${userId}`);

                db.loa[userId].status = 'Approved';
                changed = true;

                const guild = client.guilds.cache.first();

                try {
                    const targetUser = await client.users.fetch(userId).catch(() => null);
                    if (targetUser && guild) {
                        await targetUser.send(`📅 **LOA Started:** Your pre-scheduled Leave of Absence in **${guild.name}** has now begun, until \`${loaData.duration}\`.`).catch(() => { });
                    }
                } catch (err) {
                    console.log(`Could not DM user ${userId} about LOA activation.`);
                }

                if (guild && db.modLogChannel && typeof logAction === 'function') {
                    logAction(guild, '📂 LOA Started', `<@${userId}>'s pre-scheduled Leave of Absence has begun (until \`${loaData.duration}\`).`, 0x3498DB);
                }
            }
        } catch (err) {
            console.error(`❌ Error processing LOA activation for ${userId}:`, err);
        }
    }

    if (changed) await db.save();
}, 5000);


// --- HUGGING FACE AI INTEGRATION ---
// NOTE: HF retired api-inference.huggingface.co in favor of
// router.huggingface.co ("Inference Providers"). The old HfInference
// class (v2.x) built URLs against the retired host, which is why you'd
// see ENOTFOUND for api-inference.huggingface.co in the logs. InferenceClient
// (v3+) targets the new router automatically.
const { InferenceClient } = require("@huggingface/inference");
const hf = process.env.HF_TOKEN ? new InferenceClient(process.env.HF_TOKEN) : null;

// --- UNIFIED AI FUNCTION ---
async function askAI(prompt, type = "default") {
    if (!hf) {
        return "❌ AI is not configured. Add HF_TOKEN to .env to enable AI responses.";
    }

    const systemPrompt = type === "nerd"
        ? "You are a pedantic, 'Well, actually' nerd. Briefly correct the user's message in a condescending but funny way. Start with '🤓 Actually...' and stay under 50 words."
        : "You are the official AI assistant for OsQarek's Universe. Be helpful, slightly mysterious, and use a dark neon aesthetic in your tone. Keep responses concise.";

    try {
        const response = await hf.chatCompletion({
            model: "Qwen/Qwen3.8-27B",
            provider: "featherless-ai",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            max_tokens: type === "nerd" ? 100 : 500,
            temperature: 0.7
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("HF AI Function Error:", error);
        if (error?.httpResponse?.body) {
            console.error("HF AI Function Error body:", JSON.stringify(error.httpResponse.body, null, 2));
        }
        return type === "nerd"
            ? "🤓 Actually, my connection to the Hugging Face API is currently recalibrating."
            : "❌ The connection to the stars was lost.";
    }
}

// --- DM MODMAIL RELAY ---
// If a user DMs the bot, forward the message to the mod log channel with a
// "Reply" button. Staff click Reply, type a response in the modal, and it
// gets sent back to the user's DMs. This repeats indefinitely in both directions.
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (db.modmailEnabled === false) return;
    if (message.guild) return; // Only handle DMs here

    if (!db.modLogChannel) {
        return message.reply("⚠️ Sorry, this server hasn't set up a relay channel yet. Staff won't see your message.").catch(() => {});
    }

    const relayChannel = client.channels.cache.get(db.modLogChannel) || await client.channels.fetch(db.modLogChannel).catch(() => null);
    if (!relayChannel) return;

    const dmEmbed = new EmbedBuilder()
        .setTitle('📨 New DM Received')
        .setDescription(message.content || '*[No text content]*')
        .addFields(
            { name: 'From', value: `${message.author.tag} (${message.author.id})`, inline: false }
        )
        .setColor(0x5865F2)
        .setThumbnail(message.author.displayAvatarURL())
        .setTimestamp();

    const files = message.attachments.size > 0
        ? [...message.attachments.values()].map(a => a.url)
        : [];

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`dmreply_${message.author.id}`)
            .setLabel('Reply')
            .setStyle(ButtonStyle.Primary)
    );

    try {
        await relayChannel.send({ embeds: [dmEmbed], files, components: [row] });
        await message.react('✅').catch(() => {});
    } catch (err) {
        console.error('❌ Failed to relay DM to staff:', err.message);
    }
});



client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return; // DMs are handled by the modmail relay above

    // 1. GLOBAL TOGGLE CHECK
    if (db.aiEnabled === false) return;

    // 2. CONTEXT CHECK (Mention only, since DMs are excluded above)
    const isMentioned = message.mentions.has(client.user);
    if (!isMentioned) return;

    const prompt = message.content.replace(`<@${client.user.id}>`, '').trim();
    if (!prompt) return message.reply("🌌 I'm listening. What's on your mind?");

    try {
        await message.channel.sendTyping();

        const response = await hf.chatCompletion({
            model: "Qwen/Qwen3.8-27B",
            provider: "featherless-ai",
            messages: [
                {
                    role: "system",
                    content: "You are the official AI assistant for OsQarek's Universe. Be helpful, slightly mysterious, and use a dark neon aesthetic in your tone. Keep responses concise."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        const aiText = response.choices[0].message.content;

        const aiEmbed = createEmbed({
            client,
            author: 'Universe AI',
            description: aiText.substring(0, 4096),
            footer: `OsQarek's Universe • Requested by ${message.author.tag}`,
        });

        await message.reply({ embeds: [aiEmbed] });

    } catch (error) {
        // Silently fail for 429 (quota) or 503 (loading) to keep logs clean
        if (error.message.includes('503')) {
            return message.reply("⏳ The cosmic engines are warming up. Try again in a few seconds!");
        }
        if (error.message.includes('429')) {
            return message.reply("⏳ The AI is currently at its limit. Please try again in a minute.");
        }

        console.error("HF AI Error:", error);
        await message.reply("❌ The connection to the stars was lost. Try again later.");
    }
});


// --- REMINDER CHECKER ---
setInterval(async () => {
    const now = Date.now();
    if (db.remindersEnabled === false) return;
    const dueReminders = db.reminders.filter(r => r.expiresAt <= now);

    if (dueReminders.length > 0) {
        // 1. Remove them from DB IMMEDIATELY to prevent double-reminding on lag
        db.reminders = db.reminders.filter(r => r.expiresAt > now);
        await db.save();

        for (const reminder of dueReminders) {
            try {
                const user = await client.users.fetch(reminder.userId).catch(() => null);
                if (user) {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('⏰ Reminder!')
                        .setDescription(`You asked me to remind you:\n> **${reminder.task}**`)
                        .setColor(0x00FF00)
                        .setTimestamp();

                    await user.send({ embeds: [dmEmbed] }).catch(async () => {
                        const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
                        if (channel) {
                            await channel.send(`⏰ <@${reminder.userId}>, your reminder: **${reminder.task}** (DMs closed)`).catch(() => { });
                        }
                    });
                }
            } catch (err) { console.error("❌ Reminder loop error:", err); }
        }
    }
}, 10000);

process.on('SIGINT', async () => {
    console.log("💾 SIGINT received. Syncing database...");
    
    // We call the async save and wait for it
    await db.save();
    
    console.log("💾 Database synced. Shutting down.");
    process.exit(0);
});

// -- WELCOME & GOODBYE MODULE ---
const sharp = require('sharp');
const Discord = require('discord.js'); // -- Dynamically ensures AttachmentBuilder is available safely

// 1. WELCOME FEATURE
client.on('guildMemberAdd', async (member) => {
    if (db.welcomeEnabled === false) return;
    const welcomeChannel = member.guild.channels.cache.get('771479661573832744');
    if (!welcomeChannel) return console.log("⚠️ Welcome channel not found.");

    try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });

        const response = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
        const avatarBuffer = Buffer.from(response.data);

        const invertedBuffer = await sharp(avatarBuffer)
            .negate({ alpha: false })
            .png()
            .toBuffer();

        // Safe reference through the local Discord instance
        const attachment = new Discord.AttachmentBuilder(invertedBuffer, { name: 'inverted-avatar.png' });

        await welcomeChannel.send({
            content: `👋 <@${member.id}> has joined.`,
            files: [attachment]
        });

    } catch (error) {
        console.error(`❌ Welcome Feature Error: ${error.message}`);
        welcomeChannel.send({ content: `👋 <@${member.id}> has joined.` }).catch(() => {});
    }
});

// 2. GOODBYE FEATURE (API Fallback Engine)
client.on('guildMemberRemove', async (member) => {
    if (db.welcomeEnabled === false) return;
   // -- This log is placed at the absolute entry point to ensure visibility in your terminal
    console.log(`⚠️ DISPATCH: A leave packet was received for ID: ${member.id}`);
    
    const goodbyeChannel = member.guild.channels.cache.get('831254170900103248');
    if (!goodbyeChannel) {
        return console.log("❌ CRITICAL: Goodbye channel 831254170900103248 could not be resolved from cache.");
    }

    try {
     //   -- Force fetch the complete User structural profile from the Discord API 
      //  -- This guarantees we have the avatar even if the member was completely uncached
        const targetUser = await client.users.fetch(member.id, { force: true });
        console.log(`⚙️ API Fetch Success: Processing black & white avatar for ${targetUser.username}`);

        const avatarUrl = targetUser.displayAvatarURL({ extension: 'png', size: 256 });
        
        const response = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
        const avatarBuffer = Buffer.from(response.data);

        const bwBuffer = await sharp(avatarBuffer)
            .grayscale() 
            .png()
            .toBuffer();

        const attachment = new Discord.AttachmentBuilder(bwBuffer, { name: 'goodbye-avatar.png' });

        await goodbyeChannel.send({
            content: `👋 <@${targetUser.id}> has left.`,
            files: [attachment]
        });
        console.log(`✅ SUCCESS: Goodbye message sent for ${targetUser.username}`);

    } catch (error) {
        console.error(`❌ Goodbye Processing Error: ${error.message}`);
        
       // -- Rock-solid text-only fallback string
        goodbyeChannel.send({ content: `👋 <@${member.id}> has left.` }).catch((err) => {
            console.error("❌ Fatal network drop; fallback failed:", err.message);
        });
    }
});


// --- BOT STARTUP ---
(async () => {
    try {
        await setupPlayDL();
        console.log("🎧 Play-DL initialized.");

        if (!process.env.TOKEN) {
            console.error("❌ Startup aborted: process.env.TOKEN is missing/empty. Check Render's Environment tab.");
            return;
        }
        console.log(`🔑 Attempting Discord login... (token length: ${process.env.TOKEN.length})`);

        await client.login(process.env.TOKEN);
        console.log("🔑 client.login() resolved successfully.");
    } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        if (msg.includes('503') || msg.includes('Service Unavailable')) {
            console.error("⚠️ Discord API is down (503). Retrying is blocked by the outage.");
        } else {
            console.error("❌ Startup failed:", err);
        }
        // Optional: process.exit(1) if you want it to stop, 
        // or a setTimeout to retry once the API is back.
    }
})();
