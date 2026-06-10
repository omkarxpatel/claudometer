/** Builders for Claude Code JSONL lines, mirroring the real session format. */

export interface LineOptions {
  messageId?: string;
  model?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite1hTokens?: number;
  cacheWrite5mTokens?: number;
}

export function assistantLine(opts: LineOptions = {}): string {
  const {
    messageId = 'msg_001',
    model = 'claude-opus-4-8',
    sessionId = 'sess-1',
    cwd = '/Users/test/proj',
    timestamp = '2026-06-09T10:00:00.000Z',
    stopReason = 'end_turn',
    inputTokens = 100,
    outputTokens = 200,
    cacheReadTokens = 1000,
    cacheWrite1hTokens = 500,
    cacheWrite5mTokens = 0,
  } = opts;

  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId,
    cwd,
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    message: {
      id: messageId,
      model,
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheWrite1hTokens + cacheWrite5mTokens,
        cache_creation: {
          ephemeral_5m_input_tokens: cacheWrite5mTokens,
          ephemeral_1h_input_tokens: cacheWrite1hTokens,
        },
      },
    },
  });
}

export function userLine(): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-06-09T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  });
}
