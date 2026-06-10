import { describe, expect, it } from 'vitest';
import { computeCostUSD, DEFAULT_PRICING, pricingFor } from '../core/pricing';

describe('pricingFor', () => {
  it('matches dated model ids by prefix', () => {
    expect(pricingFor('claude-haiku-4-5-20251001').input).toBe(1);
    expect(pricingFor('claude-opus-4-5-20251101').input).toBe(5);
  });

  it('matches the repriced Opus 4.5+ tier before the legacy Opus 4 tier', () => {
    expect(pricingFor('claude-opus-4-8').input).toBe(5);
    expect(pricingFor('claude-opus-4-8').output).toBe(25);
    // Opus 4.0 / 4.1 stay on the original $15/$75 tier
    expect(pricingFor('claude-opus-4-1-20250805').input).toBe(15);
    expect(pricingFor('claude-opus-4-20250514').output).toBe(75);
  });

  it('prices the Fable tier', () => {
    const fable = pricingFor('claude-fable-5');
    expect(fable.input).toBe(10);
    expect(fable.output).toBe(50);
    expect(fable.cacheWrite1h).toBe(20);
    expect(fable.cacheRead).toBe(1);
  });

  it('falls back to Sonnet-tier pricing for unknown models', () => {
    expect(pricingFor('claude-future-9000')).toEqual(DEFAULT_PRICING);
    expect(pricingFor('unknown')).toEqual(DEFAULT_PRICING);
  });
});

describe('computeCostUSD', () => {
  it('sums all five token classes at the right rates', () => {
    // Opus 4.8: $5 in, $25 out, $6.25 cw5m, $10 cw1h, $0.50 cr per MTok
    const cost = computeCostUSD('claude-opus-4-8', 100, 200, 0, 500, 1000);
    const expected =
      (100 * 5) / 1e6 + (200 * 25) / 1e6 + (500 * 10) / 1e6 + (1000 * 0.5) / 1e6;
    expect(cost).toBeCloseTo(expected, 10);
  });
});
