import { PricingSource, pricingFor, resolvePricing } from './pricing';
import { UsageRecord, totalTokens } from './types';

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProjectSummary {
  projectPath: string;
  displayName: string;
  sessionCount: number;
  totalTokens: number;
  costUSD: number;
  todayCostUSD: number;
  lastActivityMs: number;
  /** Per-model cost/tokens for the expandable detail row. */
  models: Record<string, ModelBucket>;
  /** Daily cost for the last 30 days, oldest first — sparkline + detail chart. */
  spark: number[];
}

export interface ModelSummary {
  model: string;
  totalTokens: number;
  costUSD: number;
  requestCount: number;
  /** Tokens per class, for the expandable detail row. */
  breakdown: TokenBreakdown;
  /** Cost contribution per class at this model's rates. */
  costBreakdown: TokenBreakdown;
  /** 'default' means no exact pricing was known — the UI flags those rows. */
  pricingSource: PricingSource;
}

export interface SessionSummary {
  sessionId: string;
  displayName: string;
  timestampMs: number;
  totalTokens: number;
  costUSD: number;
  model: string;
}

export interface RollingWindow {
  costUSD: number;
  tokens: number;
}

export interface ModelBucket {
  costUSD: number;
  tokens: number;
}

export interface SeriesPoint {
  startMs: number;
  costUSD: number;
  tokens: number;
  /** Per-model contribution, for the stacked chart. */
  byModel: Record<string, ModelBucket>;
}

/** Time-bucketed activity for the dashboard chart, one array per granularity. */
export interface ActivitySeries {
  /** Last 48 hours. */
  hourly: SeriesPoint[];
  /** Last 30 days. */
  daily: SeriesPoint[];
  /** Last 12 weeks (Sunday starts). */
  weekly: SeriesPoint[];
  /** Last 12 calendar months. */
  monthly: SeriesPoint[];
}

/** One day of the contribution-style calendar (last 12 months, Sunday-aligned). */
export interface CalendarDay {
  startMs: number;
  costUSD: number;
  tokens: number;
}

export interface UsageSummary {
  allTimeCost: number;
  todayCost: number;
  weekCost: number;
  monthCost: number;
  todayTokens: number;
  weekTokens: number;
  monthTokens: number;
  todayMessages: number;
  allTimeTokens: number;
  allTimeMessages: number;
  tokenBreakdown: TokenBreakdown;
  todayTokenBreakdown: TokenBreakdown;
  /** Cost contribution of each token class — the meaningful proportions. */
  tokenCostBreakdown: TokenBreakdown;
  byProject: ProjectSummary[];
  byModel: ModelSummary[];
  recentSessions: SessionSummary[];
  lastHour: RollingWindow;
  lastFiveHours: RollingWindow;
  lastSevenDays: RollingWindow;
  /** Usage since the actual quota-window starts (resetAt − window length). */
  fiveHourWindow: RollingWindow | null;
  sevenDayWindow: RollingWindow | null;
  series: ActivitySeries;
  /** Tool invocations by name, sorted by count descending. */
  toolUsage: Array<{ name: string; count: number }>;
  calendar: CalendarDay[];
  totalActiveDays: number;
  maxStreakDays: number;
  maxStreakDaysNoWeekends: number;
  // Change-badge references
  yesterdayCost: number;
  prevWeekCost: number;
  prevRolling7dCost: number;
  prevMonthCost: number;
  // Pace
  monthProjectedCost: number;
  avgDailyCost30: number;
  // Streaks (UI picks one based on the weekend setting)
  streakDays: number;
  streakDaysNoWeekends: number;
  // Records
  maxDay: { startMs: number; costUSD: number } | null;
  maxSession: SessionSummary | null;
  subagent: RollingWindow;
  firstUsageMs: number | null;
  lastUpdatedMs: number;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

function projectDisplayName(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts.slice(-2).join('/');
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ms: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** DST-safe day arithmetic. */
function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

const HOUR = 3_600_000;

function makeBuckets(startTimes: number[]): SeriesPoint[] {
  return startTimes.map((startMs) => ({ startMs, costUSD: 0, tokens: 0, byModel: {} }));
}

function hourlyStarts(nowMs: number): number[] {
  const first = Math.floor(nowMs / HOUR) * HOUR - 47 * HOUR;
  return Array.from({ length: 48 }, (_, i) => first + i * HOUR);
}

// Day/week boundaries go through Date arithmetic so DST shifts stay correct.
function dailyStarts(nowMs: number, days = 30): number[] {
  const out: number[] = [];
  for (let k = days - 1; k >= 0; k--) out.push(addDays(startOfDay(nowMs), -k));
  return out;
}

function weeklyStarts(nowMs: number): number[] {
  const out: number[] = [];
  for (let k = 11; k >= 0; k--) out.push(addDays(startOfWeek(nowMs), -7 * k));
  return out;
}

function monthlyStarts(nowMs: number, count: number): number[] {
  const now = new Date(nowMs);
  const out: number[] = [];
  for (let k = count - 1; k >= 0; k--) {
    out.push(new Date(now.getFullYear(), now.getMonth() - k, 1).getTime());
  }
  return out;
}

/** Every day from the Sunday on/before one year ago through today. */
function calendarStarts(nowMs: number): number[] {
  const todayStart = startOfDay(nowMs);
  let d = startOfWeek(addDays(todayStart, -364));
  const out: number[] = [];
  while (d <= todayStart) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

function isWeekend(dayStartMs: number): boolean {
  const dow = new Date(dayStartMs).getDay();
  return dow === 0 || dow === 6;
}

/** Longest run of consecutive usage days, all time. */
function computeMaxStreak(sortedDays: number[], excludeWeekends: boolean): number {
  let best = 0;
  let current = 0;
  let prev: number | null = null;
  for (const d of sortedDays) {
    if (excludeWeekends && isWeekend(d)) continue;
    if (prev === null) {
      current = 1;
    } else {
      // The run continues if every day in the gap is an excluded weekend.
      let gap = addDays(prev, 1);
      let broken = false;
      while (gap < d) {
        if (!(excludeWeekends && isWeekend(gap))) {
          broken = true;
          break;
        }
        gap = addDays(gap, 1);
      }
      current = broken ? 1 : current + 1;
    }
    if (current > best) best = current;
    prev = d;
  }
  return best;
}

/** Starts are ascending; binary-search the bucket whose start is ≤ t. Returns -1 if before range. */
function bucketIndex(starts: number[], t: number): number {
  if (t < starts[0]) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

function addToSeries(
  points: SeriesPoint[],
  starts: number[],
  t: number,
  cost: number,
  tokens: number,
  model: string
): void {
  const idx = bucketIndex(starts, t);
  if (idx < 0) return;
  const p = points[idx];
  p.costUSD += cost;
  p.tokens += tokens;
  const m = p.byModel[model] ?? (p.byModel[model] = { costUSD: 0, tokens: 0 });
  m.costUSD += cost;
  m.tokens += tokens;
}

function computeStreak(
  daysWithUsage: Set<number>,
  todayStart: number,
  excludeWeekends: boolean
): number {
  let d = todayStart;
  // A quiet morning shouldn't zero the streak — grade from yesterday instead.
  if (!daysWithUsage.has(d)) d = addDays(d, -1);
  let streak = 0;
  for (;;) {
    const dow = new Date(d).getDay();
    if (excludeWeekends && (dow === 0 || dow === 6)) {
      d = addDays(d, -1);
      continue;
    }
    if (!daysWithUsage.has(d)) break;
    streak++;
    d = addDays(d, -1);
  }
  return streak;
}

export interface AggregateOptions {
  /** Start of the live 5h quota window (fiveHourResetAtMs − 5h). */
  fiveHourWindowStartMs?: number | null;
  /** Start of the live 7d quota window (sevenDayResetAtMs − 7d). */
  sevenDayWindowStartMs?: number | null;
}

export function aggregate(
  records: UsageRecord[],
  nowMs = Date.now(),
  opts: AggregateOptions = {}
): UsageSummary {
  const win5Start = opts.fiveHourWindowStartMs ?? null;
  const win7Start = opts.sevenDayWindowStartMs ?? null;
  const todayStart = startOfDay(nowMs);
  const weekStart = startOfWeek(nowMs);
  const monthStart = startOfMonth(nowMs);
  const yesterdayStart = addDays(todayStart, -1);
  const prevWeekStart = addDays(weekStart, -7);
  const prevMonthStart = startOfMonth(new Date(monthStart - 1).getTime());
  const days30Start = addDays(todayStart, -30);

  // The monthly series reaches back to the first recorded usage (the ledger
  // keeps it forever), capped at 36 months so the chart stays readable.
  let minTs = Number.POSITIVE_INFINITY;
  for (const r of records) if (r.timestampMs < minTs) minTs = r.timestampMs;
  const monthSpan = Number.isFinite(minTs)
    ? (new Date(nowMs).getFullYear() - new Date(minTs).getFullYear()) * 12 +
      (new Date(nowMs).getMonth() - new Date(minTs).getMonth()) +
      1
    : 12;
  const monthCount = Math.min(Math.max(monthSpan, 12), 36);

  const hourlyB = hourlyStarts(nowMs);
  const dailyB = dailyStarts(nowMs);
  const weeklyB = weeklyStarts(nowMs);
  const monthlyB = monthlyStarts(nowMs, monthCount);
  const sparkB = dailyStarts(nowMs, 30);
  const calendarB = calendarStarts(nowMs);

  const summary: UsageSummary = {
    allTimeCost: 0,
    todayCost: 0,
    weekCost: 0,
    monthCost: 0,
    todayTokens: 0,
    weekTokens: 0,
    monthTokens: 0,
    todayMessages: 0,
    allTimeTokens: 0,
    allTimeMessages: 0,
    tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    todayTokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokenCostBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byProject: [],
    byModel: [],
    recentSessions: [],
    lastHour: { costUSD: 0, tokens: 0 },
    lastFiveHours: { costUSD: 0, tokens: 0 },
    lastSevenDays: { costUSD: 0, tokens: 0 },
    fiveHourWindow: win5Start !== null ? { costUSD: 0, tokens: 0 } : null,
    sevenDayWindow: win7Start !== null ? { costUSD: 0, tokens: 0 } : null,
    series: {
      hourly: makeBuckets(hourlyB),
      daily: makeBuckets(dailyB),
      weekly: makeBuckets(weeklyB),
      monthly: makeBuckets(monthlyB),
    },
    toolUsage: [],
    calendar: calendarB.map((startMs) => ({ startMs, costUSD: 0, tokens: 0 })),
    totalActiveDays: 0,
    maxStreakDays: 0,
    maxStreakDaysNoWeekends: 0,
    yesterdayCost: 0,
    prevWeekCost: 0,
    prevRolling7dCost: 0,
    prevMonthCost: 0,
    monthProjectedCost: 0,
    avgDailyCost30: 0,
    streakDays: 0,
    streakDaysNoWeekends: 0,
    maxDay: null,
    maxSession: null,
    subagent: { costUSD: 0, tokens: 0 },
    firstUsageMs: null,
    lastUpdatedMs: nowMs,
  };

  const projects = new Map<string, ProjectSummary>();
  const models = new Map<string, ModelSummary>();
  const sessions = new Map<string, SessionSummary>();
  const sessionProjects = new Map<string, string>();
  const dayCosts = new Map<number, number>();
  const toolCounts = new Map<string, number>();
  let days30Cost = 0;

  for (const r of records) {
    const tokens = totalTokens(r);
    const cacheWrite = r.cacheWrite5mTokens + r.cacheWrite1hTokens;
    const t = r.timestampMs;
    const age = nowMs - t;
    const messages = r.messageCount ?? 1;

    summary.allTimeCost += r.costUSD;
    summary.allTimeTokens += tokens;
    summary.allTimeMessages += messages;
    if (r.toolUses) {
      for (const [name, count] of Object.entries(r.toolUses)) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
      }
    }
    summary.tokenBreakdown.input += r.inputTokens;
    summary.tokenBreakdown.output += r.outputTokens;
    summary.tokenBreakdown.cacheRead += r.cacheReadTokens;
    summary.tokenBreakdown.cacheWrite += cacheWrite;

    const pr = pricingFor(r.model);
    const M = 1_000_000;
    summary.tokenCostBreakdown.input += (r.inputTokens * pr.input) / M;
    summary.tokenCostBreakdown.output += (r.outputTokens * pr.output) / M;
    summary.tokenCostBreakdown.cacheRead += (r.cacheReadTokens * pr.cacheRead) / M;
    summary.tokenCostBreakdown.cacheWrite +=
      (r.cacheWrite5mTokens * pr.cacheWrite5m + r.cacheWrite1hTokens * pr.cacheWrite1h) / M;

    if (summary.firstUsageMs === null || t < summary.firstUsageMs) summary.firstUsageMs = t;

    const dayStart = startOfDay(t);
    dayCosts.set(dayStart, (dayCosts.get(dayStart) ?? 0) + r.costUSD);

    if (t >= todayStart) {
      summary.todayCost += r.costUSD;
      summary.todayTokens += tokens;
      summary.todayMessages += messages;
      summary.todayTokenBreakdown.input += r.inputTokens;
      summary.todayTokenBreakdown.output += r.outputTokens;
      summary.todayTokenBreakdown.cacheRead += r.cacheReadTokens;
      summary.todayTokenBreakdown.cacheWrite += cacheWrite;
    }
    if (t >= weekStart) {
      summary.weekCost += r.costUSD;
      summary.weekTokens += tokens;
    }
    if (t >= monthStart) {
      summary.monthCost += r.costUSD;
      summary.monthTokens += tokens;
    }
    if (t >= yesterdayStart && t < todayStart) summary.yesterdayCost += r.costUSD;
    if (t >= prevWeekStart && t < weekStart) summary.prevWeekCost += r.costUSD;
    if (age > 7 * 24 * HOUR && age <= 14 * 24 * HOUR) summary.prevRolling7dCost += r.costUSD;
    if (t >= prevMonthStart && t < monthStart) summary.prevMonthCost += r.costUSD;
    if (t >= days30Start && t < todayStart) days30Cost += r.costUSD;

    if (age <= HOUR) {
      summary.lastHour.costUSD += r.costUSD;
      summary.lastHour.tokens += tokens;
    }
    if (age <= 5 * HOUR) {
      summary.lastFiveHours.costUSD += r.costUSD;
      summary.lastFiveHours.tokens += tokens;
    }
    if (age <= 7 * 24 * HOUR) {
      summary.lastSevenDays.costUSD += r.costUSD;
      summary.lastSevenDays.tokens += tokens;
    }
    if (summary.fiveHourWindow && win5Start !== null && t >= win5Start) {
      summary.fiveHourWindow.costUSD += r.costUSD;
      summary.fiveHourWindow.tokens += tokens;
    }
    if (summary.sevenDayWindow && win7Start !== null && t >= win7Start) {
      summary.sevenDayWindow.costUSD += r.costUSD;
      summary.sevenDayWindow.tokens += tokens;
    }

    if (r.fromSubagent) {
      summary.subagent.costUSD += r.costUSD;
      summary.subagent.tokens += tokens;
    }

    addToSeries(summary.series.hourly, hourlyB, t, r.costUSD, tokens, r.model);
    addToSeries(summary.series.daily, dailyB, t, r.costUSD, tokens, r.model);
    addToSeries(summary.series.weekly, weeklyB, t, r.costUSD, tokens, r.model);
    addToSeries(summary.series.monthly, monthlyB, t, r.costUSD, tokens, r.model);

    const calIdx = bucketIndex(calendarB, t);
    if (calIdx >= 0) {
      summary.calendar[calIdx].costUSD += r.costUSD;
      summary.calendar[calIdx].tokens += tokens;
    }

    let proj = projects.get(r.projectPath);
    if (!proj) {
      proj = {
        projectPath: r.projectPath,
        displayName: projectDisplayName(r.projectPath),
        sessionCount: 0,
        totalTokens: 0,
        costUSD: 0,
        todayCostUSD: 0,
        lastActivityMs: t,
        models: {},
        spark: Array(sparkB.length).fill(0),
      };
      projects.set(r.projectPath, proj);
    }
    proj.totalTokens += tokens;
    proj.costUSD += r.costUSD;
    if (t >= todayStart) proj.todayCostUSD += r.costUSD;
    const pm = proj.models[r.model] ?? (proj.models[r.model] = { costUSD: 0, tokens: 0 });
    pm.costUSD += r.costUSD;
    pm.tokens += tokens;
    if (t > proj.lastActivityMs) proj.lastActivityMs = t;
    const sparkIdx = bucketIndex(sparkB, t);
    if (sparkIdx >= 0) proj.spark[sparkIdx] += r.costUSD;

    let mod = models.get(r.model);
    if (!mod) {
      mod = {
        model: r.model,
        totalTokens: 0,
        costUSD: 0,
        requestCount: 0,
        breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        pricingSource: resolvePricing(r.model).source,
      };
      models.set(r.model, mod);
    }
    mod.totalTokens += tokens;
    mod.costUSD += r.costUSD;
    mod.requestCount++;
    mod.breakdown.input += r.inputTokens;
    mod.breakdown.output += r.outputTokens;
    mod.breakdown.cacheRead += r.cacheReadTokens;
    mod.breakdown.cacheWrite += cacheWrite;
    mod.costBreakdown.input += (r.inputTokens * pr.input) / M;
    mod.costBreakdown.output += (r.outputTokens * pr.output) / M;
    mod.costBreakdown.cacheRead += (r.cacheReadTokens * pr.cacheRead) / M;
    mod.costBreakdown.cacheWrite +=
      (r.cacheWrite5mTokens * pr.cacheWrite5m + r.cacheWrite1hTokens * pr.cacheWrite1h) / M;

    // Synthesized ledger residue has no session identity — skip the session
    // maps so it can't surface as a ghost session.
    if (r.sessionId) {
      let sess = sessions.get(r.sessionId);
      if (!sess) {
        sess = {
          sessionId: r.sessionId,
          displayName: projectDisplayName(r.projectPath),
          timestampMs: t,
          totalTokens: 0,
          costUSD: 0,
          model: r.model,
        };
        sessions.set(r.sessionId, sess);
        sessionProjects.set(r.sessionId, r.projectPath);
      }
      sess.totalTokens += tokens;
      sess.costUSD += r.costUSD;
      if (t >= sess.timestampMs) {
        sess.timestampMs = t;
        sess.model = r.model;
      }
    }
  }

  for (const [sessionId, projectPath] of sessionProjects) {
    const proj = projects.get(projectPath);
    if (proj && sessionId) proj.sessionCount++;
  }

  // Pace: month-to-date scaled by how far through the calendar month we are.
  const nextMonthStart = startOfMonth(new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth() + 1, 1).getTime());
  const monthFraction = (nowMs - monthStart) / (nextMonthStart - monthStart);
  summary.monthProjectedCost = monthFraction > 0 ? summary.monthCost / monthFraction : summary.monthCost;
  summary.avgDailyCost30 = days30Cost / 30;

  const daysWithUsage = new Set(dayCosts.keys());
  summary.streakDays = computeStreak(daysWithUsage, todayStart, false);
  summary.streakDaysNoWeekends = computeStreak(daysWithUsage, todayStart, true);
  summary.totalActiveDays = dayCosts.size;
  const sortedDays = [...dayCosts.keys()].sort((a, b) => a - b);
  summary.maxStreakDays = computeMaxStreak(sortedDays, false);
  summary.maxStreakDaysNoWeekends = computeMaxStreak(sortedDays, true);

  for (const [startMs, costUSD] of dayCosts) {
    if (!summary.maxDay || costUSD > summary.maxDay.costUSD) summary.maxDay = { startMs, costUSD };
  }
  for (const sess of sessions.values()) {
    if (!summary.maxSession || sess.costUSD > summary.maxSession.costUSD) {
      summary.maxSession = sess;
    }
  }

  summary.toolUsage = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  summary.byProject = [...projects.values()].sort((a, b) => b.costUSD - a.costUSD);
  summary.byModel = [...models.values()].sort((a, b) => b.costUSD - a.costUSD);
  summary.recentSessions = [...sessions.values()]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 20);

  return summary;
}
