# osqarek hii

## Confessions
`/confess <message>` posts an anonymous embed. Set in `.env`:
- `CONFESSION_CHANNEL` — channel ID where confessions are posted publicly
- `CONFESSION_LOGS` — private staff channel ID; the author's name/ID is logged here only
The bot needs Send Messages + Embed Links in both channels. Re-run command deployment (restart the bot) so `/confess` registers.
