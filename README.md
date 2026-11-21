# osqarek hii

## Confessions
`/confess <message>` posts an anonymous embed. Set in `.env`:
- `CONFESSION_CHANNEL` — channel ID where confessions are posted publicly
- `CONFESSION_LOGS` — private staff channel ID; the author's name/ID is logged here only
The bot needs Send Messages + Embed Links in both channels. Re-run command deployment (restart the bot) so `/confess` registers.

## Feature suite (`features/`)
Raid protection, ban-evasion flags, impersonation guard, timed actions, giveaways, polls,
case search, audit log viewer, analytics and per-feature settings. Each lives in its own
file under `features/`; `index.js` only calls `features.init(...)` and routes buttons to it.

| Feature | Slash command | Dashboard page | Default |
|---|---|---|---|
| Raid protection | `/raid status\|start\|end` | Protection | **off** |
| Drills (raid + server lockdown) | `/drill raid\|lockdown` | — | on |
| Server / channel lockdown | `/mod lockdown scope:Server\|Channel` | Lockdown & Drills | on |
| Ban-evasion flags | `/evasion check\|flags\|dismiss\|sync` | Protection | **off** |
| Impersonation guard | `/impersonation list\|check\|add\|remove\|scan` | Protection | **off** |
| Timed actions | `/timed ban\|role\|unban\|message\|list\|cancel` | Timed Actions | on |
| Giveaways | `/giveaway start\|end\|reroll\|cancel\|list` | Giveaways & Polls | on |
| Polls | `/poll create\|quick\|end\|results\|list` | Giveaways & Polls | on |
| Case search | `/case-search` | Case Search | on |
| Audit log viewer | `/audit` | Audit Log | on |
| Analytics | `/analytics` | Analytics | on |
| Voice time stats | `/vc stats\|top\|server\|now` | Analytics | on |
| Per-feature settings | `/feature list\|show\|enable\|disable\|set\|reset` | Feature Settings | — |

Settings are defined once in `features/config.js` (the slash command and dashboard both read it).
Data is stored under `db.features.*`. The bot needs: **Ban Members**, **Kick Members**,
**Moderate Members**, **Manage Roles**, **Manage Server** (invite tracking / pausing invites),
**View Audit Log**. The `GuildModeration` intent was added to the client for ban events
(non-privileged; no portal change needed). Re-deploy commands after updating (restart the bot).

### Everything is also available from the dashboard
Each slash command has a dashboard equivalent (both call the same service functions in `features/`):
start giveaways and create polls (**Giveaways & Polls**), schedule temp-bans / temporary roles /
unbans / delayed messages (**Timed Actions**), start/end raid mode, check a user against bans,
re-sync bans & invites, add/remove protected names, test a name and scan/rename members
(**Protection**), plus search cases, browse the audit log, view analytics and edit every
feature's settings. Dashboard-created giveaways/polls show your Discord account as host when you
log in with Discord, otherwise the bot.

### Drills & lockdowns (`features/lockdown.js`)
- `/drill raid [minutes]` and `/drill lockdown [minutes]` (Admin+; default 5 min, max 60) post a clearly-labelled **DRILL** embed in every text/announcement channel the bot can post in **and lock the server**. When the time is up (or `/drill end`) the server is unlocked and **the drill messages are deleted**. Drill state is stored in the db, so a restart mid-drill still ends on time.
- The person who runs a drill gets the exact message text back (reply + DM).
- `/mod lockdown scope:Server status:True|False [reason]` (Admin+) locks/unlocks every text channel for @everyone. Every channel's full permission overwrites (@everyone, every role and any member override, every allow/deny bit) are backed up and restored exactly on unlock. Unlocking during a drill ends the drill.
- `/mod lockdown scope:Channel status:True|False [channel] [reason]` locks/unlocks one channel (defaults to the current one).
- Dashboard: **Lockdown & Drills** page (start/end drills with a message preview, lock/unlock server or a channel, see the last action and the exact text posted).
- Needs **Manage Channels** (and Embed Links in the channels for drills). Re-deploy commands (restart the bot).

### Analytics + startup sync
When the startup stats sync finishes, the message counts it tallied while scanning history (per day / hour / channel, active users) are merged into Analytics, and the member-count snapshot is refreshed (merge = max of live vs scanned, so it never double-counts). Drills and lockdowns are counted per day too. The sync summary in the mod log says how much was merged.

### Voice time stats (`features/voice.js`)
- Tracks time in voice channels per member, per channel and per day (counts only). Bots and the AFK channel are ignored (AFK is configurable under **Features → Voice Time Stats**). Stats start from when tracking was enabled — Discord keeps no voice history to backfill.
- Moves between channels count as one session; time is split correctly across midnight. Live sessions are saved every minute and re-synced on startup, so restarts lose at most ~1 minute.
- `/vc stats [user]` all-time / 7d / 30d, sessions, longest + average session, rank, favourite channel (viewing others is Moderator+). `/vc top [days]` leaderboard (empty = all-time). `/vc server [days]` summary (Moderator+). `/vc now` who's in voice.
- Dashboard: **Analytics → Voice Time** (hours per day chart, top members, top channels, all-time leaderboard). `/analytics` also shows total voice time.


## Mailbox (`/settings/mail`)
Admin-only inbox in the dashboard: **Settings → Mailbox**. Read mail (IMAP), search, filter unread, mark read/unread, **reply** (threaded with `In-Reply-To`/`References`, original quoted) and **compose** new mail (SMTP). Set in `.env` — credentials are never stored in the database:
- `MAIL_USER`, `MAIL_PASS` — mailbox login (use an app password for Gmail/Outlook)
- `MAIL_IMAP_HOST` (+ `MAIL_IMAP_PORT`, default 993) and `MAIL_SMTP_HOST` (+ `MAIL_SMTP_PORT`, default 465; 587 = STARTTLS)
- optional `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_ALERT_TO` (recipient for the maintenance/downtime status emails; defaults to `MAIL_USER`)

HTML emails render in a sandboxed iframe (no scripts, remote images blocked). Sending is limited to 20 emails/hour. Run `npm install` after pulling (adds `imapflow`, `mailparser`, `nodemailer`). The code lives in `features/mail.js` and `views/mail.ejs`.

## Help Center (`/support`)
Public, Discord-support-style help center: search hero, category tiles, article list (client-side search/filter) and a **Submit a request** form at `/support/request`. Articles are defined in the `articles` array at the top of `views/support.ejs`. Requests are stored in `db.supportRequests` (last 500, ref like `SR-1A2B3C`), posted to the Discord webhook from Settings (mentions are neutralised), and limited to 3 per IP per hour with a honeypot field. Reply by DM, or by email via the Mailbox if the user left an address.
