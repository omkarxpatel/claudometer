import { describe, expect, it } from 'vitest';
import { aggregate } from '../core/aggregate';
import { UsageRecord } from '../core/types';

// Fixed "now": a Tuesday at 15:00 local time, so day/week/month boundaries
// are unambiguous regardless of when the tests run.
const NOW = new Date(2026, 5, 9, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestampMs: NOW - HOUR,
    sessionId: 'sess-1',
    projectPath: '/Users/test/proj',
    model: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    costUSD: 1,
    ...overrides,
  };
}

describe('aggregate', () => {
  it('buckets costs into today / week / month / all-time', () => {
    const records = [
      record({ costUSD: 1 }), // 1h ago — today
      record({ costUSD: 2, timestampMs: NOW - 30 * HOUR, sessionId: 'sess-2' }), // Monday — this week
      record({ costUSD: 4, timestampMs: NOW - 40 * 24 * HOUR, sessionId: 'sess-3' }), // last month
    ];
    const s = aggregate(records, NOW);
    expect(s.todayCost).toBe(1);
    expect(s.weekCost).toBe(3);
    expect(s.allTimeCost).toBe(7);
    expect(s.todayMessages).toBe(1);
  });

  it('computes rolling windows by age', () => {
    const records = [
      record({ costUSD: 1, timestampMs: NOW - 0.5 * HOUR }),
      record({ costUSD: 2, timestampMs: NOW - 3 * HOUR }),
      record({ costUSD: 4, timestampMs: NOW - 26 * HOUR }),
    ];
    const s = aggregate(records, NOW);
    expect(s.lastHour.costUSD).toBe(1);
    expect(s.lastFiveHours.costUSD).toBe(3);
    expect(s.lastSevenDays.costUSD).toBe(7);
  });

  it('groups by project with session counts', () => {
    const records = [
      record({ sessionId: 'a' }),
      record({ sessionId: 'a' }),
      record({ sessionId: 'b' }),
      record({ sessionId: 'c', projectPath: '/Users/test/other', costUSD: 10 }),
    ];
    const s = aggregate(records, NOW);
    expect(s.byProject).toHaveLength(2);
    expect(s.byProject[0].projectPath).toBe('/Users/test/other'); // sorted by cost
    expect(s.byProject[1].sessionCount).toBe(2);
    expect(s.byProject[1].costUSD).toBe(3);
  });

  it('groups by model with request counts', () => {
    const records = [
      record(),
      record(),
      record({ model: 'claude-haiku-4-5', costUSD: 0.1 }),
    ];
    const s = aggregate(records, NOW);
    expect(s.byModel).toHaveLength(2);
    expect(s.byModel[0].model).toBe('claude-opus-4-8');
    expect(s.byModel[0].requestCount).toBe(2);
  });

  it('tags each model with its pricing source so fallbacks are visible', () => {
    const records = [record(), record({ model: 'claude-mystery-9', costUSD: 0.5 })];
    const s = aggregate(records, NOW);
    const bySource = Object.fromEntries(s.byModel.map((m) => [m.model, m.pricingSource]));
    expect(bySource['claude-opus-4-8']).toBe('bundled');
    expect(bySource['claude-mystery-9']).toBe('default');
  });

  it('lists recent sessions newest-first with summed costs', () => {
    const records = [
      record({ sessionId: 'old', timestampMs: NOW - 10 * HOUR }),
      record({ sessionId: 'new', timestampMs: NOW - HOUR, costUSD: 2 }),
      record({ sessionId: 'new', timestampMs: NOW - 2 * HOUR, costUSD: 3 }),
    ];
    const s = aggregate(records, NOW);
    expect(s.recentSessions[0].sessionId).toBe('new');
    expect(s.recentSessions[0].costUSD).toBe(5);
    expect(s.recentSessions[0].timestampMs).toBe(NOW - HOUR);
  });

  it('builds time-bucketed activity series', () => {
    const records = [
      record({ costUSD: 1, timestampMs: NOW - 30 * 60 * 1000 }), // 14:30 today
      record({ costUSD: 2, timestampMs: NOW - 30 * HOUR }), // 09:00 yesterday
    ];
    const s = aggregate(records, NOW);
    expect(s.series.hourly).toHaveLength(48);
    expect(s.series.daily).toHaveLength(30);
    expect(s.series.weekly).toHaveLength(12);
    expect(s.series.monthly).toHaveLength(12);

    expect(s.series.daily[29].costUSD).toBe(1); // today
    expect(s.series.daily[28].costUSD).toBe(2); // yesterday
    expect(s.series.daily.reduce((a, p) => a + p.costUSD, 0)).toBe(3);
    expect(s.series.monthly[11].costUSD).toBe(3); // both in the current month
    expect(s.series.hourly[46].costUSD).toBe(1); // the 14:00 bucket
  });

  it('computes streaks, with and without weekend exclusion', () => {
    // NOW is Tuesday Jun 9. Usage on Tue, Mon, and Friday Jun 5 — the weekend
    // gap breaks the plain streak but not the weekends-excluded one.
    const records = [
      record({ timestampMs: NOW - HOUR }), // Tue
      record({ timestampMs: NOW - 24 * HOUR }), // Mon
      record({ timestampMs: NOW - 4 * 24 * HOUR }), // Fri
    ];
    const s = aggregate(records, NOW);
    expect(s.streakDays).toBe(2);
    expect(s.streakDaysNoWeekends).toBe(3);
    expect(s.maxStreakDays).toBe(2);
    expect(s.maxStreakDaysNoWeekends).toBe(3);
    expect(s.totalActiveDays).toBe(3);
  });

  it('builds a Sunday-aligned 12-month contribution calendar', () => {
    const s = aggregate([record({ costUSD: 1 })], NOW);
    expect(s.calendar.length).toBeGreaterThanOrEqual(365);
    expect(new Date(s.calendar[0].startMs).getDay()).toBe(0); // Sunday
    const last = s.calendar[s.calendar.length - 1];
    expect(new Date(last.startMs).toDateString()).toBe(new Date(NOW).toDateString());
    expect(last.costUSD).toBe(1); // today's record lands in the last cell
  });

  it('projects the month from month-to-date pace', () => {
    const s = aggregate([record({ costUSD: 10 })], NOW);
    // Jun 9 15:00 is 207h into a 720h month.
    expect(s.monthProjectedCost).toBeCloseTo(10 * (720 / 207), 1);
    expect(s.yesterdayCost).toBe(0);
  });

  it('tracks records, subagent share, and per-class token costs', () => {
    const records = [
      record({ costUSD: 5, fromSubagent: true }),
      record({ costUSD: 1, sessionId: 'big', timestampMs: NOW - 26 * HOUR }),
    ];
    const s = aggregate(records, NOW);
    expect(s.subagent.costUSD).toBe(5);
    expect(s.subagent.tokens).toBe(300); // record fixture: 100 in + 200 out
    expect(s.maxSession!.costUSD).toBe(5);
    expect(s.maxDay!.costUSD).toBe(5);
    // Opus 4.8 rates over both records: 200 in × $5 + 400 out × $25 per MTok
    expect(s.tokenCostBreakdown.input).toBeCloseTo((200 * 5) / 1e6, 10);
    expect(s.tokenCostBreakdown.output).toBeCloseTo((400 * 25) / 1e6, 10);
    expect(s.tokenCostBreakdown.cacheRead).toBe(0);
  });

  it('tracks week/month token totals and per-project detail data', () => {
    const records = [record(), record({ model: 'claude-haiku-4-5' })];
    const s = aggregate(records, NOW);
    expect(s.weekTokens).toBe(600);
    expect(s.monthTokens).toBe(600);
    const proj = s.byProject[0];
    expect(proj.spark).toHaveLength(30);
    expect(proj.spark[29]).toBe(2); // both records today
    expect(proj.models['claude-opus-4-8'].costUSD).toBe(1);
    expect(proj.models['claude-haiku-4-5'].tokens).toBe(300);
    expect(proj.lastActivityMs).toBe(NOW - HOUR);
  });

  it('aggregates tool usage and honors synthesized message counts', () => {
    const records = [
      record({ toolUses: { Bash: 5, Edit: 2 } }),
      record({ toolUses: { Bash: 1 } }),
      // Ledger residue: many messages collapsed into one record, no session id
      record({ sessionId: '', messageCount: 40, costUSD: 9 }),
    ];
    const s = aggregate(records, NOW);
    expect(s.toolUsage[0]).toEqual({ name: 'Bash', count: 6 });
    expect(s.toolUsage[1]).toEqual({ name: 'Edit', count: 2 });
    expect(s.allTimeMessages).toBe(42);
    expect(s.todayMessages).toBe(42);
    // Residue must not surface as a ghost session
    expect(s.recentSessions.every((x) => x.sessionId !== '')).toBe(true);
    expect(s.maxSession!.sessionId).toBe('sess-1');
  });

  it('sums usage inside the live quota windows when provided', () => {
    const records = [
      record({ costUSD: 1, timestampMs: NOW - HOUR }), // inside the 5h window
      record({ costUSD: 2, timestampMs: NOW - 4 * HOUR }), // before the window started
    ];
    const s = aggregate(records, NOW, {
      fiveHourWindowStartMs: NOW - 3 * HOUR,
      sevenDayWindowStartMs: NOW - 6 * 24 * HOUR,
    });
    expect(s.fiveHourWindow!.costUSD).toBe(1);
    expect(s.fiveHourWindow!.tokens).toBe(300);
    expect(s.sevenDayWindow!.costUSD).toBe(3);
    // Without quota info the fields stay null
    expect(aggregate(records, NOW).fiveHourWindow).toBeNull();
  });

  it('tracks per-model token and cost breakdowns', () => {
    const records = [record(), record({ cacheReadTokens: 1000 })];
    const s = aggregate(records, NOW);
    const m = s.byModel[0];
    expect(m.breakdown.input).toBe(200);
    expect(m.breakdown.output).toBe(400);
    expect(m.breakdown.cacheRead).toBe(1000);
    // Opus 4.8: $5 in, $0.50 cache read per MTok
    expect(m.costBreakdown.input).toBeCloseTo((200 * 5) / 1e6, 10);
    expect(m.costBreakdown.cacheRead).toBeCloseTo((1000 * 0.5) / 1e6, 10);
  });

  it('handles an empty record set', () => {
    const s = aggregate([], NOW);
    expect(s.allTimeCost).toBe(0);
    expect(s.byProject).toHaveLength(0);
    expect(s.recentSessions).toHaveLength(0);
  });
});
