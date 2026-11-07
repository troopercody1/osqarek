// Dashboard pages for the feature bundle. All routes sit behind checkAuth.
const context = require('./context');
const actions = require('./actions');
const { FEATURES, FEATURE_NAMES, getConfig, applyForm, resetFeature } = require('./config');
const { searchCases, caseTime, userLabel } = require('./cases');
const { dayKey, isSnowflake } = require('./util');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline SVG bar chart (no external libraries).
function barChart(values, labels, { width = 640, height = 150, color = '#7aa2f7' } = {}) {
    const max = Math.max(...values, 1);
    const n = values.length;
    const gap = 2;
    const bw = Math.max(2, (width - gap * (n - 1)) / n);
    const pad = 18;
    const bars = values.map((v, i) => {
        const h = Math.round((v / max) * (height - pad));
        const x = i * (bw + gap);
        return `<rect x="${x.toFixed(1)}" y="${height - h}" width="${bw.toFixed(1)}" height="${h}" rx="2" fill="${color}"><title>${esc(labels[i])}: ${v}</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height + 14}" width="100%" role="img" style="max-width:${width}px">${bars}<text x="0" y="${height + 12}" font-size="10" fill="#565f89">${esc(labels[0] || '')}</text><text x="${width}" y="${height + 12}" font-size="10" fill="#565f89" text-anchor="end">${esc(labels[n - 1] || '')}</text><text x="${width}" y="10" font-size="10" fill="#565f89" text-anchor="end">max ${max}</text></svg>`;
}

function register(ctx, modules) {
    const { app, checkAuth, renderDashboard, safeSave, client, GUILD_ID } = ctx;
    const db = () => ctx.db;
    const who = (req) => req.session?.user?.username || req.session?.user?.id || 'dashboard';
    const back = (res, path, msg) => res.redirect(`${path}${msg ? `?msg=${encodeURIComponent(msg)}` : ''}`);
    const guild = () => client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();

    // Dashboard actor: a real Discord ID when logged in with Discord, otherwise the bot itself.
    const actorOf = (req) => {
        const u = req.session?.user;
        return { id: isSnowflake(String(u?.id)) ? String(u.id) : client.user?.id || 'dashboard', tag: `dashboard (${who(req)})` };
    };
    const lists = () => {
        const g = guild();
        return {
            channels: g ? g.channels.cache.filter((c) => c.isTextBased() && !c.isThread()).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) : [],
            roles: g ? g.roles.cache.filter((r) => r.id !== g.id && !r.managed).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)) : [],
        };
    };
    let lastScan = null; // last impersonation scan, shown on the Protection page
    const flash = (res, path, r, okMsg) => back(res, path, r.ok ? okMsg : `❌ ${r.error}`);

    const page = (req, res, tab, activePage, fx) =>
        renderDashboard(req, res, tab, { activePage, render: { fx: { msg: req.query.msg || '', esc, ...fx } } });

    // ---------- Features (per-feature settings) ----------
    app.get('/features', checkAuth, async (req, res) => {
        const g = guild();
        const channels = g ? g.channels.cache.filter((c) => c.isTextBased() && !c.isThread()).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
        const roles = g ? g.roles.cache.filter((r) => r.id !== g.id).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
        const forms = FEATURE_NAMES.map((name) => ({ name, def: FEATURES[name], cfg: getConfig(db(), name) }));
        await page(req, res, 'fx-features', 'fx-features', { forms, channels, roles, errors: req.query.err ? String(req.query.err).split('||') : [] });
    });
    app.post('/features/:name', checkAuth, async (req, res) => {
        const r = applyForm(db(), req.params.name, req.body || {});
        if (!r.ok) return res.redirect(`/features?err=${encodeURIComponent(r.errors.join('||'))}`);
        await safeSave();
        back(res, '/features', `${FEATURES[req.params.name].label} saved`);
    });
    app.post('/features/:name/reset', checkAuth, async (req, res) => {
        if (!FEATURES[req.params.name]) return res.status(404).send('Unknown feature');
        resetFeature(db(), req.params.name);
        await safeSave();
        back(res, '/features', 'Reset to defaults');
    });

    // ---------- Protection (raid / evasion / impersonation) ----------
    app.get('/protection', checkAuth, async (req, res) => {
        const raid = modules.raid.status();
        const ev = modules.evasion.data();
        const g = guild();
        const evCheck = req.query.evUser && /^\d{15,25}$/.test(String(req.query.evUser)) && g ? await modules.evasion.checkUser(g, String(req.query.evUser)) : null;
        const impTest = req.query.impName && g ? await modules.impersonation.testName(g, String(req.query.impName).slice(0, 100)) : null;
        const impSummary = g ? await modules.impersonation.protectedSummary(g) : { staffMembers: 0, custom: [] };
        await page(req, res, 'fx-protection', 'fx-protection', {
            evCheck, impTest, impSummary,
            lastScan: lastScan && { ...lastScan, hits: lastScan.hits.slice(0, 50).map(({ m, match }) => ({ tag: m.user.tag, id: m.id, field: match.field, name: match.name, label: match.protectedLabel, score: match.score })) },
            raidCfg: getConfig(db(), 'raid'), raid,
            evCfg: getConfig(db(), 'evasion'), flags: ev.flags.slice(0, 50), trackedBans: Object.keys(ev.banned).length,
            impCfg: getConfig(db(), 'impersonation'), impHits: modules.impersonation.data().hits.slice(0, 30),
        });
    });
    app.post('/protection/raid/:act', checkAuth, async (req, res) => {
        const g = guild();
        if (!g) return back(res, '/protection', 'Guild unavailable');
        if (req.params.act === 'start') { await modules.raid.startRaidMode(g, { manual: true, startedBy: `dashboard (${who(req)})` }); return back(res, '/protection', 'Raid mode on'); }
        if (req.params.act === 'end') { await modules.raid.endRaidMode(g, { by: `dashboard (${who(req)})` }); return back(res, '/protection', 'Raid mode off'); }
        res.status(400).send('Bad action');
    });
    app.post('/protection/evasion/:id/:act', checkAuth, async (req, res) => {
        const flag = modules.evasion.data().flags.find((f) => f.id === parseInt(req.params.id, 10));
        if (!flag || flag.status !== 'open') return back(res, '/protection', 'Flag not found or already handled');
        const act = req.params.act;
        if (act === 'dismiss') { flag.status = 'dismissed'; flag.handledBy = `dashboard (${who(req)})`; }
        else if (act === 'kick' || act === 'ban') {
            const r = await actions.applyAction({ guild: guild(), userId: flag.userId, action: act, reason: `Ban evasion (flag #${flag.id}) via dashboard`, caseType: act === 'ban' ? '🔨 EVASION BAN' : '👢 EVASION KICK', moderator: `dashboard (${who(req)})` });
            if (!r.ok) return back(res, '/protection', `Couldn't ${act}: ${r.error}`);
            flag.status = 'actioned'; flag.action = act; flag.handledBy = `dashboard (${who(req)})`;
        } else return res.status(400).send('Bad action');
        await safeSave();
        back(res, '/protection', `Flag #${flag.id} ${flag.status}`);
    });

    // ---------- Lockdown & Drills ----------
    // Long operations (posting to / locking every channel) run in the background so the request returns at once;
    // progress and the result show up on the page (and in the audit log).
    const plain = (text) => String(text || '')
        .replace(/<#(\d+)>/g, (_, id) => `#${guild()?.channels.cache.get(id)?.name || id}`)
        .replace(/<t:(\d+):[a-zA-Z]>/g, (_, n) => new Date(Number(n) * 1000).toLocaleString('en-GB'))
        .replace(/\*\*|__|(?<![\w])_(?=\S)|(?<=\S)_(?![\w])/g, '')
        .replace(/\*(?=\S)|(?<=\S)\*/g, '');
    const bg = (label, fn) => { Promise.resolve().then(fn).catch((err) => console.error(`❌ [dashboard] ${label} failed:`, err)); };
    const L = modules.lockdown;

    app.get('/lockdown', checkAuth, async (req, res) => {
        const g = guild();
        const st = L.status();
        const server = { ...st.server };
        if (server.drill) server.drill = { ...server.drill, messages: Object.keys(server.drill.messages || {}).length };
        delete server.saved;
        server.lockedCount = Object.keys(st.server.saved || {}).length;
        const lockedChannels = Object.entries(st.channels).map(([id, c]) => ({ id, name: g?.channels.cache.get(id)?.name || id, by: c.by, since: c.since, reason: c.reason }));
        const drills = Object.entries(L.DRILLS).map(([kind, d]) => ({
            kind, label: d.label, title: d.title,
            preview: plain(L.drillText(kind, Date.now() + L.DEFAULT_DRILL_MINUTES * 60000)).replace(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/, `${L.DEFAULT_DRILL_MINUTES} minutes after it starts (set below)`),
        }));
        const last = st.last && { ...st.last, text: st.last.text ? plain(st.last.text) : null };
        await page(req, res, 'fx-lockdown', 'fx-lockdown', {
            server, busy: st.busy, lockedChannels, drills, last,
            lockable: g ? L.lockableChannels(g).map((c) => ({ id: c.id, name: c.name })) : [],
            defaultMinutes: L.DEFAULT_DRILL_MINUTES, maxMinutes: L.MAX_DRILL_MINUTES,
        });
    });

    app.post('/lockdown/drill/end', checkAuth, async (req, res) => {
        const g = guild();
        const st = L.status();
        if (!g) return back(res, '/lockdown', 'Guild unavailable');
        if (!st.server.drill) return back(res, '/lockdown', 'No drill is running');
        if (st.busy) return back(res, '/lockdown', 'Another action is still running — try again shortly');
        bg('drill end', () => L.endDrill({ guild: g, by: actorOf(req).tag }));
        back(res, '/lockdown', 'Ending the drill — unlocking and deleting the notices in the background');
    });
    app.post('/lockdown/drill/:kind', checkAuth, async (req, res) => {
        const g = guild();
        const kind = req.params.kind;
        const st = L.status();
        if (!g) return back(res, '/lockdown', 'Guild unavailable');
        if (!L.DRILLS[kind]) return res.status(400).send('Unknown drill');
        if (st.busy) return back(res, '/lockdown', 'Another action is still running — try again shortly');
        if (st.server.active) return back(res, '/lockdown', st.server.drill ? 'A drill is already running' : 'The server is already locked down — unlock it first');
        const minutes = parseInt(req.body?.minutes, 10) || L.DEFAULT_DRILL_MINUTES;
        const actor = actorOf(req);
        bg('drill start', async () => {
            const u = isSnowflake(actor.id) && actor.id !== client.user?.id ? await client.users.fetch(actor.id).catch(() => null) : null;
            await L.startDrill({ guild: g, kind, minutes, actor: { tag: actor.tag }, dm: u });
        });
        back(res, '/lockdown', `${L.DRILLS[kind].label} starting — posting the notice and locking the server in the background. Refresh in a few seconds.`);
    });

    app.post('/lockdown/server/:act', checkAuth, async (req, res) => {
        const g = guild();
        const st = L.status();
        if (!g) return back(res, '/lockdown', 'Guild unavailable');
        if (st.busy) return back(res, '/lockdown', 'Another action is still running — try again shortly');
        const actor = actorOf(req).tag;
        if (req.params.act === 'lock') {
            if (st.server.active) return back(res, '/lockdown', st.server.drill ? 'A drill is running — end it first' : 'The server is already locked down');
            const reason = String(req.body?.reason || '').slice(0, 200) || null;
            bg('server lock', () => L.lockServer({ guild: g, actor, reason }));
            return back(res, '/lockdown', 'Locking the server in the background. Refresh in a few seconds.');
        }
        if (req.params.act === 'unlock') {
            if (!st.server.active) return back(res, '/lockdown', 'The server isn\'t locked down');
            bg('server unlock', () => L.unlockServer({ guild: g, actor }));
            return back(res, '/lockdown', 'Unlocking the server in the background. Refresh in a few seconds.');
        }
        res.status(400).send('Bad action');
    });

    app.post('/lockdown/channel/:act', checkAuth, async (req, res) => {
        const g = guild();
        const id = String(req.body?.channel || '');
        const channel = g && /^\d{15,25}$/.test(id) ? g.channels.cache.get(id) : null;
        if (!channel) return back(res, '/lockdown', 'Pick a channel');
        const actor = actorOf(req).tag;
        let r;
        if (req.params.act === 'lock') r = await L.lockChannel({ guild: g, channel, actor, reason: String(req.body?.reason || '').slice(0, 200) || null });
        else if (req.params.act === 'unlock') r = await L.unlockChannel({ guild: g, channel, actor });
        else return res.status(400).send('Bad action');
        back(res, '/lockdown', plain(r.msg).slice(0, 300));
    });

    // ---------- Case search ----------
    app.get('/cases', checkAuth, async (req, res) => {
        const q = req.query;
        const sinceMs = q.days ? Date.now() - Math.max(1, parseInt(q.days, 10) || 0) * 86400000 : null;
        const result = searchCases(db().cases, { userText: q.user, moderator: q.moderator, type: q.type, keyword: q.keyword, sinceMs, page: parseInt(q.page, 10) || 1, pageSize: 25 });
        const rows = result.items.map((c) => ({ id: c.id, type: c.type, user: userLabel(c).replace(/[<@>]/g, ''), userId: c.userId || (/^\d+$/.test(String(c.user)) ? c.user : null), moderator: c.moderator || '—', reason: c.reason || '—', at: caseTime(c) }));
        const qs = new URLSearchParams(Object.entries(q).filter(([k, v]) => k !== 'page' && v)).toString();
        await page(req, res, 'fx-cases', 'fx-cases', { q, result, rows, qs });
    });

    // ---------- Audit log ----------
    app.get('/audit', checkAuth, async (req, res) => {
        const q = req.query;
        const cfg = getConfig(db(), 'audit');
        const g = guild();
        let discord = { ok: false, entries: [], error: 'Guild unavailable.' };
        if (g && cfg.enabled) discord = await modules.audit.fetchEntries(g, { type: q.type, executorId: q.executor, targetId: q.target, limit: cfg.pageSize, before: q.before });
        const events = modules.audit.botEvents(db(), { type: q.botType, limit: 50 });
        const qs = new URLSearchParams(Object.entries(q).filter(([k, v]) => k !== 'before' && v)).toString();
        await page(req, res, 'fx-audit', 'fx-audit', { q, cfg, discord, events, filters: Object.keys(modules.audit.FILTERS), qs });
    });

    // ---------- Analytics ----------
    app.get('/analytics', checkAuth, async (req, res) => {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
        const r = modules.analytics.report(days);
        const labels = r.keys.map((k) => k.slice(5));
        const charts = {
            messages: barChart(r.messages, labels),
            joins: barChart(r.joins, labels, { color: '#9ece6a' }),
            leaves: barChart(r.leaves, labels, { color: '#f7768e' }),
            mod: barChart(r.modActions, labels, { color: '#e0af68' }),
            hourly: barChart(r.hourly, r.hourly.map((_, i) => modules.analytics.hourLabel(i)), { color: '#bb9af7' }),
        };
        const topChannels = r.topChannels.map((c) => ({ name: guild()?.channels.cache.get(c.id)?.name || c.id, count: c.count }));
        // Voice time stats (shown as a section on the Analytics page)
        const vr = modules.voice.report(days);
        const g = guild();
        const nameOf = (id) => g?.members.cache.get(id)?.displayName || id;
        const voice = {
            cfg: getConfig(db(), 'voice'), fmt: modules.voice.fmt,
            totalMs: vr.totalMs, uniqueUsers: vr.uniqueUsers, avgPerUser: vr.avgPerUser, liveNow: vr.liveNow, trackedDays: vr.trackedDays,
            chart: barChart(vr.perDay.map(modules.voice.hours), labels, { color: '#7dcfff' }),
            topUsers: vr.topUsers.map((u) => ({ name: nameOf(u.id), id: u.id, ms: u.ms })),
            topChannels: vr.topChannels.map((c) => ({ name: g?.channels.cache.get(c.id)?.name || c.id, ms: c.ms })),
            allTime: modules.voice.leaderboard(null, 10).map((u) => ({ name: nameOf(u.id), ms: u.ms })),
        };
        await page(req, res, 'fx-analytics', 'fx-analytics', { days, r, charts, topChannels, voice, cfg: getConfig(db(), 'analytics'), hourLabel: modules.analytics.hourLabel });
    });

    // ---------- Community: giveaways + polls ----------
    app.get('/community', checkAuth, async (req, res) => {
        await page(req, res, 'fx-community', 'fx-community', {
            ...lists(), cfgG: getConfig(db(), 'giveaways'), cfgP: getConfig(db(), 'polls'),
            giveaways: [...modules.giveaways.data().items].sort((a, b) => b.id - a.id).slice(0, 40),
            polls: [...modules.polls.data().items].sort((a, b) => b.id - a.id).slice(0, 40).map((p) => ({ ...p, tally: modules.polls.tally(p) })),
        });
    });
    app.post('/community/giveaway/:id/:act', checkAuth, async (req, res) => {
        const g = modules.giveaways.find(parseInt(req.params.id, 10));
        if (!g) return back(res, '/community', 'Giveaway not found');
        if (req.params.act === 'end') await modules.giveaways.endGiveaway(g, { by: `dashboard (${who(req)})` });
        else if (req.params.act === 'cancel') await modules.giveaways.cancelGiveaway(g, `dashboard (${who(req)})`);
        else if (req.params.act === 'reroll') { const r = await modules.giveaways.reroll(g, 1); if (r.error) return back(res, '/community', r.error); }
        else return res.status(400).send('Bad action');
        back(res, '/community', `Giveaway #${g.id}: ${req.params.act} done`);
    });
    app.post('/community/poll/:id/end', checkAuth, async (req, res) => {
        const p = modules.polls.find(parseInt(req.params.id, 10));
        if (!p) return back(res, '/community', 'Poll not found');
        await modules.polls.closePoll(p, { by: `dashboard (${who(req)})` });
        back(res, '/community', `Poll #${p.id} closed`);
    });

    // ---------- create / schedule from the dashboard ----------
    app.post('/community/giveaway/start', checkAuth, async (req, res) => {
        const b = req.body || {};
        const r = await modules.giveaways.startGiveaway(guild(), { prize: b.prize, when: b.duration, winners: parseInt(b.winners, 10) || 1, roleId: b.roleId || null, channelId: b.channelId, host: actorOf(req) });
        flash(res, '/community', r, r.ok ? `Giveaway #${r.g.id} started` : '');
    });
    app.post('/community/poll/create', checkAuth, async (req, res) => {
        const b = req.body || {};
        const g = guild();
        const channel = g?.channels.cache.get(b.channelId);
        if (!channel?.isTextBased()) return back(res, '/community', '❌ Pick a text channel.');
        const r = await modules.polls.createPoll({
            channel, question: b.question, optionsRaw: b.options, when: b.duration || null, multi: b.multi === 'on',
            anonymous: b.anonymity === 'default' || !b.anonymity ? null : b.anonymity === 'anonymous', by: actorOf(req),
            post: (payload) => channel.send(payload),
        });
        flash(res, '/community', r, r.ok ? `Poll #${r.p.id} posted` : '');
    });
    app.post('/timed/ban', checkAuth, async (req, res) => {
        const b = req.body || {};
        const r = await modules.timed.tempBan(guild(), { userId: String(b.userId || '').trim(), when: b.duration, reason: b.reason || undefined, deleteDays: Math.min(7, Math.max(0, parseInt(b.deleteDays, 10) || 0)), actor: actorOf(req) });
        flash(res, '/timed', r, r.ok ? `Banned ${r.target.tag}; unban scheduled (#${r.item.id})` : '');
    });
    app.post('/timed/role', checkAuth, async (req, res) => {
        const b = req.body || {};
        const r = await modules.timed.timedRole(guild(), { userId: String(b.userId || '').trim(), roleId: b.roleId, when: b.duration, mode: b.mode === 'revoke' ? 'revoke' : 'grant', actor: actorOf(req) });
        flash(res, '/timed', r, r.ok ? `Role change applied; reverse scheduled (#${r.item.id})` : '');
    });
    app.post('/timed/unban', checkAuth, async (req, res) => {
        const b = req.body || {};
        const r = await modules.timed.scheduleUnban({ userId: String(b.userId || '').trim(), when: b.duration, actor: actorOf(req) });
        flash(res, '/timed', r, r.ok ? `Unban scheduled (#${r.item.id})` : '');
    });
    app.post('/timed/message', checkAuth, async (req, res) => {
        const b = req.body || {};
        const r = await modules.timed.scheduleMessage(guild(), { channelId: b.channelId, when: b.duration, text: b.text, actor: actorOf(req) });
        flash(res, '/timed', r, r.ok ? `Message scheduled (#${r.item.id})` : '');
    });
    app.post('/protection/impersonation/add', checkAuth, async (req, res) => flash(res, '/protection', await modules.impersonation.addProtected(req.body?.name), 'Protected name added'));
    app.post('/protection/impersonation/remove', checkAuth, async (req, res) => flash(res, '/protection', await modules.impersonation.removeProtected(req.body?.name), 'Protected name removed'));
    app.post('/protection/impersonation/scan', checkAuth, async (req, res) => {
        const g = guild();
        if (!g) return back(res, '/protection', '❌ Guild unavailable');
        const rename = req.body?.rename === '1';
        lastScan = { ...(await modules.impersonation.scanMembers(g, { rename })), rename, at: Date.now() };
        back(res, '/protection', `Scan finished: ${lastScan.hits.length} match(es)${rename ? `, renamed ${lastScan.renamed}` : ' (preview)'}`);
    });
    app.post('/protection/evasion/sync', checkAuth, async (req, res) => {
        const g = guild();
        if (!g) return back(res, '/protection', '❌ Guild unavailable');
        const r = await modules.evasion.syncAll(g);
        back(res, '/protection', `Tracking ${r.total} bans (${r.added} new). Invite tracking ${r.inviteTracking ? 'working' : 'unavailable'}.`);
    });

    // ---------- Timed actions ----------
    app.get('/timed', checkAuth, async (req, res) => {
        const q = modules.timed.data().queue;
        await page(req, res, 'fx-timed', 'fx-timed', {
            ...lists(), cfgT: getConfig(db(), 'timed'),
            pending: modules.timed.pending().map((i) => ({ ...i, text: modules.timed.describe(i) })),
            history: q.filter((i) => i.status !== 'pending').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 30).map((i) => ({ ...i, text: modules.timed.describe(i) })),
            typeLabel: modules.timed.TYPE_LABEL,
        });
    });
    app.post('/timed/:id/cancel', checkAuth, async (req, res) => {
        const it = modules.timed.data().queue.find((i) => i.id === parseInt(req.params.id, 10));
        if (!it || it.status !== 'pending') return back(res, '/timed', 'Not found or already finished');
        it.status = 'cancelled'; it.finishedAt = Date.now();
        await safeSave();
        back(res, '/timed', `#${it.id} cancelled`);
    });
}

module.exports = { register, barChart };
