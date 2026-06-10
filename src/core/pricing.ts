/**
 * Published Anthropic per-million-token prices (USD), current as of June 2026.
 *
 * Cache tiers follow the standard multipliers: 5m writes = 1.25× input,
 * 1h writes = 2× input, reads = 0.1× input.
 *
 * Matching is by prefix against the model id found in the JSONL, so dated
 * ids like `claude-haiku-4-5-20251001` resolve correctly. More specific
 * prefixes MUST come before broader ones (e.g. `claude-opus-4-5` before
 * `claude-opus-4`, which catches the older $15/$75 Opus 4.0/4.1 tier).
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const p = (
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number
): ModelPricing => ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });

export const PRICING_TABLE: ReadonlyArray<readonly [string, ModelPricing]> = [
  // Fable tier
  ['claude-fable-5', p(10, 50, 12.5, 20, 1.0)],
  // Opus 4.5+ ($5/$25 tier) — must precede the bare 'claude-opus-4' prefix
  ['claude-opus-4-5', p(5, 25, 6.25, 10, 0.5)],
  ['claude-opus-4-6', p(5, 25, 6.25, 10, 0.5)],
  ['claude-opus-4-7', p(5, 25, 6.25, 10, 0.5)],
  ['claude-opus-4-8', p(5, 25, 6.25, 10, 0.5)],
  // Opus 4.0 / 4.1 — original $15/$75 tier
  ['claude-opus-4', p(15, 75, 18.75, 30, 1.5)],
  // Sonnet 4.x
  ['claude-sonnet-4', p(3, 15, 3.75, 6, 0.3)],
  // Haiku 4.x
  ['claude-haiku-4', p(1, 5, 1.25, 2, 0.1)],
  // Claude 3.x legacy
  ['claude-haiku-3-5', p(0.8, 4, 1.0, 1.6, 0.08)],
  ['claude-3-5-haiku', p(0.8, 4, 1.0, 1.6, 0.08)],
  ['claude-3-opus', p(15, 75, 18.75, 30, 1.5)],
  ['claude-3-7-sonnet', p(3, 15, 3.75, 6, 0.3)],
  ['claude-3-5-sonnet', p(3, 15, 3.75, 6, 0.3)],
  ['claude-3-sonnet', p(3, 15, 3.75, 6, 0.3)],
  ['claude-3-haiku', p(0.25, 1.25, 0.3125, 0.5, 0.025)],
];

/** Unknown models fall back to Sonnet-tier pricing. */
export const DEFAULT_PRICING: ModelPricing = p(3, 15, 3.75, 6, 0.3);

/** Where a model's effective pricing came from, in precedence order. */
export type PricingSource = 'override' | 'live' | 'bundled' | 'default';

/**
 * Live pricing fetched at runtime (see data/livePricing.ts). When present it
 * takes precedence over the bundled table, so new models are priced correctly
 * without a code change. The bundled table remains the offline fallback.
 */
let liveTable: Readonly<Record<string, ModelPricing>> | null = null;

/**
 * User-defined overrides from the `claudometer.pricing.overrides` setting.
 * Highest precedence; partial — unset fields keep their base value. Lets the
 * user price a model the catalogs don't know yet.
 */
let overrideTable: Readonly<Record<string, Partial<ModelPricing>>> | null = null;

export function setLivePricing(table: Record<string, ModelPricing> | null): void {
  liveTable = table;
}

export function setPricingOverrides(
  table: Record<string, Partial<ModelPricing>> | null
): void {
  overrideTable = table && Object.keys(table).length > 0 ? table : null;
}

export function pricingSource(): 'live' | 'bundled' {
  return liveTable ? 'live' : 'bundled';
}

/**
 * Exact match first, then longest prefix — covers dated ids
 * (claude-opus-4-7-20260416) and suffixed variants (claude-fable-5[1m]).
 */
function longestPrefixMatch<T>(table: Readonly<Record<string, T>>, model: string): T | undefined {
  if (table[model] !== undefined) return table[model];
  let best: T | undefined;
  let bestLen = 0;
  for (const key of Object.keys(table)) {
    if (key.length > bestLen && model.startsWith(key)) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

/** Keep only valid, non-negative numbers from a user-supplied partial override. */
function sanitizeOverride(o: Partial<ModelPricing>): Partial<ModelPricing> {
  const out: Partial<ModelPricing> = {};
  for (const key of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

export function resolvePricing(model: string): { pricing: ModelPricing; source: PricingSource } {
  let pricing: ModelPricing | undefined;
  let source: PricingSource = 'default';

  if (liveTable) {
    const hit = longestPrefixMatch(liveTable, model);
    if (hit) {
      pricing = hit;
      source = 'live';
    }
  }
  if (!pricing) {
    for (const [prefix, p] of PRICING_TABLE) {
      if (model.startsWith(prefix)) {
        pricing = p;
        source = 'bundled';
        break;
      }
    }
  }
  if (!pricing) pricing = DEFAULT_PRICING;

  if (overrideTable) {
    const o = longestPrefixMatch(overrideTable, model);
    if (o) {
      pricing = { ...pricing, ...sanitizeOverride(o) };
      source = 'override';
    }
  }
  return { pricing, source };
}

export function pricingFor(model: string): ModelPricing {
  return resolvePricing(model).pricing;
}

/**
 * Every model id worth showing on the settings page: the live catalog,
 * user overrides, and any models actually seen in usage — each resolved to
 * its effective pricing and source.
 */
export function pricingCatalog(
  usedModels: string[] = []
): Array<{ model: string; pricing: ModelPricing; source: PricingSource }> {
  const ids = new Set<string>(usedModels);
  if (liveTable) for (const key of Object.keys(liveTable)) ids.add(key);
  if (overrideTable) for (const key of Object.keys(overrideTable)) ids.add(key);
  if (ids.size === 0) for (const [prefix] of PRICING_TABLE) ids.add(prefix);
  return [...ids].sort().map((model) => ({ model, ...resolvePricing(model) }));
}

export function computeCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWrite5mTokens: number,
  cacheWrite1hTokens: number,
  cacheReadTokens: number
): number {
  const pr = pricingFor(model);
  const M = 1_000_000;
  return (
    (inputTokens * pr.input) / M +
    (outputTokens * pr.output) / M +
    (cacheWrite5mTokens * pr.cacheWrite5m) / M +
    (cacheWrite1hTokens * pr.cacheWrite1h) / M +
    (cacheReadTokens * pr.cacheRead) / M
  );
}
