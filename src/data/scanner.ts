import * as fs from 'fs';
import * as path from 'path';
import { parseUsageLine } from '../core/parser';
import { computeCostUSD } from '../core/pricing';
import { UsageRecord } from '../core/types';

interface FileState {
  /** Byte offset up to which the file has been parsed. */
  parsedBytes: number;
  records: UsageRecord[];
  seenMessageIds: Set<string>;
  fallbackProjectPath: string;
}

/**
 * Incremental scanner over Claude Code's `projects/**∕*.jsonl` files.
 * Session files are append-only, so after the first full pass each scan only
 * stats every file and parses bytes appended since the previous scan. A file
 * that shrank (rotated/rewritten) is reparsed from the start. This keeps
 * refreshes at milliseconds regardless of how much history has accumulated —
 * the failure mode that makes full-rescan trackers crawl after a few months.
 */
export class UsageScanner {
  private readonly files = new Map<string, FileState>();

  constructor(private readonly projectsDir: string) {}

  async scan(): Promise<UsageRecord[]> {
    const found = await this.collectJsonlFiles();

    for (const [filePath, fallbackProjectPath] of found) {
      try {
        await this.scanFile(filePath, fallbackProjectPath);
      } catch {
        // Unreadable file — keep whatever we parsed previously.
      }
    }

    // Forget files that disappeared so their records drop out.
    for (const filePath of this.files.keys()) {
      if (!found.has(filePath)) this.files.delete(filePath);
    }

    const all: UsageRecord[] = [];
    for (const state of this.files.values()) all.push(...state.records);
    return all;
  }

  /**
   * Recompute costs for all cached records after a pricing-table update, so
   * corrected prices apply retroactively without re-reading any files.
   */
  recost(): void {
    for (const state of this.files.values()) {
      for (const r of state.records) {
        r.costUSD = computeCostUSD(
          r.model,
          r.inputTokens,
          r.outputTokens,
          r.cacheWrite5mTokens,
          r.cacheWrite1hTokens,
          r.cacheReadTokens
        );
      }
    }
  }

  private async scanFile(filePath: string, fallbackProjectPath: string): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    let state = this.files.get(filePath);

    if (state && stat.size < state.parsedBytes) {
      state = undefined; // truncated or rewritten — start over
    }
    if (!state) {
      state = {
        parsedBytes: 0,
        records: [],
        seenMessageIds: new Set(),
        fallbackProjectPath,
      };
      this.files.set(filePath, state);
    }
    if (stat.size === state.parsedBytes) return;

    const { lines, bytesConsumed } = await readCompleteLines(
      filePath,
      state.parsedBytes,
      stat.size
    );
    state.parsedBytes += bytesConsumed;

    // Newer Claude Code versions nest subagent transcripts in their own files;
    // older ones mark lines with isSidechain (handled by the parser).
    const inSubagentDir = filePath.split(path.sep).includes('subagents');

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseUsageLine(line, state.fallbackProjectPath);
      if (!parsed) continue;
      if (parsed.messageId) {
        if (state.seenMessageIds.has(parsed.messageId)) continue;
        state.seenMessageIds.add(parsed.messageId);
      }
      if (inSubagentDir) parsed.record.fromSubagent = true;
      state.records.push(parsed.record);
    }
  }

  /** Map of absolute jsonl path → fallback project path derived from the dir name. */
  private async collectJsonlFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fs.promises.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return out; // ~/.claude/projects doesn't exist (yet)
    }

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      // Claude Code encodes the cwd into the dir name: "-Users-omkar-Coding-foo".
      // Lossy for paths containing real hyphens, but only used when a record
      // lacks its own `cwd` field.
      const fallback = '/' + dir.name.replace(/^-/, '').replace(/-/g, '/');
      await walk(path.join(this.projectsDir, dir.name), fallback, out);
    }
    return out;
  }
}

async function walk(dir: string, fallback: string, out: Map<string, string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Subagent transcripts nest under <sessionId>/subagents/.
      await walk(full, fallback, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.set(full, fallback);
    }
  }
}

/**
 * Read newline-terminated lines starting at a byte offset.
 *
 * A trailing fragment without a newline is normally left unconsumed (Claude
 * Code may be mid-write), so the next scan picks it up once it's complete.
 * Exception: if the fragment reaches end-of-file and parses as JSON it is a
 * complete final line that simply lacks a trailing newline — consume it.
 */
async function readCompleteLines(
  filePath: string,
  fromOffset: number,
  fileSize: number
): Promise<{ lines: string[]; bytesConsumed: number }> {
  const stream = fs.createReadStream(filePath, { start: fromOffset, encoding: 'utf8' });
  const lines: string[] = [];
  let pending = '';
  let bytesConsumed = 0;

  for await (const chunk of stream as AsyncIterable<string>) {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      lines.push(line);
      bytesConsumed += Buffer.byteLength(line, 'utf8') + 1;
      pending = pending.slice(nl + 1);
    }
  }

  if (pending.trim() && fromOffset + bytesConsumed + Buffer.byteLength(pending, 'utf8') >= fileSize) {
    try {
      JSON.parse(pending);
      lines.push(pending);
      bytesConsumed += Buffer.byteLength(pending, 'utf8');
    } catch {
      // Incomplete write — leave it for the next scan.
    }
  }

  return { lines, bytesConsumed };
}
