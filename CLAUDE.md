# Claudometer — project context

VS Code extension that tracks Claude Code usage (cost, tokens, live quota) by reading
`~/.claude/projects/**/*.jsonl` locally. Clean-room replacement for `clusage`
(readable at `../clusage`), built because that author doesn't merge PRs.

## Hard constraints (do not violate)

- **No API keys, ever.** Quota uses the OAuth token Claude Code already stores
  (credentials file, macOS Keychain fallback) via a ~1-token probe to
  `api.anthropic.com`, reading `anthropic-ratelimit-unified-*` headers.
- **No telemetry.** Only two outbound calls exist (quota probe, models.dev pricing
  fetch); both have off-switches and are documented in README → Privacy. Adding any
  network call requires a setting + README privacy-table row.
- **Marketplace trust story**: never read workspace files (`untrustedWorkspaces`
  declared), keep README privacy claims accurate.

## Architecture

```
src/core/      pure, no vscode imports, fully unit-tested (vitest)
  parser.ts      JSONL line → UsageRecord (dedup by message.id is caller's job;
                 skips stop_reason==null streaming intermediates; counts tool_use
                 blocks; isSidechain → fromSubagent)
  pricing.ts     precedence: user overrides > live (models.dev) > bundled table >
                 Sonnet default. Prefix-matched (dated ids, "[1m]" suffixes).
                 resolvePricing() reports the source; 'default' renders ⚠ in UI.
  aggregate.ts   UsageRecord[] → UsageSummary (one pass): spend buckets, deltas,
                 projections, streaks, series (hour/day/week/month), contribution
                 calendar, per-project/model/session rollups, quota-window sums
                 (anchored at resetAt − window, passed via opts), tool usage.
  ledger.ts      durability: Claude Code prunes transcripts (~30d). Daily rows per
                 (day, project, model); merge = field-wise MAX (captures growth,
                 ignores deletion shrinkage); pruned history re-enters aggregation
                 as synthesized "residue" records (sessionId '', messageCount n).
                 Stores raw tokens, never costs → repricing is retroactive.
  forecast.ts    5h linear ETA from utilization snapshots; 7d weekday-aware pace:
                 calibrate full-quota cost = windowCost / utilization, project
                 remaining days from per-day-of-week averages (last 8 occurrences).
src/data/      node-only IO
  scanner.ts     incremental: per-file byte offsets, parses only appended bytes;
                 handles truncation, partial trailing lines, nested subagents/ dirs.
                 recost() reprices cached records in place after pricing changes.
  quota.ts       OAuth probe; 429-without-headers = exhausted; absent 7d header =
                 plan has no weekly limit (sevenDayHeaderPresent=false → UI shows
                 "no weekly limit reported", ∞ card).
  livePricing.ts models.dev fetch (chosen over LiteLLM: carried Fable 5 first);
                 cache_write is the 5m tier, 1h derived as 2× input.
src/store.ts   single source of truth. Owns scanner/watcher/timers/ledger/quota
               history; UI components are pure subscribers of onDidChange. New
               features subscribe here — never reach into data/ directly.
src/ui/        statusBar, dashboard, settingsPage (webviews), alerts (notifications)
media/         webview assets. Dashboard re-renders from postMessage state — NEVER
               replace webview.html on refresh.
```

## Gotchas / invariants

- **Webview CSP needs `'unsafe-inline'` for style-src** — inline `style="width:X%"`
  drives every bar; without it all bars silently render full-width.
- Webviews set `color-scheme` from `body.vscode-dark/light` so native controls
  (checkboxes) aren't harsh white.
- All timestamps are epoch-ms numbers (JSON-safe through globalState/postMessage).
- Default accent `#D97757` (Claude terracotta) is duplicated in: package.json,
  both CSS `:root` blocks, dashboard.ts + settingsPage.ts fallbacks.
- Settings page is a veneer over real `claudometer.*` settings (Settings Sync
  works); store re-fires onDidChange on any config change; settingsPage skips
  identical reposts so open edits aren't wiped mid-typing.
- Stale cached summaries (from globalState) may lack new fields — every renderer
  guards (`s.field || fallback`).
- Quota-window token sums must re-aggregate when reset times move (store watches
  for >60s reset-time changes).
- Aggregate tests pin NOW = Tue Jun 9 2026 15:00 local; streak/calendar/pace math
  depends on that being a Tuesday.
- Ledger location is configurable (`claudometer.ledgerPath`); changing it MERGES
  (never overwrites). Import (`rowsFromExportJson`) reuses the same max-merge, so
  re-imports can't double-count.

## Commands

```
npm run check   # tsc --noEmit (strict)
npm run build   # esbuild → dist/extension.js
npm test        # vitest, src/test/** (73+ tests, all pure-core)
npm run package # vsce package
```

F5 = Extension Development Host (dev-host globalStorage ≠ installed-build storage,
so the ledger differs between them).

Screenshot regeneration (README images, synthetic data — never real usage):

```
npx esbuild scripts/demo/gen.ts --bundle --platform=node --format=cjs \
  --outfile=scripts/demo/out/gen.cjs && node scripts/demo/out/gen.cjs
node scripts/demo/shot.mjs    # needs: npm i -D playwright && npx playwright install chromium
```

## Publishing status

- Marketplace publisher id: **OmkarPatel** (must match package.json `publisher`,
  the README badge URL, and `vsce login`). Publishing is done by manual .vsix
  upload at marketplace.visualstudio.com/manage (no Azure DevOps PAT set up).
- `repository.url` in package.json must point at the real GitHub repo — the
  marketplace resolves the relative README screenshots through it.
- Releases: update CHANGELOG, then `npm version patch` (bumps package.json,
  syncs the static README badge via scripts/sync-version-badge.mjs, commits,
  tags) and `git push --follow-tags`. The publish.yml workflow then packages
  (check + tests + production build) and publishes — IF the `VSCE_PAT` repo
  secret is set (needs the Azure DevOps org). Until then: `npm run package`
  and upload the .vsix manually. "What's new" toast keys off the version.
- Pricing table in core/pricing.ts is current as of June 2026; live fetch covers
  drift, but bump the bundled table when touching pricing anyway.
