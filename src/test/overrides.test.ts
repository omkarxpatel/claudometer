import { afterEach, describe, expect, it } from 'vitest';
import {
  pricingCatalog,
  pricingFor,
  resolvePricing,
  setLivePricing,
  setPricingOverrides,
} from '../core/pricing';

afterEach(() => {
  setLivePricing(null);
  setPricingOverrides(null);
});

describe('pricing overrides', () => {
  it('takes precedence over live and bundled pricing', () => {
    setLivePricing({
      'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    });
    setPricingOverrides({ 'claude-opus-4-8': { input: 7 } });
    const { pricing, source } = resolvePricing('claude-opus-4-8');
    expect(source).toBe('override');
    expect(pricing.input).toBe(7);
    expect(pricing.output).toBe(25); // unset fields keep the base value
  });

  it('matches override keys by prefix, covering unknown future models', () => {
    setPricingOverrides({
      'claude-omega-7': { input: 12, output: 60, cacheRead: 1.2, cacheWrite5m: 15, cacheWrite1h: 24 },
    });
    expect(pricingFor('claude-omega-7-20270101').input).toBe(12);
    expect(resolvePricing('claude-omega-7[1m]').source).toBe('override');
  });

  it('ignores invalid values in an override', () => {
    setPricingOverrides({ 'claude-opus-4-8': { input: -5, output: Number.NaN } as any });
    const { pricing } = resolvePricing('claude-opus-4-8');
    expect(pricing.input).toBe(5); // bundled value retained
    expect(pricing.output).toBe(25);
  });

  it('reports default source for fully unknown models', () => {
    expect(resolvePricing('claude-mystery-1').source).toBe('default');
  });
});

describe('pricingCatalog', () => {
  it('unions live, override, and used models with resolved sources', () => {
    setLivePricing({
      'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    });
    setPricingOverrides({ 'claude-omega-7': { input: 12 } });
    const catalog = pricingCatalog(['claude-opus-4-1-20250805']);
    const byModel = Object.fromEntries(catalog.map((c) => [c.model, c.source]));
    expect(byModel['claude-opus-4-8']).toBe('live');
    expect(byModel['claude-omega-7']).toBe('override');
    expect(byModel['claude-opus-4-1-20250805']).toBe('bundled');
  });

  it('falls back to bundled prefixes when nothing else is known', () => {
    const catalog = pricingCatalog();
    expect(catalog.length).toBeGreaterThan(5);
    expect(catalog.every((c) => c.source === 'bundled')).toBe(true);
  });
});
