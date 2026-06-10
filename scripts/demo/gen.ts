import * as fs from 'fs';
import { aggregate } from '../../src/core/aggregate';
import { computeCostUSD } from '../../src/core/pricing';
import { UsageRecord } from '../../src/core/types';

// Deterministic PRNG so screenshots are reproducible.
let seed = 42;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

const PROJECTS = [
  { path: '/Users/dev/work/orders-api', weight: 1.0 },
  { path: '/Users/dev/work/storefront', weight: 0.7 },
  { path: '/Users/dev/oss/parser-kit', weight: 0.4 },
  { path: '/Users/dev/personal/dotfiles', weight: 0.15 },
];
const MODELS = [
  { id: 'claude-fable-5', weight: 0.45 },
  { id: 'claude-opus-4-8', weight: 0.35 },
  { id: 'claude-sonnet-4-6', weight: 0.15 },
  { id: 'claude-haiku-4-5-20251001', weight: 0.05 },
];
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebSearch', 'Task'];

function weighted<T extends { weight: number }>(arr: T[]): T {
  const total = arr.reduce((a, x) => a + x.weight, 0);
  let r = rnd() * total;
  for (const x of arr) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return arr[arr.length - 1];
}

const now = Date.now();
const records: UsageRecord[] = [];

for (let daysAgo = 74; daysAgo >= 0; daysAgo--) {
  const day = new Date(now);
  day.setDate(day.getDate() - daysAgo);
  day.setHours(0, 0, 0, 0);
  const dow = day.getDay();
  const dayWeight = dow === 0 ? 0.05 : dow === 6 ? 0.25 : 0.75 + rnd() * 0.5;
  if (rnd() > dayWeight) continue;

  const sessions = 1 + Math.floor(rnd() * 2.4 * dayWeight);
  for (let s = 0; s < sessions; s++) {
    const project = weighted(PROJECTS).path;
    const model = weighted(MODELS).id;
    const sessionId = `demo-${daysAgo}-${s}`;
    const startHour = 9 + rnd() * 9;
    const messages = 8 + Math.floor(rnd() * 35 * dayWeight);
    for (let m = 0; m < messages; m++) {
      const t = day.getTime() + (startHour + m * 0.04) * 3_600_000;
      if (daysAgo === 0 && t > now) break;
      const inputTokens = Math.floor(30 + rnd() * 300);
      const outputTokens = Math.floor(120 + rnd() * 1100);
      const cacheReadTokens = Math.floor(40_000 + rnd() * 320_000);
      const cacheWrite1hTokens = Math.floor(1500 + rnd() * 26_000);
      const toolUses: Record<string, number> = {};
      const nTools = Math.floor(rnd() * 3);
      for (let k = 0; k < nTools; k++) {
        const tool = pick(TOOLS);
        toolUses[tool] = (toolUses[tool] ?? 0) + 1 + Math.floor(rnd() * 2);
      }
      records.push({
        timestampMs: t,
        sessionId,
        projectPath: project,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens,
        fromSubagent: rnd() < 0.15,
        ...(nTools > 0 ? { toolUses } : {}),
        costUSD: computeCostUSD(model, inputTokens, outputTokens, 0, cacheWrite1hTokens, cacheReadTokens),
      });
    }
  }
}

// An in-progress session within the current 5h window, so the quota card
// shows live usage.
for (let m = 0; m < 26; m++) {
  const t = now - (95 - m * 3.5) * 60_000;
  const inputTokens = Math.floor(40 + rnd() * 250);
  const outputTokens = Math.floor(150 + rnd() * 900);
  const cacheReadTokens = Math.floor(60_000 + rnd() * 280_000);
  const cacheWrite1hTokens = Math.floor(2000 + rnd() * 20_000);
  records.push({
    timestampMs: t,
    sessionId: 'demo-live',
    projectPath: '/Users/dev/work/orders-api',
    model: 'claude-fable-5',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens,
    toolUses: { Bash: 1, Edit: 2 },
    costUSD: computeCostUSD('claude-fable-5', inputTokens, outputTokens, 0, cacheWrite1hTokens, cacheReadTokens),
  });
}

const quota = {
  fiveHourUtilization: 0.34,
  fiveHourResetAtMs: now + 2.7 * 3_600_000,
  sevenDayUtilization: 0.18,
  sevenDayResetAtMs: now + 4.3 * 24 * 3_600_000,
  overallStatus: 'allowed',
  headersPresent: true,
  sevenDayHeaderPresent: true,
  fetchedAtMs: now,
};

const summary = aggregate(records, now, {
  fiveHourWindowStartMs: quota.fiveHourResetAtMs - 5 * 3_600_000,
  sevenDayWindowStartMs: quota.sevenDayResetAtMs - 7 * 24 * 3_600_000,
});

const state = {
  summary,
  quota,
  forecast: {
    fiveHourEtaMs: null,
    sevenDayEtaMs: null,
    weekly: { projectedUtilization: 0.43, runsOutAtMs: null, level: 'ok', usedWeekdayProfile: true },
  },
  pricing: { source: 'live', fetchedAtMs: now - 3 * 3_600_000 },
  loading: false,
};

const config = {
  accentColor: '#D97757',
  weekMetric: 'calendar',
  streakExcludesWeekends: false,
  budgetMonthly: 500,
  workspaceRoots: ['/Users/dev/work/orders-api'],
};

const css = fs.readFileSync('media/dashboard/dashboard.css', 'utf8');
const js = fs.readFileSync('media/dashboard/dashboard.js', 'utf8');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --vscode-editor-font-family: "SF Mono", Monaco, Menlo, monospace;
  --vscode-editor-background: #1f1f1f;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-editorWidget-background: #262626;
  --vscode-editorWidget-border: #3c3c3c;
  --vscode-panel-border: #3c3c3c;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-editorHoverWidget-background: #262626;
  --vscode-editorHoverWidget-border: #454545;
  --vscode-progressBar-background: #0e70c0;
}
${css}
</style>
</head>
<body class="vscode-dark">
  <header>
    <h1>Claudometer</h1>
    <div class="header-right">
      <span id="last-updated"></span>
      <button id="refresh" title="Refresh usage, quota & pricing">⟳</button>
      <button id="open-settings" title="Claudometer settings">⚙</button>
    </div>
  </header>
  <nav id="tabs"></nav>
  <main>
    <section id="spend" class="flat" data-tab="overview"></section>
    <section id="quota" data-tab="overview"></section>
    <section id="activity" data-tab="overview"></section>
    <section id="calendar" data-tab="overview"></section>
    <section id="projects" data-tab="projects"></section>
    <section id="models" data-tab="models"></section>
    <section id="tokens" data-tab="models"></section>
    <section id="tools" data-tab="models"></section>
    <section id="sessions" data-tab="sessions"></section>
  </main>
  <div id="tip" class="tip" hidden><b></b><span></span></div>
  <script>
    window.acquireVsCodeApi = function () {
      return { postMessage: function () {}, getState: function () {}, setState: function () {} };
    };
  </script>
  <script>${js.replace(/<\/script>/g, '<\\/script>')}</script>
  <script>
    window.postMessage({ type: 'state', state: ${JSON.stringify(state)}, config: ${JSON.stringify(config)} }, '*');
  </script>
</body>
</html>`;

fs.mkdirSync('scripts/demo/out', { recursive: true });
fs.writeFileSync('scripts/demo/out/index.html', html);
console.log('records:', records.length, '| today $' + summary.todayCost.toFixed(2), '| month $' + summary.monthCost.toFixed(2));
