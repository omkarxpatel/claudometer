import { describe, expect, it } from 'vitest';
import {
  emptyLedger,
  groupRecords,
  ledgerKey,
  ledgerToCsv,
  ledgerToJson,
  mergeIntoLedger,
  residueRecords,
  rowsFromExportJson,
} from '../core/ledger';
import { UsageRecord } from '../core/types';

const DAY = new Date(2026, 5, 1, 0, 0, 0).getTime(); // Jun 1 local

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestampMs: DAY + 10 * 3_600_000,
    sessionId: 'sess-1',
    projectPath: '/p/a',
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

describe('groupRecords', () => {
  it('collapses records into (day, project, model) rows with tools and messages', () => {
    const grouped = groupRecords([
      record({ toolUses: { Bash: 2 } }),
      record({ toolUses: { Bash: 1, Edit: 3 }, fromSubagent: true }),
      record({ model: 'claude-haiku-4-5' }),
    ]);
    const key = ledgerKey(DAY, '/p/a', 'claude-opus-4-8');
    expect(Object.keys(grouped)).toHaveLength(2);
    expect(grouped[key].inputTokens).toBe(200);
    expect(grouped[key].messages).toBe(2);
    expect(grouped[key].tools).toEqual({ Bash: 3, Edit: 3 });
    expect(grouped[key].subagentTokens).toBe(300);
  });
});

describe('mergeIntoLedger', () => {
  it('adds new rows and grows existing ones field-wise', () => {
    const ledger = emptyLedger();
    expect(mergeIntoLedger(ledger, groupRecords([record()]))).toBe(true);
    // Same day grows (another message appended to the live file)
    expect(mergeIntoLedger(ledger, groupRecords([record(), record()]))).toBe(true);
    const key = ledgerKey(DAY, '/p/a', 'claude-opus-4-8');
    expect(ledger.rows[key].inputTokens).toBe(200);
    // No change → not dirty
    expect(mergeIntoLedger(ledger, groupRecords([record(), record()]))).toBe(false);
  });

  it('ignores shrinkage caused by transcript deletion', () => {
    const ledger = emptyLedger();
    mergeIntoLedger(ledger, groupRecords([record(), record()]));
    // One of the day's files was pruned — live now sees less
    expect(mergeIntoLedger(ledger, groupRecords([record()]))).toBe(false);
    const key = ledgerKey(DAY, '/p/a', 'claude-opus-4-8');
    expect(ledger.rows[key].inputTokens).toBe(200); // remembered
  });
});

describe('residueRecords', () => {
  it('synthesizes records for usage missing from the live scan', () => {
    const ledger = emptyLedger();
    mergeIntoLedger(ledger, groupRecords([record(), record({ toolUses: { Bash: 4 } })]));

    // Everything pruned: residue equals the ledger
    const fullResidue = residueRecords(ledger, {});
    expect(fullResidue).toHaveLength(1);
    expect(fullResidue[0].inputTokens).toBe(200);
    expect(fullResidue[0].messageCount).toBe(2);
    expect(fullResidue[0].sessionId).toBe('');
    expect(fullResidue[0].toolUses).toEqual({ Bash: 4 });
    expect(fullResidue[0].costUSD).toBeGreaterThan(0);

    // Partial pruning: residue is the delta
    const partial = residueRecords(ledger, groupRecords([record()]));
    expect(partial[0].inputTokens).toBe(100);

    // Nothing pruned: no residue
    expect(
      residueRecords(ledger, groupRecords([record(), record({ toolUses: { Bash: 4 } })]))
    ).toHaveLength(0);
  });
});

describe('export', () => {
  it('emits CSV with costs and JSON with full rows', () => {
    const ledger = emptyLedger();
    mergeIntoLedger(
      ledger,
      groupRecords([record(), record({ projectPath: '/p, with "comma"' })])
    );

    const csv = ledgerToCsv(ledger);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('date,project,model');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-06-01');
    expect(csv).toContain('"/p, with ""comma"""'); // csv escaping

    const json = JSON.parse(ledgerToJson(ledger));
    expect(json.rows).toHaveLength(2);
    expect(json.rows[0].costUSD).toBeGreaterThan(0);
  });
});

describe('rowsFromExportJson', () => {
  it('round-trips a JSON export back into mergeable rows', () => {
    const ledger = emptyLedger();
    mergeIntoLedger(ledger, groupRecords([record({ toolUses: { Bash: 2 } })]));

    const rows = rowsFromExportJson(ledgerToJson(ledger))!;
    const key = ledgerKey(DAY, '/p/a', 'claude-opus-4-8');
    expect(rows[key].inputTokens).toBe(100);
    expect(rows[key].tools).toEqual({ Bash: 2 });

    // Importing into a fresh ledger reproduces the original
    const restored = emptyLedger();
    expect(mergeIntoLedger(restored, rows)).toBe(true);
    expect(restored.rows[key].outputTokens).toBe(200);
  });

  it('rejects payloads that are not Claudometer exports', () => {
    expect(rowsFromExportJson('not json')).toBeNull();
    expect(rowsFromExportJson('{"foo":1}')).toBeNull();
    expect(rowsFromExportJson('{"rows":[{"bad":"row"}]}')).toBeNull();
  });
});
