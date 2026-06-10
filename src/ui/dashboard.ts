import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { UsageStore } from '../store';

/**
 * Dashboard panel. Created once and updated via postMessage — the webview
 * keeps its DOM (and scroll position) and re-renders from state, instead of
 * having its entire HTML replaced on every refresh.
 */
export class Dashboard {
  private static current: Dashboard | undefined;

  static show(context: vscode.ExtensionContext, store: UsageStore): void {
    if (Dashboard.current) {
      Dashboard.current.panel.reveal();
      return;
    }
    Dashboard.current = new Dashboard(context, store);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: UsageStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'claudometer.dashboard',
      'Claudometer',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    this.panel.webview.html = this.buildHtml(context);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') this.postState();
        if (msg?.type === 'refresh') {
          void this.store.refresh();
          void this.store.forcePricingRefresh();
        }
        if (msg?.type === 'openSettings') {
          void vscode.commands.executeCommand('claudometer.openSettings');
        }
      }),
      this.store.onDidChange(() => this.postState())
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private postState(): void {
    const cfg = vscode.workspace.getConfiguration('claudometer');
    void this.panel.webview.postMessage({
      type: 'state',
      state: this.store.state,
      config: {
        accentColor: cfg.get<string>('appearance.accentColor', '#D97757'),
        weekMetric: cfg.get<string>('dashboard.weekMetric', 'calendar'),
        streakExcludesWeekends: cfg.get<boolean>('stats.streakExcludesWeekends', false),
        budgetMonthly: cfg.get<number>('budget.monthly', 0),
        workspaceRoots: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      },
    });
  }

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const mediaUri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', ...parts));
    const nonce = crypto.randomBytes(16).toString('hex');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mediaUri('dashboard', 'dashboard.css')}">
  <title>Claudometer</title>
</head>
<body>
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
  <script nonce="${nonce}" src="${mediaUri('dashboard', 'dashboard.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    Dashboard.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
