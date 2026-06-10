import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageScanner } from '../data/scanner';
import { assistantLine } from './fixtures';

let projectsDir: string;
let sessionFile: string;

function line(messageId: string): string {
  return assistantLine({ messageId }) + '\n';
}

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudometer-test-'));
  const projDir = path.join(projectsDir, '-Users-test-proj');
  fs.mkdirSync(projDir);
  sessionFile = path.join(projDir, 'session-1.jsonl');
});

afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

describe('UsageScanner', () => {
  it('parses all records on first scan', async () => {
    fs.writeFileSync(sessionFile, line('m1') + line('m2'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(2);
  });

  it('picks up appended records on subsequent scans', async () => {
    fs.writeFileSync(sessionFile, line('m1'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(1);

    fs.appendFileSync(sessionFile, line('m2'));
    expect(await scanner.scan()).toHaveLength(2);
  });

  it('does not re-read already-parsed bytes', async () => {
    fs.writeFileSync(sessionFile, line('m1') + line('m2'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(2);

    // Corrupt the already-parsed prefix in place (same byte length). A full
    // re-scan would now parse garbage and lose records; an incremental scan
    // never touches these bytes.
    const fd = fs.openSync(sessionFile, 'r+');
    fs.writeSync(fd, 'XXXX', 0);
    fs.closeSync(fd);
    expect(await scanner.scan()).toHaveLength(2);

    fs.appendFileSync(sessionFile, line('m3'));
    expect(await scanner.scan()).toHaveLength(3);
  });

  it('deduplicates repeated message ids within a file', async () => {
    fs.writeFileSync(sessionFile, line('m1') + line('m1') + line('m2'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(2);
  });

  it('leaves a partial trailing line for the next scan', async () => {
    const full = line('m2');
    fs.writeFileSync(sessionFile, line('m1') + full.slice(0, 25)); // mid-write
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(1);

    fs.appendFileSync(sessionFile, full.slice(25)); // write completes
    expect(await scanner.scan()).toHaveLength(2);
  });

  it('consumes a complete final line that lacks a trailing newline', async () => {
    fs.writeFileSync(sessionFile, assistantLine({ messageId: 'm1' })); // no \n
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(1);
    // And does not double-count it once a newline + new record arrive.
    fs.appendFileSync(sessionFile, '\n' + line('m2'));
    expect(await scanner.scan()).toHaveLength(2);
  });

  it('re-parses a file that shrank (rotation/rewrite)', async () => {
    fs.writeFileSync(sessionFile, line('m1') + line('m2'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(2);

    fs.writeFileSync(sessionFile, line('m9'));
    const records = await scanner.scan();
    expect(records).toHaveLength(1);
  });

  it('drops records for deleted files', async () => {
    fs.writeFileSync(sessionFile, line('m1'));
    const scanner = new UsageScanner(projectsDir);
    expect(await scanner.scan()).toHaveLength(1);

    fs.rmSync(sessionFile);
    expect(await scanner.scan()).toHaveLength(0);
  });

  it('finds nested subagent transcripts and tags them', async () => {
    const sub = path.join(projectsDir, '-Users-test-proj', 'sess-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent.jsonl'), line('m1'));
    const scanner = new UsageScanner(projectsDir);
    const records = await scanner.scan();
    expect(records).toHaveLength(1);
    expect(records[0].fromSubagent).toBe(true);
  });

  it('derives the fallback project path from the directory name', async () => {
    const obj = JSON.parse(assistantLine());
    delete obj.cwd;
    fs.writeFileSync(sessionFile, JSON.stringify(obj) + '\n');
    const scanner = new UsageScanner(projectsDir);
    const [record] = await scanner.scan();
    expect(record.projectPath).toBe('/Users/test/proj');
  });

  it('returns empty for a missing projects directory', async () => {
    const scanner = new UsageScanner(path.join(projectsDir, 'does-not-exist'));
    expect(await scanner.scan()).toHaveLength(0);
  });
});
