import { computeCostUSD } from './pricing';
import { UsageRecord, totalTokens } from './types';

/**
 * Durable usage ledger.
 *
 * Claude Code prunes old session transcripts (cleanupPeriodDays, ~30 days by
 * default), so any tracker that only reads `~/.claude/projects` silently loses
 * history. The ledger persists daily aggregates per (day, project, model);
 * live scans are merged in with a field-wise max — values for a given day only
 * grow while its files exist, so max captures growth and ignores shrinkage
 * caused by deletion. Days that disappear from disk live on as "residue"
 * records synthesized back into the aggregate.
 *
 * Token counts are stored raw (never costs), so repricing applies to the
 * whole archive retroactively.
 */
export interface LedgerRow {
  dayMs: number;
  projectPath: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  messages: number;
  subagentTokens: number;
  tools: Record<string, number>;
}

export interface LedgerData {
  version: 1;
  rows: Record<string, LedgerRow>;
}

const KEY_SEP = '';

const NUM_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'messages',
  'subagentTokens',
] as const;

export function emptyLedger(): LedgerData {
  return { version: 1, rows: {} };
}

export function ledgerKey(dayMs: number, projectPath: string, model: string): string {
  return dayMs + KEY_SEP + projectPath + KEY_SEP + model;
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Collapse live scan records into per-(day, project, model) rows. */
export function groupRecords(records: UsageRecord[]): Record<string, LedgerRow> {
  const out: Record<string, LedgerRow> = {};
  for (const r of records) {
    const dayMs = dayStart(r.timestampMs);
    const key = ledgerKey(dayMs, r.projectPath, r.model);
    let row = out[key];
    if (!row) {
      row = {
        dayMs,
        projectPath: r.projectPath,
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        messages: 0,
        subagentTokens: 0,
        tools: {},
      };
      out[key] = row;
    }
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.cacheReadTokens += r.cacheReadTokens;
    row.cacheWrite5mTokens += r.cacheWrite5mTokens;
    row.cacheWrite1hTokens += r.cacheWrite1hTokens;
    row.messages += r.messageCount ?? 1;
    if (r.fromSubagent) row.subagentTokens += totalTokens(r);
    if (r.toolUses) {
      for (const [name, count] of Object.entries(r.toolUses)) {
        row.tools[name] = (row.tools[name] ?? 0) + count;
      }
    }
  }
  return out;
}

/**
 * Merge a live grouping into the ledger, field-wise max. Returns whether the
 * ledger changed (callers persist only then).
 */
export function mergeIntoLedger(ledger: LedgerData, live: Record<string, LedgerRow>): boolean {
  let changed = false;
  for (const [key, liveRow] of Object.entries(live)) {
    const current = ledger.rows[key];
    if (!current) {
      ledger.rows[key] = { ...liveRow, tools: { ...liveRow.tools } };
      changed = true;
      continue;
    }
    for (const f of NUM_FIELDS) {
      if (liveRow[f] > current[f]) {
        current[f] = liveRow[f];
        changed = true;
      }
    }
    for (const [name, count] of Object.entries(liveRow.tools)) {
      if (count > (current.tools[name] ?? 0)) {
        current.tools[name] = count;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Records for usage the ledger remembers but the live scan no longer sees
 * (pruned transcripts). One synthesized record per affected (day, project,
 * model), timestamped midday so it lands in the right daily bucket. Session
 * identity and hour-of-day fidelity are gone for these — by then the source
 * files are too.
 */
export function residueRecords(
  ledger: LedgerData,
  live: Record<string, LedgerRow>
): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const [key, row] of Object.entries(ledger.rows)) {
    const l = live[key];
    const delta = (f: (typeof NUM_FIELDS)[number]) => Math.max(row[f] - (l ? l[f] : 0), 0);
    const inputTokens = delta('inputTokens');
    const outputTokens = delta('outputTokens');
    const cacheReadTokens = delta('cacheReadTokens');
    const cacheWrite5mTokens = delta('cacheWrite5mTokens');
    const cacheWrite1hTokens = delta('cacheWrite1hTokens');
    if (
      inputTokens + outputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens ===
      0
    ) {
      continue;
    }
    let toolUses: Record<string, number> | undefined;
    for (const [name, count] of Object.entries(row.tools)) {
      const dc = count - (l?.tools[name] ?? 0);
      if (dc > 0) (toolUses ??= {})[name] = dc;
    }
    out.push({
      timestampMs: row.dayMs + 12 * 3_600_000,
      sessionId: '',
      projectPath: row.projectPath,
      model: row.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      costUSD: computeCostUSD(
        row.model,
        inputTokens,
        outputTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
        cacheReadTokens
      ),
      messageCount: Math.max(delta('messages'), 1),
      ...(toolUses ? { toolUses } : {}),
    });
  }
  return out;
}

function sortedRows(ledger: LedgerData): LedgerRow[] {
  return Object.values(ledger.rows).sort(
    (a, b) =>
      a.dayMs - b.dayMs ||
      a.projectPath.localeCompare(b.projectPath) ||
      a.model.localeCompare(b.model)
  );
}

function localDate(dayMs: number): string {
  const d = new Date(dayMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rowCost(row: LedgerRow): number {
  return computeCostUSD(
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheWrite5mTokens,
    row.cacheWrite1hTokens,
    row.cacheReadTokens
  );
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function ledgerToCsv(ledger: LedgerData): string {
  const header =
    'date,project,model,messages,input_tokens,output_tokens,cache_read_tokens,' +
    'cache_write_5m_tokens,cache_write_1h_tokens,total_tokens,cost_usd';
  const lines = sortedRows(ledger).map((r) => {
    const total =
      r.inputTokens +
      r.outputTokens +
      r.cacheReadTokens +
      r.cacheWrite5mTokens +
      r.cacheWrite1hTokens;
    return [
      localDate(r.dayMs),
      csvEscape(r.projectPath),
      r.model,
      r.messages,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWrite5mTokens,
      r.cacheWrite1hTokens,
      total,
      rowCost(r).toFixed(4),
    ].join(',');
  });
  return [header, ...lines].join('\n') + '\n';
}

/**
 * Parse a Claudometer JSON export back into ledger rows (cross-machine merge
 * or restore). Returns null when the payload isn't a Claudometer export.
 */
export function rowsFromExportJson(text: string): Record<string, LedgerRow> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.rows)) return null;

  const out: Record<string, LedgerRow> = {};
  for (const r of parsed.rows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r?.date ?? ''));
    if (!m || typeof r.project !== 'string' || typeof r.model !== 'string') continue;
    const dayMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const row: LedgerRow = {
      dayMs,
      projectPath: r.project,
      model: r.model,
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheWrite5mTokens: num(r.cacheWrite5mTokens),
      cacheWrite1hTokens: num(r.cacheWrite1hTokens),
      messages: num(r.messages),
      subagentTokens: num(r.subagentTokens),
      tools: {},
    };
    if (r.tools && typeof r.tools === 'object') {
      for (const [name, count] of Object.entries(r.tools)) {
        if (typeof count === 'number' && count > 0) row.tools[name] = count;
      }
    }
    out[ledgerKey(dayMs, row.projectPath, row.model)] = row;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function ledgerToJson(ledger: LedgerData): string {
  const rows = sortedRows(ledger).map((r) => ({
    date: localDate(r.dayMs),
    project: r.projectPath,
    model: r.model,
    messages: r.messages,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWrite5mTokens: r.cacheWrite5mTokens,
    cacheWrite1hTokens: r.cacheWrite1hTokens,
    subagentTokens: r.subagentTokens,
    tools: r.tools,
    costUSD: Number(rowCost(r).toFixed(6)),
  }));
  return JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 2);
}
