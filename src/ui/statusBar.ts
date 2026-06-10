import * as vscode from 'vscode';
import { formatCost, formatTokenCount, SessionSummary, UsageSummary } from '../core/aggregate';
import { QuotaData } from '../data/quota';
import { UsageState, UsageStore } from '../store';

const ACTIVE_SESSION_WINDOW_MS = 10 * 60 * 1000;

const AMBER = '#fbbf24';
const RED = '#f87171';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(store: UsageStore) {
    this.item = vscode.window.createStatusBarItem(
      'claudometer.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.name = 'Claudometer';
    this.item.command = 'claudometer.openDashboard';
    this.item.show();
    this.subscription = store.onDidChange((state) => this.render(state));
    this.render(store.state);
  }

  private render(state: UsageState): void {
    const { summary, quota, loading } = state;

    if (!summary) {
      this.item.color = undefined;
      this.item.text = loading ? '$(sync~spin) Claudometer' : '$(graph) Claudometer';
      this.item.tooltip = loading
        ? 'Claudometer — scanning Claude Code usage…'
        : 'Claudometer — no Claude Code usage found';
      return;
    }

    const cfg = vscode.workspace.getConfiguration('claudometer.statusBar');
    const parts: string[] = [];
    if (cfg.get('showCost', true)) parts.push(formatCost(summary.todayCost));
    if (cfg.get('showWorkspaceCost', false)) {
      const ws = workspaceTodayCost(summary);
      if (ws !== null) parts.push(`ws ${formatCost(ws)}`);
    }
    if (cfg.get('showSessionCost', false)) {
      const live = activeSession(summary);
      if (live) parts.push(`live ${formatCost(live.costUSD)}`);
    }
    if (quota) {
      if (cfg.get('show5hQuota', true)) {
        const reset = cfg.get('showResetCountdown', false)
          ? ` (${timeUntil(quota.fiveHourResetAtMs).replace(' ', '')})`
          : '';
        parts.push(`5h ${fmtPct(quota.fiveHourUtilization)}${reset}`);
      }
      if (cfg.get('show7dQuota', true) && quota.sevenDayHeaderPresent !== false) {
        parts.push(`7d ${fmtPct(quota.sevenDayUtilization)}`);
      }
    }

    this.item.color = worstColor(urgencyColor(quota), budgetColor(summary.monthCost));
    this.item.text = parts.length > 0 ? `$(graph) ${parts.join(' · ')}` : '$(graph)';
    this.item.tooltip = buildTooltip(state);
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

function urgencyColor(quota: QuotaData | null): string | undefined {
  if (!quota) return undefined;
  const max = Math.max(quota.fiveHourUtilization, quota.sevenDayUtilization);
  if (max >= 0.9) return RED;
  if (max >= 0.7) return AMBER;
  return undefined;
}

function monthlyBudget(): number {
  return vscode.workspace.getConfiguration('claudometer').get<number>('budget.monthly', 0);
}

function budgetColor(monthCost: number): string | undefined {
  const budget = monthlyBudget();
  if (!(budget > 0)) return undefined;
  const ratio = monthCost / budget;
  if (ratio >= 1) return RED;
  if (ratio >= 0.8) return AMBER;
  return undefined;
}

function worstColor(a: string | undefined, b: string | undefined): string | undefined {
  if (a === RED || b === RED) return RED;
  if (a === AMBER || b === AMBER) return AMBER;
  return undefined;
}

/** Today's cost across projects under any open workspace folder; null when no match. */
function workspaceTodayCost(summary: UsageSummary): number | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  const roots = folders.map((f) => f.uri.fsPath);
  let sum = 0;
  let matched = false;
  for (const p of summary.byProject) {
    if (roots.some((root) => p.projectPath === root || p.projectPath.startsWith(root + '/'))) {
      sum += p.todayCostUSD ?? 0;
      matched = true;
    }
  }
  return matched ? sum : null;
}

/** The most recent session, if it showed activity in the last few minutes. */
function activeSession(summary: UsageSummary): SessionSummary | null {
  const latest = summary.recentSessions[0];
  return latest && Date.now() - latest.timestampMs < ACTIVE_SESSION_WINDOW_MS ? latest : null;
}

/** Status bar percentages stay terse: whole numbers, "<1%" below one. */
function fmtPct(v: number): string {
  if (v > 1) return 'maxed';
  if (v < 0.001) return '0%';
  if (v < 0.01) return '<1%';
  return `${Math.round(v * 100)}%`;
}

function timeUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildTooltip(state: UsageState): vscode.MarkdownString {
  const { summary, quota } = state;
  const lines: string[] = ['**Claudometer — Today**', ''];

  if (summary) {
    lines.push(
      `💰 Cost: **${formatCost(summary.todayCost)}**`,
      `🔢 Tokens: ${formatTokenCount(summary.todayTokens)}`,
      `💬 Messages: ${summary.todayMessages}`
    );
    const ws = workspaceTodayCost(summary);
    if (ws !== null) lines.push(`📁 This workspace: **${formatCost(ws)}**`);
    const live = activeSession(summary);
    if (live) {
      lines.push(
        `▶ Active session (${live.displayName}): **${formatCost(live.costUSD)}** · ${formatTokenCount(live.totalTokens)} tokens`
      );
    }
  }

  if (quota) {
    const pace5 = state.forecast?.fiveHourEtaMs
      ? ` — ⚠ on pace to max at ${new Date(state.forecast.fiveHourEtaMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : '';
    const weekly = state.forecast?.weekly;
    let pace7 = '';
    if (weekly) {
      if (weekly.level === 'risk') {
        pace7 = weekly.runsOutAtMs
          ? ` — ⚠ **may run out ${new Date(weekly.runsOutAtMs).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}**`
          : ' — ⚠ **may run out before reset**';
      } else if (weekly.level === 'tight') {
        pace7 = ` — tight, ~${Math.round(weekly.projectedUtilization * 100)}% at reset`;
      } else {
        pace7 = ` — on pace, ~${Math.round(weekly.projectedUtilization * 100)}% at reset`;
      }
    }
    const used5 = summary?.fiveHourWindow
      ? ` (${formatTokenCount(summary.fiveHourWindow.tokens)} tokens)`
      : '';
    const used7 = summary?.sevenDayWindow
      ? ` (${formatTokenCount(summary.sevenDayWindow.tokens)} tokens)`
      : '';
    const weeklyLine =
      quota.sevenDayHeaderPresent === false
        ? '· Weekly (7d): no limit reported for your plan'
        : `· Weekly (7d): **${fmtPct(quota.sevenDayUtilization)}**${used7} — resets in ${timeUntil(quota.sevenDayResetAtMs)}${pace7}`;
    lines.push(
      '',
      '---',
      '⚡ **Quota**',
      `· Session (5h): **${fmtPct(quota.fiveHourUtilization)}**${used5} — resets in ${timeUntil(quota.fiveHourResetAtMs)}${pace5}`,
      weeklyLine
    );
  }

  const budget = monthlyBudget();
  if (budget > 0 && summary) {
    lines.push(
      '',
      '---',
      `🎯 Budget: **${formatCost(summary.monthCost)}** / ${formatCost(budget)} (${Math.round((summary.monthCost / budget) * 100)}%)`
    );
  }

  if (summary) {
    const rolling =
      vscode.workspace
        .getConfiguration('claudometer')
        .get<string>('dashboard.weekMetric', 'calendar') === 'rolling';
    const weekLabel = rolling ? 'Last 7 days' : 'This week';
    const weekCost = rolling ? summary.lastSevenDays.costUSD : summary.weekCost;
    lines.push(
      '',
      '---',
      `${weekLabel}: **${formatCost(weekCost)}** · This month: **${formatCost(summary.monthCost)}**`,
      `All time: **${formatCost(summary.allTimeCost)}**`,
      '',
      '*Click to open the dashboard*'
    );
  }

  return new vscode.MarkdownString(lines.join('\n\n'));
}
