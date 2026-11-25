// Help Center "Popular articles": stored in the database and editable from the dashboard (Features → Help Center).
//
// Until an admin edits something, the built-in articles below are used. The first save copies them into
// db.features.helpcenter.articles, after which that list is the single source of truth ("Reset to defaults" goes
// back). Each article: { id, c: category id, t: title, b: body (simple markup, see render()), hidden }.
//
// Body markup (so nothing an editor types can ever become raw HTML on the public page):
//   blank line          new paragraph          lines starting "- "      bullet list
//   lines starting "1." numbered list          **bold**                  [link text](/path or https://...)
//   {{bot}}             the bot's name
//
// Routes (admin rank, same gate as Settings → Support requests):
//   GET  /helpcenter                  list + editor
//   POST /helpcenter/save             create or update (hidden field "id" = update)
//   POST /helpcenter/:id/move         dir=up|down
//   POST /helpcenter/:id/toggle       show / hide
//   POST /helpcenter/:id/delete
//   POST /helpcenter/reset            back to the built-in articles
const crypto = require('crypto');
const { store } = require('./util');

const CATEGORIES = [
    { id: 'account', name: 'Account & Verification' },
    { id: 'mod', name: 'Moderation & Appeals' },
    { id: 'bot', name: 'Bot & Commands' },
    { id: 'staff', name: 'Staff Applications' },
    { id: 'privacy', name: 'Privacy & Data' },
    { id: 'feedback', name: 'Bugs & Feedback' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const MAX_ARTICLES = 40;
const MAX_TITLE = 120;
const MAX_BODY = 4000;

const DEFAULT_ARTICLES = [
    { id: 'a-verify', c: 'account', t: 'I can’t verify', b: `1. Make sure you’ve joined the server first.
2. Open the [verification page](/verify) and sign in with Discord.
3. Complete the CAPTCHA and tick the rules agreement, then submit.

If the CAPTCHA doesn’t show up, a privacy extension, ad blocker or VPN may be blocking it. Try turning it off for this page or using another browser. Still stuck? [Submit a request](/support/request) with a short description of what you see.` },
    { id: 'a-appeal', c: 'mod', t: 'I was warned, muted, kicked or banned and think it’s a mistake', b: `Submit a request (or DM the bot) and include your Discord username and what you think went wrong. Staff will review it. Automatic flags and actions can be wrong, and they’re not a final judgment about you. If you’re banned, use the [request form](/support/request) or DM the bot. See the [Terms](/terms#moderation) for how moderation works.` },
    { id: 'a-offline', c: 'bot', t: 'A command isn’t working or the bot is offline', b: `- Use **/help** to see what’s available, and check you have permission for the command.
- Wait a moment and try again. Discord can lag, and the bot restarts after updates.
- If the bot is down or the website says it’s in maintenance, that’s usually temporary. If it lasts, let staff know.` },
    { id: 'a-confessions', c: 'bot', t: 'How do confessions work?', b: `Confessions are posted publicly without your name, but they are not anonymous to staff, who can see the author so abuse can be handled. If a confession breaks the rules, report it to staff. More in the [Terms](/terms#confessions) and the [Privacy Policy](/privacy#collect).` },
    { id: 'a-dm', c: 'bot', t: 'How do I message staff through the bot?', b: `Send {{bot}} a direct message. It’s relayed privately to staff, who reply to you in your DMs. Keep your DMs open so you can get the reply.` },
    { id: 'a-apps', c: 'staff', t: 'How do staff applications work?', b: `You can apply for [moderator](/mod-apps/apply) or [co-owner](/apply-co-owner) when applications are open. The owners review them, and not every application gets a position. If you’ve been waiting a while or something looks broken, [submit a request](/support/request).` },
    { id: 'a-data', c: 'privacy', t: 'I want to see, correct or delete my data', b: `Submit a request and say what you need. We may ask you to confirm you control the Discord account first. Leaving the server doesn’t delete your data automatically, so you do need to ask. Some records, such as moderation history, may be kept for safety reasons. Details are in the [Privacy Policy](/privacy#rights).` },
    { id: 'a-bugs', c: 'feedback', t: 'I found a bug or have a suggestion', b: `The most useful reports say what you did, what you expected, what happened instead, and roughly when. If it’s a security problem, please use the [request form](/support/request) or DM the bot instead of posting it publicly.` },
];

// ---------- storage ----------
const defaults = () => JSON.parse(JSON.stringify(DEFAULT_ARTICLES)).map((a) => ({ ...a, hidden: false }));

function getArticles(db) {
    const s = store(db, 'helpcenter', { articles: null });
    return Array.isArray(s.articles) ? s.articles : defaults();
}
// First edit copies the built-ins into the database, then edits that list.
function editableArticles(db) {
    const s = store(db, 'helpcenter', { articles: null });
    if (!Array.isArray(s.articles)) s.articles = defaults();
    return s.articles;
}

// ---------- rendering ----------
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const SAFE_URL = /^(\/(?!\/)|https?:\/\/|mailto:)/i;

function inline(text) {
    return esc(text)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
            if (!SAFE_URL.test(url)) return m;
            const external = /^https?:\/\//i.test(url);
            return `<a href="${url}"${external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${label}</a>`;
        });
}

// Simple markup → safe HTML. Everything is escaped before any tag is added.
function render(body) {
    const blocks = String(body || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((block) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.every((l) => /^[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
        if (lines.every((l) => /^\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
        return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
}

// What the public /support page gets: visible articles only, bodies already rendered.
function articlesForSite(db) {
    return getArticles(db).filter((a) => !a.hidden).map((a) => ({ c: a.c, t: a.t, b: render(a.b) }));
}

// ---------- validation ----------
const clean = (v, max) => String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

function validate(body) {
    const errors = [];
    const c = String(body.c || '');
    const t = clean(body.t, MAX_TITLE);
    const b = clean(body.b, MAX_BODY);
    if (!CATEGORY_IDS.has(c)) errors.push('Pick a category.');
    if (t.length < 3) errors.push('Give the article a title (at least 3 characters).');
    if (b.length < 10) errors.push('The article needs some text (at least 10 characters).');
    return { errors, article: { c, t, b } };
}

// ---------- dashboard routes ----------
function register(ctx) {
    const { app, checkAuth, renderDashboard, safeSave, isAdminRank } = ctx;
    const db = () => ctx.db;
    const guard = (req, res, next) => {
        if (typeof isAdminRank === 'function' && !isAdminRank(req.session?.user)) return res.status(403).send('<h1>403 Forbidden</h1><p>Access denied.</p>');
        next();
    };
    const go = (res, msg, extra = '') => res.redirect(`/helpcenter?${extra ? extra + '&' : ''}msg=${encodeURIComponent(msg)}`);
    const note = (req, text) => {
        try { ctx.logAction?.(ctx.client.guilds.cache.get(ctx.GUILD_ID), '📚 Help Center updated', `**By:** ${req.session?.user?.username || 'dashboard'}\n${text}`, 0x5865F2); } catch { /* logging is best effort */ }
    };

    app.get('/helpcenter', checkAuth, guard, async (req, res) => {
        const list = getArticles(db());
        const editing = req.query.edit ? list.find((a) => a.id === String(req.query.edit)) || null : null;
        await renderDashboard(req, res, 'fx-helpcenter', {
            activePage: 'fx-helpcenter',
            render: { fx: {
                msg: req.query.msg || '', esc,
                articles: list.map((a) => ({ ...a, html: render(a.b).replace(/\{\{bot\}\}/g, esc(ctx.client?.user?.username || 'the bot')) })),
                customised: Array.isArray(store(db(), 'helpcenter', { articles: null }).articles),
                cats: CATEGORIES, editing, max: { articles: MAX_ARTICLES, title: MAX_TITLE, body: MAX_BODY },
                errors: req.query.err ? String(req.query.err).split('||') : [],
            } },
        });
    });

    app.post('/helpcenter/save', checkAuth, guard, async (req, res) => {
        const { errors, article } = validate(req.body || {});
        const id = String(req.body.id || '');
        if (errors.length) return res.redirect(`/helpcenter?${id ? `edit=${encodeURIComponent(id)}&` : ''}err=${encodeURIComponent(errors.join('||'))}`);
        const list = editableArticles(db());
        if (id) {
            const a = list.find((x) => x.id === id);
            if (!a) return go(res, 'That article no longer exists.');
            Object.assign(a, article);
            await safeSave();
            note(req, `Edited article: ${a.t}`);
            return go(res, 'Article saved');
        }
        if (list.length >= MAX_ARTICLES) return go(res, `You can have at most ${MAX_ARTICLES} articles.`);
        list.push({ id: 'a' + crypto.randomBytes(4).toString('hex'), ...article, hidden: false });
        await safeSave();
        note(req, `Added article: ${article.t}`);
        go(res, 'Article added');
    });

    app.post('/helpcenter/reset', checkAuth, guard, async (req, res) => {
        store(db(), 'helpcenter', { articles: null }).articles = null;
        await safeSave();
        note(req, 'Reset popular articles to the built-in list');
        go(res, 'Reset to the built-in articles');
    });

    const withArticle = (handler) => async (req, res) => {
        const list = editableArticles(db());
        const i = list.findIndex((a) => a.id === req.params.id);
        if (i === -1) return go(res, 'That article no longer exists.');
        await handler(req, res, list, i);
    };
    app.post('/helpcenter/:id/move', checkAuth, guard, withArticle(async (req, res, list, i) => {
        const j = req.body.dir === 'up' ? i - 1 : req.body.dir === 'down' ? i + 1 : i;
        if (j >= 0 && j < list.length && j !== i) { [list[i], list[j]] = [list[j], list[i]]; await safeSave(); }
        go(res, 'Order updated');
    }));
    app.post('/helpcenter/:id/toggle', checkAuth, guard, withArticle(async (req, res, list, i) => {
        list[i].hidden = !list[i].hidden;
        await safeSave();
        note(req, `${list[i].hidden ? 'Hid' : 'Showed'} article: ${list[i].t}`);
        go(res, list[i].hidden ? 'Article hidden from the Help Center' : 'Article is visible again');
    }));
    app.post('/helpcenter/:id/delete', checkAuth, guard, withArticle(async (req, res, list, i) => {
        const [gone] = list.splice(i, 1);
        await safeSave();
        note(req, `Deleted article: ${gone.t}`);
        go(res, 'Article deleted');
    }));
}

module.exports = { register, render, getArticles, articlesForSite, validate, CATEGORIES, DEFAULT_ARTICLES };
