/**
 * One billed API response, extracted from a Claude Code session JSONL file.
 * All timestamps are epoch milliseconds so the whole object is JSON-safe
 * (it round-trips through globalState and webview postMessage unchanged).
 */
export interface UsageRecord {
  timestampMs: number;
  sessionId: string;
  projectPath: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute-TTL cache writes, priced at 1.25× base input. */
  cacheWrite5mTokens: number;
  /** 1-hour-TTL cache writes, priced at 2× base input. Claude Code uses these. */
  cacheWrite1hTokens: number;
  costUSD: number;
  /** True for sidechain/subagent work (Task-tool transcripts). */
  fromSubagent?: boolean;
  /** Tool invocations in this message, keyed by tool name. */
  toolUses?: Record<string, number>;
  /** Synthesized ledger records stand in for many messages; parser leaves it unset (1). */
  messageCount?: number;
}

export function totalTokens(r: UsageRecord): number {
  return (
    r.inputTokens +
    r.outputTokens +
    r.cacheReadTokens +
    r.cacheWrite5mTokens +
    r.cacheWrite1hTokens
  );
}
