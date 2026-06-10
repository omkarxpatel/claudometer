/**
 * Quota burn forecasting. The store records a utilization snapshot on each
 * successful quota probe; a simple linear fit over the recent snapshots
 * answers "at this pace, when do I max out?". Only ETAs that land before the
 * window's own reset are reported — running out *after* the reset means never.
 */
export interface QuotaSnapshot {
  t: number;
  five: number;
  seven: number;
}

export interface QuotaForecast {
  fiveHourEtaMs: number | null;
  sevenDayEtaMs: number | null;
  weekly: WeeklyPace | null;
}

/** Weekday-aware projection for the 7-day window. */
export interface WeeklyPace {
  /** Estimated utilization when the window resets (1.0 = limit). */
  projectedUtilization: number;
  /** When usage is projected to hit the limit, if before the reset. */
  runsOutAtMs: number | null;
  level: 'ok' | 'tight' | 'risk';
  /** False while history is too thin and a flat daily average was used. */
  usedWeekdayProfile: boolean;
}

/** Structural subset of CalendarDay, so core modules stay decoupled. */
interface DayCost {
  startMs: number;
  costUSD: number;
}

/** Structural subset of QuotaData, so core stays free of data-layer imports. */
interface QuotaLike {
  fiveHourUtilization: number;
  fiveHourResetAtMs: number;
  sevenDayUtilization: number;
  sevenDayResetAtMs: number;
}

const SNAPSHOT_MIN_INTERVAL_MS = 120_000;
const SNAPSHOT_CAP = 2016; // a week at the minimum interval

export function appendSnapshot(history: QuotaSnapshot[], snap: QuotaSnapshot): QuotaSnapshot[] {
  const last = history[history.length - 1];
  if (last && snap.t - last.t < SNAPSHOT_MIN_INTERVAL_MS) return history;
  const next = [...history, snap];
  return next.length > SNAPSHOT_CAP ? next.slice(next.length - SNAPSHOT_CAP) : next;
}

function eta(
  history: QuotaSnapshot[],
  nowMs: number,
  field: 'five' | 'seven',
  current: number,
  resetAtMs: number,
  lookbackMs: number
): number | null {
  if (current >= 1 || current <= 0) return null;
  const cutoff = nowMs - lookbackMs;
  // Utilization only rises within a window; snapshots above the current value
  // belong to a previous window and would corrupt the slope.
  const pts = history.filter((s) => s.t >= cutoff && s[field] <= current + 0.001);
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const du = last[field] - first[field];
  const dt = last.t - first.t;
  if (dt <= 0 || du < 0.01) return null; // flat — no meaningful pace
  const slope = du / dt;
  const etaMs = nowMs + (1 - current) / slope;
  return etaMs < resetAtMs ? etaMs : null;
}

export function forecastQuota(
  history: QuotaSnapshot[],
  nowMs: number,
  quota: QuotaLike | null,
  pace?: { calendar: DayCost[]; windowCostUSD: number }
): QuotaForecast {
  if (!quota) return { fiveHourEtaMs: null, sevenDayEtaMs: null, weekly: null };
  return {
    fiveHourEtaMs: eta(
      history,
      nowMs,
      'five',
      quota.fiveHourUtilization,
      quota.fiveHourResetAtMs,
      45 * 60_000
    ),
    sevenDayEtaMs: eta(
      history,
      nowMs,
      'seven',
      quota.sevenDayUtilization,
      quota.sevenDayResetAtMs,
      12 * 3_600_000
    ),
    weekly: pace
      ? forecastSevenDayPace({
          calendar: pace.calendar,
          windowCostUSD: pace.windowCostUSD,
          nowMs,
          utilization: quota.sevenDayUtilization,
          resetAtMs: quota.sevenDayResetAtMs,
        })
      : null,
  };
}

function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDaysMs(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Weekday-aware 7d pace projection.
 *
 * Calibration: the rate-limit headers give utilization (%) and the local scan
 * gives the cost poured into the same window, so `windowCost / utilization`
 * estimates what 100% of *this* plan costs — no published limits needed.
 * Demand: expected cost for each remaining day of the window comes from the
 * user's average for that day-of-week (last 8 occurrences), so a dead-quiet
 * Sunday is projected as a dead-quiet Sunday. Falls back to a flat daily
 * average until at least two weeks / seven active days of history exist.
 */
export function forecastSevenDayPace(args: {
  calendar: DayCost[];
  nowMs: number;
  utilization: number;
  resetAtMs: number;
  windowCostUSD: number;
}): WeeklyPace | null {
  const { calendar, nowMs, utilization, resetAtMs, windowCostUSD } = args;
  // Below ~2% the calibration divides by noise; with no reset ahead there is
  // nothing to project.
  if (!(utilization >= 0.02) || !(windowCostUSD > 0) || resetAtMs <= nowMs) return null;
  if (!calendar || calendar.length === 0) return null;

  const fullQuotaCost = windowCostUSD / utilization;
  const todayStart = startOfDayMs(nowMs);

  const firstActive = calendar.find((d) => d.costUSD > 0);
  if (!firstActive) return null;
  const history = calendar.filter(
    (d) => d.startMs >= firstActive.startMs && d.startMs < todayStart
  );
  const activeDays = history.filter((d) => d.costUSD > 0).length;
  const usedWeekdayProfile = history.length >= 14 && activeDays >= 7;

  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  for (const d of history) byDow[new Date(d.startMs).getDay()].push(d.costUSD);
  const avgByDow = byDow.map((arr) => {
    const recent = arr.slice(-8);
    return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  });
  const overallAvg = history.length
    ? history.reduce((a, d) => a + d.costUSD, 0) / history.length
    : 0;
  const expectedFor = (dayStartMs: number) =>
    usedWeekdayProfile ? avgByDow[new Date(dayStartMs).getDay()] : overallAvg;

  const last = calendar[calendar.length - 1];
  const todayCostSoFar = last && last.startMs === todayStart ? last.costUSD : 0;

  let projectedCost = windowCostUSD;
  let runsOutAtMs: number | null = null;

  // Walk each (partial) day from now to the reset, spending the expected cost
  // uniformly across it to locate a potential crossing point.
  let cursor = nowMs;
  let dayStart = todayStart;
  while (cursor < resetAtMs) {
    const nextDay = addDaysMs(dayStart, 1);
    const segmentEnd = Math.min(nextDay, resetAtMs);
    const dayExpected =
      dayStart === todayStart
        ? Math.max(expectedFor(dayStart) - todayCostSoFar, 0)
        : expectedFor(dayStart);
    const segmentExpected = dayExpected * ((segmentEnd - cursor) / (nextDay - cursor));

    if (runsOutAtMs === null && segmentExpected > 0 && projectedCost + segmentExpected >= fullQuotaCost) {
      const need = fullQuotaCost - projectedCost;
      runsOutAtMs = cursor + (segmentEnd - cursor) * (need / segmentExpected);
    }
    projectedCost += segmentExpected;
    cursor = segmentEnd;
    dayStart = nextDay;
  }

  const projectedUtilization = projectedCost / fullQuotaCost;
  const level: WeeklyPace['level'] =
    projectedUtilization >= 1 ? 'risk' : projectedUtilization >= 0.85 ? 'tight' : 'ok';
  return {
    projectedUtilization,
    runsOutAtMs: level === 'risk' ? runsOutAtMs : null,
    level,
    usedWeekdayProfile,
  };
}
