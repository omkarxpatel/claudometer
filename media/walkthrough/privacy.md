# Local-first, by design

- **Reads** Claude Code's session logs from `~/.claude` — never your workspace files.
- **Stores** a durable ledger of daily totals (never message content) in extension storage, so your history survives Claude Code's ~30-day transcript cleanup. Point `claudometer.ledgerPath` at a synced folder for backup.
- **Sends nothing about you anywhere.** The only network calls are the optional quota probe (your existing sign-in) and an anonymous daily pricing fetch from models.dev — both can be turned off.
- **Export or import** your data as CSV/JSON any time — it's yours.

No API keys. No accounts. No telemetry.
