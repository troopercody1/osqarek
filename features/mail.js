// Dashboard mailbox: read the inbox over IMAP and reply / compose over SMTP.
// Admin-only (same gate as /settings). Credentials come from environment
// variables only — they are never written to the database.
//
//   MAIL_USER        mailbox login (also the default From address)
//   MAIL_PASS        password / app password
//   MAIL_IMAP_HOST   e.g. imap.gmail.com        MAIL_IMAP_PORT (default 993, TLS)
//   MAIL_SMTP_HOST   e.g. smtp.gmail.com        MAIL_SMTP_PORT (default 465 = TLS, 587 = STARTTLS)
//   MAIL_FROM        optional From address      MAIL_FROM_NAME (default "OsQarek's Universe")
//   MAIL_ALERT_TO    optional recipient for status-change alerts (defaults to MAIL_USER)
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const PAGE_SIZE = 20;
const MAX_BODY = 20000;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const env = (k) => (process.env[k] || '').trim();

function isConfigured() {
    return !!(env('MAIL_USER') && env('MAIL_PASS') && env('MAIL_IMAP_HOST') && env('MAIL_SMTP_HOST'));
}

function newImap() {
    return new ImapFlow({
        host: env('MAIL_IMAP_HOST'),
        port: parseInt(env('MAIL_IMAP_PORT'), 10) || 993,
        secure: (parseInt(env('MAIL_IMAP_PORT'), 10) || 993) === 993,
        auth: { user: env('MAIL_USER'), pass: env('MAIL_PASS') },
        logger: false,
        socketTimeout: 20000,
    });
}

function smtp() {
    const port = parseInt(env('MAIL_SMTP_PORT'), 10) || 465;
    return nodemailer.createTransport({
        host: env('MAIL_SMTP_HOST'),
        port,
        secure: port === 465,
        auth: { user: env('MAIL_USER'), pass: env('MAIL_PASS') },
        connectionTimeout: 15000,
    });
}

const fromHeader = () => ({
    name: env('MAIL_FROM_NAME') || "OsQarek's Universe",
    address: env('MAIL_FROM') || env('MAIL_USER'),
});

// Opens INBOX, runs fn(client), always releases the lock and logs out.
async function withInbox(fn) {
    const client = newImap();
    client.on('error', (err) => console.error('📭 [mail] IMAP error:', err.message));
    await client.connect();
    let lock;
    try {
        lock = await client.getMailboxLock('INBOX');
        return await fn(client);
    } finally {
        if (lock) lock.release();
        try { await client.logout(); } catch { /* connection already gone */ }
    }
}

const addr = (list) => (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));
const label = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

async function listMessages({ page = 1, unreadOnly = false, q = '' } = {}) {
    return withInbox(async (client) => {
        let query = { all: true };
        if (unreadOnly) query = { seen: false };
        if (q) query = unreadOnly ? { seen: false, or: [{ subject: q }, { from: q }] } : { or: [{ subject: q }, { from: q }] };

        const found = (await client.search(query, { uid: true })) || [];
        found.sort((a, b) => b - a); // newest first
        const total = found.length;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const cur = Math.min(Math.max(1, page), pages);
        const slice = found.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

        const messages = [];
        if (slice.length) {
            for await (const m of client.fetch(slice.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
                messages.push({
                    uid: m.uid,
                    subject: m.envelope?.subject || '(no subject)',
                    from: label(m.envelope?.from?.[0]) || '(unknown)',
                    date: m.internalDate || m.envelope?.date || null,
                    seen: m.flags?.has('\\Seen') || false,
                    answered: m.flags?.has('\\Answered') || false,
                });
            }
            messages.sort((a, b) => b.uid - a.uid);
        }
        return { messages, total, page: cur, pages };
    });
}

async function getMessage(uid, { markRead = true } = {}) {
    return withInbox(async (client) => {
        const m = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!m || !m.source) return null;
        const p = await simpleParser(m.source);
        if (markRead && !m.flags?.has('\\Seen')) {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
        return {
            uid: Number(uid),
            subject: p.subject || '(no subject)',
            from: addr(p.from?.value),
            to: addr(p.to?.value),
            cc: addr(p.cc?.value),
            replyTo: addr(p.replyTo?.value),
            date: p.date || null,
            messageId: p.messageId || '',
            references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
            text: (p.text || '').slice(0, MAX_BODY),
            html: typeof p.html === 'string' ? p.html.slice(0, 200000) : '',
            attachments: (p.attachments || []).map((a) => ({ name: a.filename || 'attachment', size: a.size || 0, type: a.contentType })),
            seen: true,
        };
    });
}

async function setSeen(uid, seen) {
    return withInbox(async (client) => {
        if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    });
}

async function markAnswered(uid) {
    try {
        await withInbox((client) => client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }));
    } catch (err) {
        console.error('📭 [mail] could not flag as answered:', err.message);
    }
}

const quoteText = (m) =>
    `On ${m.date ? new Date(m.date).toUTCString() : 'an earlier date'}, ${label(m.from[0]) || 'the sender'} wrote:\n` +
    (m.text || '').split('\n').slice(0, 200).map((l) => `> ${l}`).join('\n');

// Reply to a stored message. Recipient/subject/threading come from the
// server-side copy of the original, never from the browser.
async function sendReply(uid, body) {
    const orig = await getMessage(uid, { markRead: false });
    if (!orig) throw new Error('That message no longer exists.');
    const to = (orig.replyTo[0] || orig.from[0] || {}).address;
    if (!to || !EMAIL_RE.test(to)) throw new Error('The original message has no valid sender address to reply to.');
    if (to.toLowerCase() === env('MAIL_USER').toLowerCase()) {
        throw new Error('This request has no email for the sender. Reply to them on Discord using the username in the message.');
    }

    const subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    const refs = [...orig.references, orig.messageId].filter(Boolean);
    await smtp().sendMail({
        from: fromHeader(),
        to,
        subject,
        text: `${body}\n\n${quoteText(orig)}`,
        inReplyTo: orig.messageId || undefined,
        references: refs.length ? refs : undefined,
    });
    await markAnswered(uid);
    return { to, subject };
}

async function sendNew({ to, subject, body }) {
    await smtp().sendMail({ from: fromHeader(), to, subject, text: body });
}

// Used by the maintenance / downtime-alert toggles in index.js.
async function sendStatusChangeEmail({ subject, title, message }) {
    const to = env('MAIL_ALERT_TO') || env('MAIL_USER');
    if (!isConfigured() || !to) {
        console.error('❌ Status email skipped: mailbox is not configured (see MAIL_* env vars).');
        return false;
    }
    try {
        await smtp().sendMail({ from: fromHeader(), to, subject: subject || title, text: `${title}\n\n${message}` });
        return true;
    } catch (err) {
        console.error('❌ Status email failed:', err.message);
        return false;
    }
}

// Delivers a help-center request into the staff inbox (shows up on Settings → Mailbox).
// Reply-To is the requester's email when they gave one, so "Reply" in the dashboard reaches them.
async function sendSupportRequestEmail(r) {
    const to = env('MAIL_ALERT_TO') || env('MAIL_USER');
    if (!isConfigured() || !to) return false;
    const one = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const lines = [
        `Reference: ${r.id}`,
        `Type: ${one(r.type)}`,
        `Discord: ${one(r.discord)}`,
        `Email: ${r.email ? one(r.email) : 'not given — reply to them on Discord (DM the user)'}`,
        '',
        r.message,
    ];
    try {
        await smtp().sendMail({
            from: fromHeader(),
            to,
            replyTo: r.email && EMAIL_RE.test(r.email) ? r.email : undefined,
            subject: `[Support ${r.id}] ${one(r.subject).slice(0, 120)}`,
            text: lines.join('\n'),
        });
        return true;
    } catch (err) {
        console.error('❌ Support request email failed:', err.message);
        return false;
    }
}

// Automatic receipt to the person who submitted the request (only when they gave an email).
// The summary only repeats what they typed, with the message shortened, and a global
// cap (30/hour) stops the form being used to push mail through the support account.
const _receipts = [];
async function sendRequesterConfirmation(r) {
    if (!isConfigured() || !r.email || !EMAIL_RE.test(r.email)) return false;
    const cutoff = Date.now() - 3600000;
    while (_receipts.length && _receipts[0] < cutoff) _receipts.shift();
    if (_receipts.length >= 30) return false;
    _receipts.push(Date.now());

    const one = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const name = env('MAIL_FROM_NAME') || "OsQarek's Universe";
    const msg = one(r.message);
    const excerpt = msg.length > 300 ? msg.slice(0, 300).trimEnd() + '…' : msg;
    const text = [
        `Hi ${one(r.discord)},`,
        '',
        `We've received your support request and a member of staff will get back to you.`,
        '',
        `Here's a summary of what you sent:`,
        `  Reference:  ${r.id}`,
        `  Type:       ${one(r.type)}`,
        `  Subject:    ${one(r.subject)}`,
        `  Discord:    ${one(r.discord)}`,
        `  Details:    ${excerpt}`,
        '',
        `Please keep your reference (${r.id}) if you contact us again. You can reply to this email to add more information.`,
        '',
        `If you didn't send this request, you can ignore this email.`,
        '',
        `${name} Support`,
        `This is an automated message.`,
    ].join('\n');
    try {
        await smtp().sendMail({
            from: fromHeader(),
            to: r.email,
            subject: `We received your request [${r.id}]`,
            text,
            headers: { 'Auto-Submitted': 'auto-replied' },
        });
        return true;
    } catch (err) {
        console.error('❌ Requester confirmation email failed:', err.message);
        return false;
    }
}

// ─── Express routes ──────────────────────────────────────────────────────────
// Every route is admin-only. State-changing routes are covered by the global
// CSRF middleware (forms carry `_csrf`).
function registerRoutes(app, { isAdminRank }) {
    const guard = (req, res, next) => {
        if (!isAdminRank(req.session?.user)) return res.status(403).send('<h1>403 Forbidden</h1><p>Access denied.</p>');
        next();
    };

    // Simple in-memory send throttle: 20 emails/hour for the whole dashboard.
    const sent = [];
    const throttled = () => {
        const cutoff = Date.now() - 3600000;
        while (sent.length && sent[0] < cutoff) sent.shift();
        if (sent.length >= 20) return true;
        sent.push(Date.now());
        return false;
    };

    const go = (res, path, msg, isErr) =>
        res.redirect(`${path}${path.includes('?') ? '&' : '?'}${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}`);

    const render = (req, res, view) =>
        res.render('mail', {
            configured: isConfigured(),
            mailUser: env('MAIL_USER'),
            user: req.session.user,
            msg: req.query.msg || null,
            err: req.query.err || null,
            view: 'list', thread: null, list: null, filters: { q: '', unread: false }, compose: null,
            ...view,
        });

    app.get('/settings/mail', guard, async (req, res) => {
        if (!isConfigured()) return render(req, res, {});
        const q = String(req.query.q || '').trim().slice(0, 100);
        const unread = req.query.unread === '1';
        try {
            const list = await listMessages({ page: parseInt(req.query.page, 10) || 1, unreadOnly: unread, q });
            render(req, res, { list, filters: { q, unread } });
        } catch (err) {
            console.error('📭 [mail] list failed:', err.message);
            render(req, res, { err: `Could not load the inbox: ${err.message}` });
        }
    });

    app.get('/settings/mail/compose', guard, (req, res) => {
        if (!isConfigured()) return res.redirect('/settings/mail');
        render(req, res, { view: 'compose', compose: { to: '', subject: '', body: '' } });
    });

    app.get('/settings/mail/:uid(\\d+)', guard, async (req, res) => {
        if (!isConfigured()) return res.redirect('/settings/mail');
        try {
            const thread = await getMessage(req.params.uid);
            if (!thread) return go(res, '/settings/mail', 'That message was not found.', true);
            render(req, res, { view: 'read', thread });
        } catch (err) {
            console.error('📭 [mail] read failed:', err.message);
            go(res, '/settings/mail', `Could not open message: ${err.message}`, true);
        }
    });

    app.post('/settings/mail/:uid(\\d+)/reply', guard, async (req, res) => {
        const back = `/settings/mail/${req.params.uid}`;
        const body = String(req.body.body || '').trim();
        if (!body) return go(res, back, 'Write something before sending.', true);
        if (body.length > MAX_BODY) return go(res, back, 'Reply is too long.', true);
        if (throttled()) return go(res, back, 'Send limit reached (20/hour). Try again later.', true);
        try {
            const r = await sendReply(req.params.uid, body);
            console.log(`📤 [mail] ${req.session.user.username} replied to ${r.to}`);
            go(res, back, `Reply sent to ${r.to}`);
        } catch (err) {
            console.error('📤 [mail] reply failed:', err.message);
            go(res, back, `Reply failed: ${err.message}`, true);
        }
    });

    app.post('/settings/mail/send', guard, async (req, res) => {
        const to = String(req.body.to || '').trim();
        const subject = String(req.body.subject || '').trim().slice(0, 200);
        const body = String(req.body.body || '').trim();
        const fail = (m) => render(req, res, { view: 'compose', compose: { to, subject, body }, err: m });
        if (!EMAIL_RE.test(to)) return fail('Enter one valid recipient address.');
        if (!subject) return fail('Add a subject.');
        if (!body) return fail('Write a message.');
        if (body.length > MAX_BODY) return fail('Message is too long.');
        if (throttled()) return fail('Send limit reached (20/hour). Try again later.');
        try {
            await sendNew({ to, subject, body });
            console.log(`📤 [mail] ${req.session.user.username} sent a message to ${to}`);
            go(res, '/settings/mail', `Message sent to ${to}`);
        } catch (err) {
            console.error('📤 [mail] send failed:', err.message);
            fail(`Send failed: ${err.message}`);
        }
    });

    app.post('/settings/mail/:uid(\\d+)/toggle-read', guard, async (req, res) => {
        try {
            await setSeen(req.params.uid, req.body.seen === '1');
            go(res, '/settings/mail', req.body.seen === '1' ? 'Marked as read' : 'Marked as unread');
        } catch (err) {
            go(res, '/settings/mail', `Could not update message: ${err.message}`, true);
        }
    });
}

module.exports = { isConfigured, registerRoutes, sendStatusChangeEmail, sendSupportRequestEmail, sendRequesterConfirmation };
