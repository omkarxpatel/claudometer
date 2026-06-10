import { afterEach, describe, expect, it } from 'vitest';
import { pricingFor, setLivePricing } from '../core/pricing';
import { parseModelsDevPricing } from '../data/livePricing';

// Shape mirrors https://models.dev/api.json
const payload = {
  anthropic: {
    models: {
      'claude-fable-5': {
        name: 'Claude Fable 5',
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      },
      'claude-opus-4-8': {
        name: 'Claude Opus 4.8',
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'claude-hypothetical-6': {
        name: 'No cache fields listed',
        cost: { input: 4, output: 20 },
      },
      'claude-broken': { name: 'No cost at all' },
    },
  },
  openai: { models: { 'gpt-x': { cost: { input: 1, output: 2 } } } },
};

afterEach(() => setLivePricing(null));

describe('parseModelsDevPricing', () => {
  it('maps cost fields and derives the 1h cache-write tier as 2× input', () => {
    const table = parseModelsDevPricing(payload)!;
    expect(table['claude-fable-5']).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    });
    expect(table['claude-opus-4-8'].cacheWrite1h).toBe(10);
  });

  it('derives missing cache fields from standard multipliers', () => {
    const table = parseModelsDevPricing(payload)!;
    expect(table['claude-hypothetical-6']).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.4, // 0.1× input
      cacheWrite5m: 5, // 1.25× input
      cacheWrite1h: 8, // 2× input
    });
  });

  it('skips entries without usable costs and ignores other providers', () => {
    const table = parseModelsDevPricing(payload)!;
    expect(table['claude-broken']).toBeUndefined();
    expect(table['gpt-x']).toBeUndefined();
  });

  it('returns null for malformed payloads', () => {
    expect(parseModelsDevPricing(null)).toBeNull();
    expect(parseModelsDevPricing({})).toBeNull();
    expect(parseModelsDevPricing({ anthropic: { models: {} } })).toBeNull();
  });
});

describe('pricingFor with a live table', () => {
  it('prefers live pricing over the bundled table', () => {
    setLivePricing({
      'claude-opus-4-8': {
        input: 99, // deliberately different from bundled to prove precedence
        output: 1,
        cacheRead: 1,
        cacheWrite5m: 1,
        cacheWrite1h: 1,
      },
    });
    expect(pricingFor('claude-opus-4-8').input).toBe(99);
  });

  it('resolves dated and suffixed ids by longest prefix', () => {
    const table = parseModelsDevPricing(payload)!;
    setLivePricing(table);
    expect(pricingFor('claude-fable-5[1m]').input).toBe(10);
    expect(pricingFor('claude-opus-4-8-20260801').output).toBe(25);
  });

  it('falls back to the bundled table for models absent from the live table', () => {
    setLivePricing(parseModelsDevPricing(payload));
    expect(pricingFor('claude-opus-4-1-20250805').input).toBe(15); // bundled legacy tier
  });

  it('reverts to bundled rates when live pricing is cleared', () => {
    setLivePricing({
      'claude-opus-4-8': { input: 99, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
    });
    setLivePricing(null);
    expect(pricingFor('claude-opus-4-8').input).toBe(5);
  });
});
