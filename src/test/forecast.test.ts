import { describe, expect, it } from 'vitest';
import {
  appendSnapshot,
  forecastQuota,
  forecastSevenDayPace,
  QuotaSnapshot,
} from '../core/forecast';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function quota(five: number, resetInMs: number) {
  return {
    fiveHourUtilization: five,
    fiveHourResetAtMs: NOW + resetInMs,
    sevenDayUtilization: 0.1,
    sevenDayResetAtMs: NOW + 6 * 24 * 3_600_000,
  };
}

/** Snapshots rising linearly to `current` over the last `span`. */
function risingHistory(current: number, perMinute: number, points = 10): QuotaSnapshot[] {
  const out: QuotaSnapshot[] = [];
  for (let i = points - 1; i >= 0; i--) {
    out.push({ t: NOW - i * 3 * MIN, five: current - i * 3 * perMinute, seven: 0.1 });
  }
  return out;
}

describe('forecastQuota', () => {
  it('projects when the window maxes out at the current pace', () => {
    // +1%/min, currently at 60% → 40 minutes to max
    const history = risingHistory(0.6, 0.01);
    const f = forecastQuota(history, NOW, quota(0.6, 3 * 3_600_000));
    expect(f.fiveHourEtaMs).not.toBeNull();
    expect(f.fiveHourEtaMs! - NOW).toBeCloseTo(40 * MIN, -5); // within ~100s
  });

  it('returns null when usage is flat', () => {
    const history = risingHistory(0.6, 0.00001);
    expect(forecastQuota(history, NOW, quota(0.6, 3 * 3_600_000)).fiveHourEtaMs).toBeNull();
  });

  it('returns null when the window resets before the projected max', () => {
    // +1%/min at 60% → maxes in 40m, but the window resets in 10m
    const history = risingHistory(0.6, 0.01);
    expect(forecastQuota(history, NOW, quota(0.6, 10 * MIN)).fiveHourEtaMs).toBeNull();
  });

  it('ignores snapshots from a previous window', () => {
    // History shows 90% (old window), current is 20% — stale points must not
    // produce a negative/garbage slope.
    const history: QuotaSnapshot[] = [
      { t: NOW - 30 * MIN, five: 0.9, seven: 0.1 },
      { t: NOW - 20 * MIN, five: 0.95, seven: 0.1 },
      { t: NOW - 10 * MIN, five: 0.1, seven: 0.1 },
      { t: NOW - 5 * MIN, five: 0.15, seven: 0.1 },
    ];
    const f = forecastQuota(history, NOW, quota(0.2, 4 * 3_600_000));
    // Only the two fresh points survive the filter — below the 3-point minimum.
    expect(f.fiveHourEtaMs).toBeNull();
  });

  it('returns nulls without quota data', () => {
    expect(forecastQuota([], NOW, null)).toEqual({
      fiveHourEtaMs: null,
      sevenDayEtaMs: null,
      weekly: null,
    });
  });
});

describe('forecastSevenDayPace', () => {
  // Tuesday Jun 9 2026, 15:00 local — same anchor as the aggregate tests.
  const TUE = new Date(2026, 5, 9, 15, 0, 0).getTime();
  const DAY = 24 * 3_600_000;

  function addDays(ms: number, n: number): number {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  /** 5 weeks of history: weekdays $20/day, Sat $2, Sun $0; today partial. */
  function calendar(todayCost: number) {
    const todayStart = new Date(2026, 5, 9).getTime();
    const out = [];
    for (let k = 35; k >= 0; k--) {
      const startMs = addDays(todayStart, -k);
      const dow = new Date(startMs).getDay();
      const costUSD = k === 0 ? todayCost : dow === 0 ? 0 : dow === 6 ? 2 : 20;
      out.push({ startMs, costUSD });
    }
    return out;
  }

  it('projects end-of-window utilization from the weekday profile', () => {
    // $80 spent = 50% → full quota ≈ $160. Reset tomorrow (Wed) 15:00.
    // Expected demand: rest of today max(20−10,0)=10, Wed 15/24×20=12.5.
    const pace = forecastSevenDayPace({
      calendar: calendar(10),
      nowMs: TUE,
      utilization: 0.5,
      resetAtMs: TUE + DAY,
      windowCostUSD: 80,
    })!;
    expect(pace.usedWeekdayProfile).toBe(true);
    expect(pace.projectedUtilization).toBeCloseTo((80 + 10 + 12.5) / 160, 3);
    expect(pace.level).toBe('ok');
    expect(pace.runsOutAtMs).toBeNull();
  });

  it('treats quiet weekends as quiet and finds the run-out day', () => {
    // $90 spent = 60% → full quota $150, $60 headroom. Reset Monday 15:00.
    // Demand: today 10, Wed 20, Thu 20, Fri 20, Sat 2, Sun 0, Mon 12.5.
    // Cumulative crosses $60 halfway through Friday — the weekend's near-zero
    // expected usage never enters the picture.
    const pace = forecastSevenDayPace({
      calendar: calendar(10),
      nowMs: TUE,
      utilization: 0.6,
      resetAtMs: TUE + 6 * DAY,
      windowCostUSD: 90,
    })!;
    expect(pace.level).toBe('risk');
    expect(pace.projectedUtilization).toBeCloseTo((90 + 84.5) / 150, 3);
    expect(new Date(pace.runsOutAtMs!).getDay()).toBe(5); // Friday
    expect(new Date(pace.runsOutAtMs!).getHours()).toBe(12); // mid-day
  });

  it('falls back to a flat average until history is deep enough', () => {
    const thin = calendar(10).slice(-6); // five history days + today
    const pace = forecastSevenDayPace({
      calendar: thin,
      nowMs: TUE,
      utilization: 0.5,
      resetAtMs: TUE + DAY,
      windowCostUSD: 80,
    })!;
    expect(pace.usedWeekdayProfile).toBe(false);
  });

  it('returns null when the signal is too weak to calibrate', () => {
    expect(
      forecastSevenDayPace({
        calendar: calendar(10),
        nowMs: TUE,
        utilization: 0.01,
        resetAtMs: TUE + DAY,
        windowCostUSD: 1,
      })
    ).toBeNull();
    expect(
      forecastSevenDayPace({
        calendar: calendar(10),
        nowMs: TUE,
        utilization: 0.5,
        resetAtMs: TUE - 1, // already reset
        windowCostUSD: 80,
      })
    ).toBeNull();
  });
});

describe('appendSnapshot', () => {
  it('throttles snapshots closer than the minimum interval', () => {
    let history: QuotaSnapshot[] = [];
    history = appendSnapshot(history, { t: NOW, five: 0.1, seven: 0.1 });
    const throttled = appendSnapshot(history, { t: NOW + 30_000, five: 0.2, seven: 0.1 });
    expect(throttled).toBe(history); // unchanged reference
    const accepted = appendSnapshot(history, { t: NOW + 3 * MIN, five: 0.2, seven: 0.1 });
    expect(accepted).toHaveLength(2);
  });

  it('caps history length', () => {
    let history: QuotaSnapshot[] = [];
    for (let i = 0; i < 2100; i++) {
      history = appendSnapshot(history, { t: NOW + i * 3 * MIN, five: 0.5, seven: 0.1 });
    }
    expect(history.length).toBeLessThanOrEqual(2016);
  });
});
