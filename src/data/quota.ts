import { execFile } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

/**
 * Live quota read from Anthropic's unified rate-limit headers — the same data
 * shown on claude.ai/settings/usage. Obtained by sending a minimal (1 output
 * token) request authenticated with the OAuth token Claude Code already
 * stores locally. No API key is ever requested from the user.
 */
export interface QuotaData {
  fiveHourUtilization: number; // 0.0–1.0 (>1 means over limit)
  fiveHourResetAtMs: number;
  sevenDayUtilization: number;
  sevenDayResetAtMs: number;
  overallStatus: 'allowed' | 'blocked' | 'unknown';
  headersPresent: boolean;
  sevenDayHeaderPresent: boolean;
  fetchedAtMs: number;
}

function extractToken(raw: any): string | null {
  return (
    raw?.claudeAiOauth?.accessToken ??
    raw?.oauthAccount?.accessToken ??
    raw?.oauth?.accessToken ??
    raw?.accessToken ??
    null
  );
}

function readTokenFromFiles(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, 'Library', 'Application Support', 'Claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];
  for (const credPath of candidates) {
    try {
      const token = extractToken(JSON.parse(fs.readFileSync(credPath, 'utf8')));
      if (token) return token;
    } catch {
      // missing/unreadable — try next
    }
  }
  return null;
}

/** On macOS, Claude Code stores credentials in the login Keychain. */
function readTokenFromKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(extractToken(JSON.parse(stdout.trim())));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function readToken(): Promise<string | null> {
  return readTokenFromFiles() ?? (await readTokenFromKeychain());
}

export async function fetchQuota(): Promise<QuotaData | null> {
  const token = await readToken();
  if (!token) return null;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          // OAuth tokens must go via `authorization: Bearer` with the oauth
          // beta header — sending the token as x-api-key is rejected.
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-client-platform': 'claude_cli',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const h = res.headers as Record<string, string>;
        res.resume();

        const reset5h = h['anthropic-ratelimit-unified-5h-reset'];
        const reset7d = h['anthropic-ratelimit-unified-7d-reset'];
        const headersPresent = Boolean(
          reset5h || h['anthropic-ratelimit-unified-5h-utilization']
        );
        const sevenDayHeaderPresent = Boolean(
          reset7d || h['anthropic-ratelimit-unified-7d-utilization']
        );

        const fiveHourResetAtMs = reset5h
          ? parseInt(reset5h, 10) * 1000
          : Date.now() + 5 * 3_600_000;
        const sevenDayResetAtMs = reset7d
          ? parseInt(reset7d, 10) * 1000
          : Date.now() + 7 * 86_400_000;

        const ok =
          res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;

        // A non-2xx without rate-limit headers is an auth/server failure, not
        // a quota signal — except 429-with-no-headers, which means exhausted.
        if (!headersPresent && !ok && res.statusCode !== 429) {
          resolve(null);
          return;
        }
        if (res.statusCode === 429 && !headersPresent) {
          resolve({
            fiveHourUtilization: 1,
            fiveHourResetAtMs,
            sevenDayUtilization: 1,
            sevenDayResetAtMs,
            overallStatus: 'blocked',
            headersPresent: false,
            sevenDayHeaderPresent: false,
            fetchedAtMs: Date.now(),
          });
          return;
        }

        const status = h['anthropic-ratelimit-unified-status'];
        resolve({
          fiveHourUtilization:
            parseFloat(h['anthropic-ratelimit-unified-5h-utilization'] ?? '0') || 0,
          fiveHourResetAtMs,
          sevenDayUtilization: sevenDayHeaderPresent
            ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']!) || 0
            : 0,
          sevenDayResetAtMs,
          overallStatus:
            status === 'blocked' ? 'blocked' : status === 'allowed' ? 'allowed' : 'unknown',
          headersPresent,
          sevenDayHeaderPresent,
          fetchedAtMs: Date.now(),
        });
      }
    );

    req.on('error', () => resolve(null));
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}
