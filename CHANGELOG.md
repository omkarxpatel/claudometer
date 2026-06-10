# Changelog

## 0.2.0 (unreleased)

- Workspace-aware status bar: today's cost for the projects open in this window (toggleable)
- Live session ticker: running cost of the active conversation in the status bar (toggleable)
- Long-horizon trends: the Month chart view now reaches back to first recorded usage (up to 36 months)
- Ledger import: merge a JSON export from another machine (`Claudometer: Import Usage Data…`)
- Configurable ledger location (`claudometer.ledgerPath`) — point at a synced folder for backup
- Getting-started walkthrough for first-run onboarding (opens automatically on first install)
- "What's new" notification after extension updates, linking to this changelog

- Durable usage ledger: daily aggregates survive Claude Code's transcript cleanup
- CSV/JSON export from the ledger (`Claudometer: Export Usage Data…`)
- Quota burn forecasting ("on pace to max at 4:40 PM") from utilization snapshots
- Quota alerts at 80%/95% with an optional "notify me at reset" reminder
- Monthly budget: progress bar on the This Month card, status bar urgency, alerts
- Tool-use analytics (Models tab) — counts per tool across all sessions
- Dashboard tabs, GitHub-style activity calendar with streaks, axis/tooltip polish

## 0.1.0

Initial baseplate.

- Status bar with today's cost and live 5h/7d quota
- Dashboard webview (spend cards, quota bars, token breakdown, projects, models, recent sessions)
- Incremental JSONL scanner — only appended bytes are parsed on refresh
- Optional quota probe via existing Claude Code OAuth credentials (no API keys)
- Pricing table current as of June 2026, including Fable 5 and cache write tiers
- Daily live pricing from models.dev with retroactive recosting and bundled fallback
- Settings page: status bar segment toggles, accent color, week semantics, and a
  per-model pricing editor with overrides that beat fetched/bundled rates
- Unit tests for parser, pricing, overrides, aggregator, and scanner
