// Help Center threads: members reply to their own support requests from the website, staff reply
// from Settings → Support requests, and every request carries a status, a created date and a
// last-activity date.
//
// Statuses (stored in request.status):
//   open      Open                    staff still need to answer (new request, or the member replied)
//   awaiting  Awaiting your reply     staff answered, ball is in the member's court
//   solved    Solved                  closed. A member reply reopens it.
//
// Request shape (db.supportRequests[]):
//   { id, type, discord, discordId, avatar, email, subject, message, status, createdAt, updatedAt,
//     messages: [{ id, from: 'member' | 'staff' | 'system', name, body, at }] }
// Requests saved before threads existed are upgraded on first read (see normalize()).
//
// Member routes (Discord login from /support/login, only the request's owner gets in):
//   GET  /support/requests/:id            thread page
//   POST /support/requests/:id/reply      add a reply (reopens a solved request)
//   POST /support/requests/:id/solve      mark as solved
// Staff routes (admin rank, same gate as the Mailbox):
//   GET  /settings/support                all requests, filterable by status
//   GET  /settings/support/:id            thread + reply box
//   POST /settings/support/:id/reply      reply (optionally "and mark solved")
//   POST /settings/support/:id/status     set Open / Awaiting reply / Solved
const crypto = require('crypto');
const mailbox = require('./mail');

const ID_RE = /^SR-[0-9A-F]{6}$/;
const MAX_BODY = 3000;          // characters per message
const MAX_MESSAGES = 60;        // member + staff messages per request (system lines don't count)
const REPLY_LIMIT = 8;          // member replies ...
const REPLY_WINDOW = 10 * 60000; // ... per 10 minutes, per Discord account

const STATUS = {
    open:     { member: 'Open',                memberHint: 'Waiting for staff',         staff: 'Open' },
    awaiting: { member: 'Awaiting your reply', memberHint: 'Staff are waiting on you',  staff: 'Awaiting member' },
    solved:   { member: 'Solved',              memberHint: 'This request is closed',    staff: 'Solved' },
};
const LEGACY_STATUS = { progress: 'open', resolved: 'solved', closed: 'solved' };

const clean = (v, max) => String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);
const noPing = (v) => String(v).replace(/@/g, '@\u200b'); // user text must never ping anyone via webhook/DM
const newMsgId = () => 'm' + crypto.randomBytes(4).toString('hex');

const fullFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
const full = (ms) => fullFmt.format(new Date(ms)) + ' UTC';
function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return unit(m, 'minute');
    const h = Math.floor(m / 60); if (h < 24) return unit(h, 'hour');
    const d = Math.floor(h / 24); if (d < 30) return unit(d, 'day');
    if (d < 365) return unit(Math.floor(d / 30), 'month');
    return unit(Math.floor(d / 365), 'year');
}
const avatarUrl = (id, hash) => (id && hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.${String(hash).startsWith('a_') ? 'gif' : 'png'}?size=64` : null);

// Upgrades an older request in place: adds the thread, maps old statuses, fills updatedAt.
function normalize(r) {
    if (!Array.isArray(r.messages)) {
        r.messages = [{ id: 'm0', from: 'member', name: r.discord, body: r.message || '', at: r.createdAt }];
    }
    if (!STATUS[r.status]) r.status = LEGACY_STATUS[r.status] || 'open';
    if (!r.updatedAt) r.updatedAt = r.messages.length ? r.messages[r.messages.length - 1].at : r.createdAt;
    return r;
}
const countOpen = (list) => (list || []).filter((r) => normalize(r).status === 'open').length;

function registerRoutes(app, { getDb, getClient, isAdminRank, safeSave, sendDiscordWebhook, legalLocals, baseUrl }) {
    const requests = () => { const db = getDb(); if (!Array.isArray(db.supportRequests)) db.supportRequests = []; return db.supportRequests; };
    const find = (id) => { const r = ID_RE.test(String(id)) ? requests().find((x) => x.id === id) : null; return r ? normalize(r) : null; };
    const threadUrl = (r) => `${baseUrl}/support/requests/${r.id}`;
    const back = (res, path, msg, isErr) => res.redirect(`${path}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}`);
    const flash = (req) => ({ msg: clean(req.query.msg, 200) || null, err: clean(req.query.err, 200) || null });

    const addMessage = (r, from, name, body) => {
        const at = Date.now();
        r.messages.push({ id: newMsgId(), from, name, body, at });
        r.updatedAt = at;
    };
    const addEvent = (r, text) => addMessage(r, 'system', '', text);
    const setStatus = (r, status) => { r.status = status; r.updatedAt = Date.now(); };
    const realMessages = (r) => r.messages.filter((m) => m.from !== 'system').length;

    // ── Tell the member staff answered (Discord DM and/or email, whichever works) ──
    async function notifyMember(r, { title, text, solved }) {
        if (r.discordId) {
            try {
                const user = await getClient()?.users.fetch(r.discordId);
                await user?.send({ embeds: [{
                    title, color: solved ? 0x57F287 : 0x5865F2,
                    description: noPing(text).slice(0, 1500) + `\n\n[Open your request](${threadUrl(r)})`,
                    footer: { text: `${r.id} · ${r.subject}`.slice(0, 200) }, timestamp: new Date().toISOString(),
                }] });
            } catch { /* DMs closed: they still get the email, and the thread is on the site */ }
        }
        mailbox.sendRequesterReplyNotice(r, { body: text, solved, url: r.discordId ? threadUrl(r) : null }).catch(() => {});
    }
    // ── Tell staff the member wrote back ──
    function notifyStaff(r, body, reopened) {
        sendDiscordWebhook({
            title: `${reopened ? '🔁 Reopened' : '💬 New reply on'} ${r.id}`,
            message: noPing(`**${r.discord}** · ${r.subject}\n\n${body.slice(0, 1500)}`),
            color: reopened ? 0xFEE75C : 0x5865F2,
        }).catch(() => {});
        mailbox.sendStaffReplyNotice(r, body).catch(() => {});
    }

    // ════════════════════ MEMBER SIDE ════════════════════
    const _replyHits = new Map(); // discordId -> [timestamps]
    const rateLimited = (id) => {
        const now = Date.now();
        const hits = (_replyHits.get(id) || []).filter((t) => now - t < REPLY_WINDOW);
        if (hits.length >= REPLY_LIMIT) return true;
        hits.push(now); _replyHits.set(id, hits);
        return false;
    };
    // Only the Discord account that submitted the request may open it; anyone else gets a plain 404.
    const mine = (req, res) => {
        const member = req.session.supportMember;
        if (!member) { res.redirect('/support/login?next=/support/my-requests'); return null; }
        const r = find(req.params.id);
        if (!r || !r.discordId || r.discordId !== member.id) {
            res.status(404).send('<h1>404</h1><p>Request not found. <a href="/support/my-requests">My Help Requests</a></p>');
            return null;
        }
        return r;
    };

    app.get('/support/requests/:id', (req, res) => {
        const r = mine(req, res); if (!r) return;
        const member = req.session.supportMember;
        res.render('support-thread', {
            ...legalLocals(), member, r, STATUS, ago, full,
            memberAvatar: avatarUrl(member.id, member.avatar), ...flash(req),
            limits: { max: MAX_BODY },
        });
    });

    app.post('/support/requests/:id/reply', async (req, res) => {
        const r = mine(req, res); if (!r) return;
        const path = `/support/requests/${r.id}`;
        const member = req.session.supportMember;
        const body = clean(req.body.body, MAX_BODY);
        if (body.length < 2) return back(res, path, 'Write a reply before sending.', true);
        if (realMessages(r) >= MAX_MESSAGES) return back(res, path, 'This thread is full. Please submit a new request and mention this reference.', true);
        if (rateLimited(member.id)) return back(res, path, 'You are sending replies too quickly. Please wait a few minutes.', true);

        const reopened = r.status === 'solved';
        if (member.avatar) r.avatar = member.avatar;
        addMessage(r, 'member', member.username, body);
        if (reopened) addEvent(r, 'Request reopened by the requester');
        setStatus(r, 'open');
        await safeSave();
        notifyStaff(r, body, reopened);
        back(res, path, reopened ? 'Reply sent. Your request has been reopened.' : 'Reply sent.');
    });

    app.post('/support/requests/:id/solve', async (req, res) => {
        const r = mine(req, res); if (!r) return;
        const path = `/support/requests/${r.id}`;
        if (r.status !== 'solved') {
            addEvent(r, 'Marked as solved by the requester');
            setStatus(r, 'solved');
            await safeSave();
            sendDiscordWebhook({ title: `✅ Solved by requester ${r.id}`, message: noPing(`**${r.discord}** · ${r.subject}`), color: 0x57F287 }).catch(() => {});
        }
        back(res, path, 'Marked as solved. You can reply any time to reopen it.');
    });

    // ════════════════════ STAFF SIDE ════════════════════
    const guard = (req, res, next) => {
        if (!isAdminRank(req.session?.user)) return res.status(403).send('<h1>403 Forbidden</h1><p>Access denied.</p>');
        next();
    };
    const staffRender = (req, res, extra) => res.render('support-staff', {
        user: req.session.user, STATUS, ago, full, avatarUrl, view: 'list', list: [], counts: {}, filter: 'all', r: null,
        ...flash(req), ...extra,
    });

    app.get('/settings/support', guard, (req, res) => {
        const all = requests().map(normalize);
        const counts = { all: all.length, open: 0, awaiting: 0, solved: 0 };
        all.forEach((r) => { counts[r.status]++; });
        const filter = ['open', 'awaiting', 'solved'].includes(req.query.status) ? req.query.status : 'all';
        const q = clean(req.query.q, 100).toLowerCase();
        const list = all
            .filter((r) => filter === 'all' || r.status === filter)
            .filter((r) => !q || [r.id, r.subject, r.discord, r.email, r.type].some((v) => String(v || '').toLowerCase().includes(q)))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        staffRender(req, res, { view: 'list', list, counts, filter, q });
    });

    app.get('/settings/support/:id', guard, (req, res) => {
        const r = find(req.params.id);
        if (!r) return back(res, '/settings/support', 'That request was not found.', true);
        staffRender(req, res, { view: 'thread', r, max: MAX_BODY });
    });

    app.post('/settings/support/:id/reply', guard, async (req, res) => {
        const r = find(req.params.id);
        if (!r) return back(res, '/settings/support', 'That request was not found.', true);
        const path = `/settings/support/${r.id}`;
        const body = clean(req.body.body, MAX_BODY);
        if (!body) return back(res, path, 'Write a reply before sending.', true);
        if (realMessages(r) >= MAX_MESSAGES) return back(res, path, 'This thread has reached its message limit.', true);

        const solve = req.body.solve === '1';
        addMessage(r, 'staff', req.session.user.username || 'Staff', body); // members only ever see "Support Team"
        if (solve) addEvent(r, 'Marked as solved by support');
        setStatus(r, solve ? 'solved' : 'awaiting');
        await safeSave();
        console.log(`💬 [support] ${req.session.user.username} replied to ${r.id}${solve ? ' (solved)' : ''}`);
        notifyMember(r, { title: solve ? 'Your request was solved' : 'New reply to your request', text: body, solved: solve });
        back(res, path, solve ? 'Reply sent and request marked as solved.' : 'Reply sent. Status is now "Awaiting member".');
    });

    app.post('/settings/support/:id/status', guard, async (req, res) => {
        const r = find(req.params.id);
        if (!r) return back(res, '/settings/support', 'That request was not found.', true);
        const path = `/settings/support/${r.id}`;
        const next = String(req.body.status || '');
        if (!STATUS[next]) return back(res, path, 'Unknown status.', true);
        if (next !== r.status) {
            const wasSolved = r.status === 'solved';
            addEvent(r, `Status changed to ${STATUS[next].member} by support`);
            setStatus(r, next);
            await safeSave();
            if (next === 'solved') notifyMember(r, { title: 'Your request was solved', text: 'Support marked your request as solved. If you still need help, reply on the request page and it will reopen.', solved: true });
            else if (wasSolved) notifyMember(r, { title: 'Your request was reopened', text: 'Support reopened your request.', solved: false });
        }
        back(res, path, `Status set to ${STATUS[next].staff}.`);
    });
}

module.exports = { registerRoutes, normalize, countOpen, ago, full, avatarUrl, STATUS, MAX_BODY };
