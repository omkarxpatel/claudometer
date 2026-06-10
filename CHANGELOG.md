# Changelog

## 0.1.1

- New README header with icon and badges; replaced the retired shields.io marketplace badge

## 0.1.0

Initial release.

- Status bar with today's cost and live 5h/7d quota (configurable segments)
- Dashboard with tabs: spend cards with change badges and month pace projection,
  activity charts (hour/day/week/month), GitHub-style contribution calendar with
  streaks, per-project and per-model drill-downs, tool-use analytics, sessions
- Live quota from Anthropic rate-limit headers via your existing Claude Code
  sign-in — no API keys; burn forecasting (weekday-aware for the 7d window) and
  optional alerts, including a reminder when a window resets
- Monthly budget with progress bar and alerts
- Durable usage ledger: daily aggregates survive Claude Code's transcript
  cleanup; configurable location; CSV/JSON export and cross-machine import
- Incremental JSONL scanner — only appended bytes are parsed on refresh
- Daily live pricing from models.dev with retroactive recosting, bundled
  fallback, and per-model overrides in a custom settings page
- Getting-started walkthrough; "What's new" notification after updates
