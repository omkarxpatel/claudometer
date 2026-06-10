import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { aggregate, UsageSummary } from './core/aggregate';
import {
  appendSnapshot,
  forecastQuota,
  QuotaForecast,
  QuotaSnapshot,
} from './core/forecast';
import {
  emptyLedger,
  groupRecords,
  LedgerData,
  ledgerToCsv,
  ledgerToJson,
  mergeIntoLedger,
  residueRecords,
  rowsFromExportJson,
} from './core/ledger';
import {
  ModelPricing,
  pricingSource,
  setLivePricing,
  setPricingOverrides,
} from './core/pricing';
import { fetchLivePricing } from './data/livePricing';
import { UsageScanner } from './data/scanner';
import { fetchQuota, QuotaData } from './data/quota';

export interface PricingMeta {
  source: 'live' | 'bundled';
  fetchedAtMs: number | null;
}

export interface UsageState {
  summary: UsageSummary | null;
  quota: QuotaData | null;
  forecast: QuotaForecast;
  pricing: PricingMeta;
  /** True until the first real scan of this session completes. */
  loading: boolean;
}

interface PricingCache {
  table: Record<string, ModelPricing>;
  fetchedAtMs: number;
}

const CACHE_KEY = 'claudometer.cachedState';
const PRICING_CACHE_KEY = 'claudometer.pricingCache';
const QUOTA_HISTORY_KEY = 'claudometer.quotaHistory';
const PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LEDGER_FILENAME = 'claudometer-ledger.json';

/**
 * Single source of truth. Owns the scanner, the file watcher, the quota
 * poller, and the persisted cache; the status bar and dashboard are pure
 * subscribers of `onDidChange`. New features (tree views, alerts, exports)
 * should subscribe here rather than reaching into the data layer.
 */
export class UsageStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageState>();
  readonly onDidChange = this._onDidChange.event;

  private _state: UsageState = {
    summary: null,
    quota: null,
    forecast: { fiveHourEtaMs: null, sevenDayEtaMs: null, weekly: null },
    pricing: { source: 'bundled', fetchedAtMs: null },
    loading: true,
  };
  get state(): UsageState {
    return this._state;
  }

  private readonly scanner: UsageScanner;
  private readonly disposables: vscode.Disposable[] = [];
  private usageDebounce?: ReturnType<typeof setTimeout>;
  private quotaDebounce?: ReturnType<typeof setTimeout>;
  private resetTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pricingTimer?: ReturnType<typeof setInterval>;
  private ledgerSaveTimer?: ReturnType<typeof setTimeout>;
  private scanInFlight = false;
  private scanQueued = false;
  private quotaInFlight = false;
  private ledger: LedgerData = emptyLedger();
  private quotaHistory: QuotaSnapshot[] = [];

  constructor(
    private readonly memento: vscode.Memento,
    private readonly projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    private readonly storageDir: string | null = null
  ) {
    this.scanner = new UsageScanner(this.projectsDir);

    setPricingOverrides(this.pricingOverrides());

    this.loadLedger();
    this.quotaHistory = memento.get<QuotaSnapshot[]>(QUOTA_HISTORY_KEY, []);

    // Apply the last fetched pricing table before anything is parsed, so the
    // very first scan already uses up-to-date rates.
    if (this.pricingAutoUpdate()) {
      const pricingCache = memento.get<PricingCache>(PRICING_CACHE_KEY);
      if (pricingCache?.table) {
        setLivePricing(pricingCache.table);
        this._state.pricing = { source: 'live', fetchedAtMs: pricingCache.fetchedAtMs };
      }
    }

    // Restore the last session's data so the UI is never blank on startup;
    // `loading` stays true until the first real scan replaces it.
    const cached = memento.get<{ summary: UsageSummary | null; quota: QuotaData | null }>(
      CACHE_KEY
    );
    if (cached?.summary) {
      this._state = {
        ...this._state,
        summary: cached.summary,
        quota: revalidateQuota(cached.quota ?? null),
      };
    }
  }

  start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.projectsDir), '**/*.jsonl')
    );
    const onActivity = () => {
      clearTimeout(this.usageDebounce);
      this.usageDebounce = setTimeout(() => void this.refreshUsage(), 500);
      // Quota catches up shortly after each turn instead of waiting out the poll.
      clearTimeout(this.quotaDebounce);
      this.quotaDebounce = setTimeout(() => void this.refreshQuota(), 1500);
    };
    watcher.onDidChange(onActivity, null, this.disposables);
    watcher.onDidCreate(onActivity, null, this.disposables);
    watcher.onDidDelete(onActivity, null, this.disposables);
    this.disposables.push(watcher);

    vscode.workspace.onDidChangeConfiguration(
      (e) => this.onConfigChange(e),
      null,
      this.disposables
    );

    // Idle fallback: keeps "today" rolling over midnight and quota fresh.
    // Scans are incremental, so this is cheap.
    this.pollTimer = setInterval(() => void this.refresh(), 5 * 60 * 1000);

    // Daily pricing refresh keeps new models priced without an extension update.
    this.pricingTimer = setInterval(() => void this.refreshPricing(), PRICING_MAX_AGE_MS);

    void this.refreshPricing();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await Promise.all([this.refreshUsage(), this.refreshQuota()]);
  }

  private async refreshUsage(): Promise<void> {
    if (this.scanInFlight) {
      this.scanQueued = true;
      return;
    }
    this.scanInFlight = true;
    try {
      const records = await this.scanner.scan();

      // Fold the scan into the durable ledger, then add back anything the
      // ledger remembers that the scan no longer sees (pruned transcripts) —
      // all-time stats survive Claude Code's cleanupPeriodDays.
      const grouped = groupRecords(records);
      if (mergeIntoLedger(this.ledger, grouped)) this.saveLedgerSoon();
      const merged = records.concat(residueRecords(this.ledger, grouped));

      const q = this._state.quota;
      const summary = aggregate(merged, Date.now(), {
        fiveHourWindowStartMs: q ? q.fiveHourResetAtMs - 5 * 3_600_000 : null,
        sevenDayWindowStartMs: q ? q.sevenDayResetAtMs - 7 * 24 * 3_600_000 : null,
      });
      this.update({
        summary,
        loading: false,
        forecast: this.computeForecast(summary, q),
      });
    } catch (err) {
      console.error('[claudometer] usage scan failed:', err);
    } finally {
      this.scanInFlight = false;
      if (this.scanQueued) {
        this.scanQueued = false;
        void this.refreshUsage();
      }
    }
  }

  /* ---------- durable ledger ---------- */

  private ledgerPath(): string | null {
    const configured = vscode.workspace
      .getConfiguration('claudometer')
      .get<string>('ledgerPath', '')
      .trim();
    if (configured) {
      let p = configured.startsWith('~')
        ? path.join(os.homedir(), configured.slice(1))
        : configured;
      // A directory (e.g. a synced folder) gets the default filename inside it.
      try {
        if (fs.statSync(p).isDirectory()) p = path.join(p, LEDGER_FILENAME);
      } catch {
        if (!p.endsWith('.json')) p = path.join(p, LEDGER_FILENAME);
      }
      return p;
    }
    return this.storageDir ? path.join(this.storageDir, LEDGER_FILENAME) : null;
  }

  private readLedgerFile(file: string): LedgerData | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.version === 1 && parsed.rows && typeof parsed.rows === 'object') {
        return parsed;
      }
    } catch {
      // missing or unreadable
    }
    return null;
  }

  private loadLedger(): void {
    const file = this.ledgerPath();
    if (!file) return;
    const data = this.readLedgerFile(file);
    if (data) this.ledger = data;
  }

  /** The ledger location changed — merge whatever lives there, keep our superset. */
  private onLedgerPathChange(): void {
    const file = this.ledgerPath();
    if (file) {
      const existing = this.readLedgerFile(file);
      if (existing) mergeIntoLedger(this.ledger, existing.rows);
    }
    this.saveLedgerSoon();
    void this.refreshUsage();
  }

  /** Merge a Claudometer JSON export (e.g. from another machine). */
  importData(jsonText: string): number | null {
    const rows = rowsFromExportJson(jsonText);
    if (!rows) return null;
    mergeIntoLedger(this.ledger, rows);
    this.saveLedgerSoon();
    void this.refreshUsage();
    return Object.keys(rows).length;
  }

  private saveLedgerSoon(): void {
    const file = this.ledgerPath();
    if (!file) return;
    clearTimeout(this.ledgerSaveTimer);
    this.ledgerSaveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(this.ledger));
      } catch (err) {
        console.error('[claudometer] ledger save failed:', err);
      }
    }, 2000);
  }

  exportData(format: 'csv' | 'json'): string {
    return format === 'csv' ? ledgerToCsv(this.ledger) : ledgerToJson(this.ledger);
  }

  private async refreshQuota(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration('claudometer')
      .get<boolean>('quota.enabled', true);
    if (!enabled) {
      if (this._state.quota) this.update({ quota: null });
      return;
    }
    if (this.quotaInFlight) return;
    this.quotaInFlight = true;
    try {
      const fresh = await fetchQuota();
      if (fresh) {
        // Responses sometimes omit the 7d header; keep the previous weekly
        // value while its reset is still in the future.
        const prev = this._state.quota;
        if (!fresh.sevenDayHeaderPresent && prev && prev.sevenDayResetAtMs > Date.now()) {
          fresh.sevenDayUtilization = prev.sevenDayUtilization;
          fresh.sevenDayResetAtMs = prev.sevenDayResetAtMs;
        }

        const next = appendSnapshot(this.quotaHistory, {
          t: fresh.fetchedAtMs,
          five: fresh.fiveHourUtilization,
          seven: fresh.sevenDayUtilization,
        });
        if (next !== this.quotaHistory) {
          this.quotaHistory = next;
          void this.memento.update(QUOTA_HISTORY_KEY, next);
        }

        this.update({
          quota: fresh,
          forecast: this.computeForecast(this._state.summary, fresh),
        });

        // The window-anchored token sums depend on the reset times — recompute
        // when a window rolls over (or on the first quota of the session).
        const windowMoved =
          !prev ||
          Math.abs(fresh.fiveHourResetAtMs - prev.fiveHourResetAtMs) > 60_000 ||
          Math.abs(fresh.sevenDayResetAtMs - prev.sevenDayResetAtMs) > 60_000;
        if (windowMoved) void this.refreshUsage();
      }
      this.scheduleResetRefetch();
    } catch (err) {
      console.error('[claudometer] quota fetch failed:', err);
    } finally {
      this.quotaInFlight = false;
    }
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('claudometer')) return;
    if (e.affectsConfiguration('claudometer.pricing.overrides')) {
      setPricingOverrides(this.pricingOverrides());
      this.scanner.recost();
      void this.refreshUsage();
    }
    if (e.affectsConfiguration('claudometer.pricing.autoUpdate')) void this.refreshPricing();
    if (e.affectsConfiguration('claudometer.quota.enabled')) void this.refreshQuota();
    if (e.affectsConfiguration('claudometer.ledgerPath')) this.onLedgerPathChange();
    // Display-only settings (status bar segments, appearance): subscribers
    // re-read configuration on every render, so a plain re-fire suffices.
    this._onDidChange.fire(this._state);
  }

  private pricingOverrides(): Record<string, Partial<ModelPricing>> {
    return vscode.workspace
      .getConfiguration('claudometer')
      .get<Record<string, Partial<ModelPricing>>>('pricing.overrides', {});
  }

  private pricingAutoUpdate(): boolean {
    return vscode.workspace
      .getConfiguration('claudometer')
      .get<boolean>('pricing.autoUpdate', true);
  }

  /** User-triggered refetch from the settings page — bypasses the 24h cache. */
  forcePricingRefresh(): Promise<void> {
    return this.refreshPricing(true);
  }

  private async refreshPricing(force = false): Promise<void> {
    if (!this.pricingAutoUpdate()) {
      // Fully-offline mode: drop any live table and fall back to bundled rates.
      if (pricingSource() === 'live') {
        setLivePricing(null);
        this.scanner.recost();
        this.update({ pricing: { source: 'bundled', fetchedAtMs: null } });
        void this.refreshUsage();
      }
      return;
    }

    const cached = this.memento.get<PricingCache>(PRICING_CACHE_KEY);
    if (!force && cached && Date.now() - cached.fetchedAtMs < PRICING_MAX_AGE_MS) return;

    const table = await fetchLivePricing();
    if (!table) return; // offline or source down — keep whatever we have

    await this.memento.update(PRICING_CACHE_KEY, {
      table,
      fetchedAtMs: Date.now(),
    } satisfies PricingCache);
    setLivePricing(table);
    this.scanner.recost();
    this.update({ pricing: { source: 'live', fetchedAtMs: Date.now() } });
    void this.refreshUsage();
  }

  private computeForecast(summary: UsageSummary | null, quota: QuotaData | null): QuotaForecast {
    return forecastQuota(
      this.quotaHistory,
      Date.now(),
      quota,
      summary
        ? {
            calendar: summary.calendar,
            windowCostUSD: summary.sevenDayWindow?.costUSD ?? 0,
          }
        : undefined
    );
  }

  /** Re-fetch right after the next quota window rolls over so the UI clears itself. */
  private scheduleResetRefetch(): void {
    clearTimeout(this.resetTimer);
    const q = this._state.quota;
    if (!q) return;
    const now = Date.now();
    const upcoming = [q.fiveHourResetAtMs, q.sevenDayResetAtMs].filter((t) => t > now);
    if (upcoming.length > 0) {
      const delay = Math.min(...upcoming) - now + 2000;
      this.resetTimer = setTimeout(() => void this.refreshQuota(), delay);
    }
  }

  private update(patch: Partial<UsageState>): void {
    this._state = { ...this._state, ...patch };
    void this.memento.update(CACHE_KEY, {
      summary: this._state.summary,
      quota: this._state.quota,
    });
    this._onDidChange.fire(this._state);
  }

  dispose(): void {
    clearTimeout(this.usageDebounce);
    clearTimeout(this.quotaDebounce);
    clearTimeout(this.resetTimer);
    clearTimeout(this.ledgerSaveTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pricingTimer) clearInterval(this.pricingTimer);
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}

/** Cached quota windows may have reset while VS Code was closed. */
function revalidateQuota(quota: QuotaData | null): QuotaData | null {
  if (!quota) return null;
  const now = Date.now();
  return {
    ...quota,
    fiveHourUtilization: quota.fiveHourResetAtMs <= now ? 0 : quota.fiveHourUtilization,
    sevenDayUtilization: quota.sevenDayResetAtMs <= now ? 0 : quota.sevenDayUtilization,
  };
}
