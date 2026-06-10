import * as https from 'https';
import { ModelPricing } from '../core/pricing';

/**
 * Community-maintained model catalog (github.com/sst/models.dev). Prices are
 * USD per million tokens. Chosen over LiteLLM's price file because it picks
 * up brand-new Anthropic models faster (it carried Fable 5 before LiteLLM)
 * and ships a compact, stable schema. This is a public, anonymous GET — no
 * user data is sent.
 */
export const PRICING_SOURCE_URL = 'https://models.dev/api.json';

/**
 * Extract Anthropic model pricing from a models.dev api.json payload.
 * Exported separately from the fetch so it can be unit-tested offline.
 */
export function parseModelsDevPricing(json: unknown): Record<string, ModelPricing> | null {
  const models = (json as any)?.anthropic?.models;
  if (!models || typeof models !== 'object') return null;

  const out: Record<string, ModelPricing> = {};
  for (const [id, entry] of Object.entries<any>(models)) {
    const cost = entry?.cost;
    if (typeof cost?.input !== 'number' || typeof cost?.output !== 'number') continue;
    out[id] = {
      input: cost.input,
      output: cost.output,
      cacheRead: typeof cost.cache_read === 'number' ? cost.cache_read : cost.input * 0.1,
      // models.dev's cache_write is the 5-minute tier.
      cacheWrite5m:
        typeof cost.cache_write === 'number' ? cost.cache_write : cost.input * 1.25,
      // The 1-hour tier isn't listed; it is uniformly 2× base input across
      // Anthropic's published pricing.
      cacheWrite1h: cost.input * 2,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function fetchLivePricing(): Promise<Record<string, ModelPricing> | null> {
  return new Promise((resolve) => {
    const req = https.get(PRICING_SOURCE_URL, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(parseModelsDevPricing(JSON.parse(body)));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}
