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
| Ban-evasion flags | `/evasion check\|flags\|dismiss\|sync` | Protection | **off** |
| Impersonation guard | `/impersonation list\|check\|add\|remove\|scan` | Protection | **off** |
| Timed actions | `/timed ban\|role\|unban\|message\|list\|cancel` | Timed Actions | on |
| Giveaways | `/giveaway start\|end\|reroll\|cancel\|list` | Giveaways & Polls | on |
| Polls | `/poll create\|quick\|end\|results\|list` | Giveaways & Polls | on |
| Case search | `/case-search` | Case Search | on |
| Audit log viewer | `/audit` | Audit Log | on |
| Analytics | `/analytics` | Analytics | on |
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
