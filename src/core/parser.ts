import { computeCostUSD } from './pricing';
import { UsageRecord } from './types';

export interface ParsedUsageLine {
  /** Anthropic message id, used to dedup repeated writes of the same response. */
  messageId: string;
  record: UsageRecord;
}

/**
 * Parse one JSONL line from a Claude Code session file into a usage record.
 *
 * Returns null for anything that isn't a billed, final assistant message:
 * - non-assistant entries (user turns, tool results, summaries, …)
 * - streaming intermediates (stop_reason is null until the final chunk)
 * - zero-token entries and malformed lines
 *
 * Dedup is the caller's job: Claude Code appends the same final message
 * under multiple outer UUIDs, so callers must drop repeated messageIds.
 */
export function parseUsageLine(
  line: string,
  fallbackProjectPath: string
): ParsedUsageLine | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj?.type !== 'assistant') return null;
  const msg = obj.message;
  const usage = msg?.usage;
  if (!usage) return null;
  if (msg.stop_reason === null || msg.stop_reason === undefined) return null;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  // Cache writes are split by TTL tier when the cache_creation sub-object is
  // present; older JSONL versions only carry the 1h total in
  // cache_creation_input_tokens.
  const cc = usage.cache_creation ?? {};
  const cacheWrite5mTokens: number = cc.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite1hTokens: number =
    cc.ephemeral_1h_input_tokens ?? usage.cache_creation_input_tokens ?? 0;

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWrite5mTokens === 0 &&
    cacheWrite1hTokens === 0
  ) {
    return null;
  }

  const model: string = msg.model ?? 'unknown';
  const timestampMs = obj.timestamp ? Date.parse(obj.timestamp) : Date.now();

  let toolUses: Record<string, number> | undefined;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        toolUses ??= {};
        toolUses[block.name] = (toolUses[block.name] ?? 0) + 1;
      }
    }
  }

  return {
    messageId: msg.id ?? '',
    record: {
      timestampMs: Number.isNaN(timestampMs) ? Date.now() : timestampMs,
      sessionId: obj.sessionId ?? '',
      projectPath: obj.cwd ?? fallbackProjectPath,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      fromSubagent: obj.isSidechain === true,
      ...(toolUses ? { toolUses } : {}),
      costUSD: computeCostUSD(
        model,
        inputTokens,
        outputTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
        cacheReadTokens
      ),
    },
  };
}
