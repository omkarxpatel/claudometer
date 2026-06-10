# Live quota

Claudometer reads the same 5-hour and weekly utilization that claude.ai shows, using the OAuth sign-in Claude Code already stores — **no API key needed**.

- The status bar shows `5h 60% · 7d 8%` and turns amber at 70%, red at 90%.
- After a few minutes of snapshots, the quota cards forecast your pace: *"on pace to max at 4:40 PM"*.
- At 80% and 95% you get a notification with a **Notify me at reset** button — walk away and VS Code pings you when the window rolls over.

Disable the probe entirely with `claudometer.quota.enabled: false` (cost tracking keeps working offline).
