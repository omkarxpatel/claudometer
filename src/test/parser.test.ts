import { describe, expect, it } from 'vitest';
import { parseUsageLine } from '../core/parser';
import { assistantLine, userLine } from './fixtures';

const FALLBACK = '/fallback/project';

describe('parseUsageLine', () => {
  it('parses a final assistant message into a usage record', () => {
    const parsed = parseUsageLine(assistantLine(), FALLBACK);
    expect(parsed).not.toBeNull();
    expect(parsed!.messageId).toBe('msg_001');
    const r = parsed!.record;
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.sessionId).toBe('sess-1');
    expect(r.projectPath).toBe('/Users/test/proj');
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(200);
    expect(r.cacheReadTokens).toBe(1000);
    expect(r.cacheWrite1hTokens).toBe(500);
    expect(r.cacheWrite5mTokens).toBe(0);
    expect(r.timestampMs).toBe(Date.parse('2026-06-09T10:00:00.000Z'));
    // 100×$5 + 200×$25 + 500×$10 + 1000×$0.50 per MTok
    expect(r.costUSD).toBeCloseTo(0.011, 10);
  });

  it('skips streaming intermediates (stop_reason null)', () => {
    expect(parseUsageLine(assistantLine({ stopReason: null }), FALLBACK)).toBeNull();
  });

  it('skips non-assistant lines', () => {
    expect(parseUsageLine(userLine(), FALLBACK)).toBeNull();
  });

  it('skips malformed lines without throwing', () => {
    expect(parseUsageLine('{not json', FALLBACK)).toBeNull();
    expect(parseUsageLine('', FALLBACK)).toBeNull();
  });

  it('skips zero-token entries', () => {
    const line = assistantLine({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite1hTokens: 0,
      cacheWrite5mTokens: 0,
    });
    expect(parseUsageLine(line, FALLBACK)).toBeNull();
  });

  it('uses the fallback project path when cwd is absent', () => {
    const obj = JSON.parse(assistantLine());
    delete obj.cwd;
    const parsed = parseUsageLine(JSON.stringify(obj), FALLBACK);
    expect(parsed!.record.projectPath).toBe(FALLBACK);
  });

  it('counts tool_use blocks by tool name', () => {
    const obj = JSON.parse(assistantLine());
    obj.message.content = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
      { type: 'tool_use', id: 't3', name: 'Edit', input: {} },
    ];
    const parsed = parseUsageLine(JSON.stringify(obj), FALLBACK);
    expect(parsed!.record.toolUses).toEqual({ Bash: 2, Edit: 1 });
    // No tool blocks → field stays unset
    expect(parseUsageLine(assistantLine(), FALLBACK)!.record.toolUses).toBeUndefined();
  });

  it('tags sidechain (subagent) lines', () => {
    const obj = JSON.parse(assistantLine());
    obj.isSidechain = true;
    expect(parseUsageLine(JSON.stringify(obj), FALLBACK)!.record.fromSubagent).toBe(true);
    expect(parseUsageLine(assistantLine(), FALLBACK)!.record.fromSubagent).toBe(false);
  });

  it('falls back to cache_creation_input_tokens (1h tier) when the split object is absent', () => {
    const obj = JSON.parse(assistantLine({ cacheWrite1hTokens: 700 }));
    delete obj.message.usage.cache_creation;
    const parsed = parseUsageLine(JSON.stringify(obj), FALLBACK);
    expect(parsed!.record.cacheWrite1hTokens).toBe(700);
    expect(parsed!.record.cacheWrite5mTokens).toBe(0);
  });
});
