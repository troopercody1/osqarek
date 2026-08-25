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
        maintenanceWhitelist.push('/settings/bot-presence');
        maintenanceWhitelist.push('/settings/bot-presence/reset');
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
    if (req.session?.user && req.session.isHeadAdmin) return res.redirect(req.session.user?.id === 'admin' ? '/settings' : '/config');
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
        res.redirect('/config');
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
        activeTab: "infractions",  // ⭐ tells index.ejs which tab to open
        activePage: "infractions"
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
        activeTab: "infractions",  // ⭐ auto-open the correct tab
        activePage: "infractions"
    });
});

// --- DASHBOARD PAGES ---
// The dashboard used to be a single page ('/') with client-side JS tabs.
// It's now a set of real, bookmarkable/shareable routes that each render
// the same view with a different tab pre-opened server-side. Every route
// below shares this one render helper so the guild/member/stat fetching
// only lives in one place.
const DASHBOARD_TABS = {
    config: 'dashboard',
    modules: 'modules',
    infractions: 'infractions',
    'risk-manager': 'risk-manager',
    'reaction-roles': 'roles',
    'banned-words': 'banned-words',
    'system-logs': 'terminal',
};

async function renderDashboard(req, res, activeTab, overrides = {}) {
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
        activeTab,
        activePage: overrides.activePage || null,
        ...overrides.render,
    });
}

// Legacy root — sends anyone hitting '/' to the new Configuration page.
app.get('/', checkAuth, (req, res) => res.redirect('/config'));

app.get('/config', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS.config, { activePage: 'config' });
});

app.get('/modules', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS.modules, { activePage: 'modules' });
});

app.get('/infractions', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS.infractions, { activePage: 'infractions' });
});

app.get('/risk-manager', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS['risk-manager'], { activePage: 'risk-manager' });
});

app.get('/reaction-roles', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS['reaction-roles'], { activePage: 'reaction-roles' });
});

app.get('/banned-words', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS['banned-words'], { activePage: 'banned-words' });
});

app.get('/system-logs', checkAuth, async (req, res) => {
    await renderDashboard(req, res, DASHBOARD_TABS['system-logs'], { activePage: 'system-logs' });
});

app.post('/update-settings', checkAuth, async (req, res) => { db.settings = { prefix: req.body.prefix, welcomeChannel: req.body.welcomeChannel, goodbyeChannel: req.body.goodbyeChannel }; await safeSave(); res.redirect('/config'); });
app.post('/review-risk/:userId', checkAuth, async (req, res) => { if (!db.reviewedUsers) db.reviewedUsers = []; if (!db.reviewedUsers.includes(req.params.userId)) { db.reviewedUsers.push(req.params.userId); await safeSave(); } res.redirect('/risk-manager'); });
app.post('/add-reaction-role', checkAuth, async (req, res) => { if (!db.reactionRoles) db.reactionRoles = []; db.reactionRoles.push({ emoji: req.body.emoji, roleId: req.body.roleId, messageId: req.body.messageId }); await safeSave(); res.redirect('/reaction-roles'); });
app.post('/banned-words/add', checkAuth, async (req, res) => { if (!db.bannedWords) db.bannedWords = []; if (!db.bannedWords.includes(req.body.word)) { db.bannedWords.push(req.body.word); await safeSave(); } res.redirect('/banned-words'); });
app.post('/banned-words/remove', checkAuth, async (req, res) => { if (!db.bannedWords) db.bannedWords = []; db.bannedWords = db.bannedWords.filter(w => w !== req.body.word); await safeSave(); res.redirect('/banned-words'); });
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
    res.redirect("/infractions");
});
app.post('/remove-reaction-role/:index', checkAuth, async (req, res) => {
    const i = parseInt(req.params.index, 10);
    if (!isNaN(i) && db.reactionRoles && db.reactionRoles[i]) {
        db.reactionRoles.splice(i, 1);
    
    }
    res.redirect('/reaction-roles');
});

app.post('/edit-case/:index', checkAuth, async (req, res) => {
    const i = parseInt(req.params.index, 10);
    if (!isNaN(i) && db.cases && db.cases[i]) {
        db.cases[i].reason = req.body.reason || db.cases[i].reason;
    
    }
    res.redirect('/infractions');
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

    res.redirect('/modules');
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

app.post('/settings/bot-presence', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};

    const allowedStatuses = ['online', 'idle', 'dnd', 'invisible'];
    const allowedActivityTypes = ['Playing', 'Watching', 'Listening', 'Competing'];

    const status = allowedStatuses.includes(req.body.botPresenceStatus) ? req.body.botPresenceStatus : 'online';
    const activityTypeName = allowedActivityTypes.includes(req.body.botPresenceActivityType) ? req.body.botPresenceActivityType : 'Playing';
    const text = (req.body.botPresenceText || '').trim().slice(0, 128);

    if (!text) {
        return res.redirect('/settings?msg=Activity+text+is+required');
    }

    db.settings.botPresenceEnabled = true;
    db.settings.botPresenceStatus = status;
    db.settings.botPresenceActivityType = activityTypeName;
    db.settings.botPresenceText = text;
    await db.save();

    if (client?.user) {
        client.user.setPresence({
            activities: [{ name: text, type: ActivityType[activityTypeName] }],
            status
        });
    }

    const guild = client?.guilds?.cache.first();
    if (guild && db.modLogChannel) {
        logAction(guild, '🔄 Bot Presence Updated', `**Admin:** ${req.session.user?.username}\n**Activity:** ${activityTypeName} ${text}\n**Status:** ${status}`, 0x3498DB);
    }

    res.redirect('/settings?msg=Bot+presence+updated');
});

app.post('/settings/bot-presence/reset', async (req, res) => {
    if (req.session.user?.id !== 'admin') return res.status(403).send("Forbidden");
    if (!db.settings) db.settings = {};

    db.settings.botPresenceEnabled = false;
    delete db.settings.botPresenceStatus;
    delete db.settings.botPresenceActivityType;
    delete db.settings.botPresenceText;
    await db.save();

    res.redirect('/settings?msg=Reverted+to+rotating+status');
});

app.post('/delete-case/:id', checkAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!isNaN(id) && db.cases) {
        const before = db.cases.length;
        db.cases = db.cases.filter(c => c.id !== id);
        if (db.cases.length !== before) {
            await safeSave();
        }
    }
    res.redirect('/infractions');
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
        // Skip rotation if an admin has set a custom status/activity from the dashboard
        if (db.settings?.botPresenceEnabled) return;

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

    // If a custom presence was saved before restart, re-apply it immediately
    if (db.settings?.botPresenceEnabled && db.settings?.botPresenceText) {
        try {
            client.user.setPresence({
                activities: [{ name: db.settings.botPresenceText, type: ActivityType[db.settings.botPresenceActivityType] ?? ActivityType.Playing }],
                status: db.settings.botPresenceStatus || 'online'
            });
        } catch (err) {
            console.error("Failed to restore custom bot presence:", err);
        }
    }

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
                    logActionWithEvidence,
                    applyEscalation,
                    safeSave,
                    queueSave,
                    getCachedMembers,
                });
            }

            // --- 3. SYSTEM & ADMIN COMMANDS ---
            
            return interaction.editReply({ content: "❓ Unknown or unavailable command." }).catch(() => {});

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
