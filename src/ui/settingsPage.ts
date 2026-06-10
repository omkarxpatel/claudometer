import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ModelPricing, pricingCatalog, resolvePricing } from '../core/pricing';
import { UsageStore } from '../store';

/**
 * Custom settings page. All values are persisted through the regular
 * `claudometer.*` VS Code configuration (user scope), so they remain visible
 * in the native Settings UI, sync via Settings Sync, and are editable in
 * settings.json — this page is just a friendlier editor, and the only place
 * that can show *effective* pricing (live catalog + user overrides merged).
 */
export class SettingsPage {
  private static current: SettingsPage | undefined;

  static show(context: vscode.ExtensionContext, store: UsageStore): void {
    if (SettingsPage.current) {
      SettingsPage.current.panel.reveal();
      return;
    }
    SettingsPage.current = new SettingsPage(context, store);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastPayloadJson = '';

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: UsageStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'claudometer.settings',
      'Claudometer Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    this.panel.webview.html = this.buildHtml(context);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      // Store re-fires on configuration changes, so this also covers edits
      // made directly in settings.json while the page is open.
      this.store.onDidChange(() => this.postSettings())
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.postSettings(true);
        break;
      case 'set':
        await this.config().update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        break;
      case 'setOverride':
        await this.updateOverride(msg.model, msg.pricing ?? null);
        break;
      case 'addOverride': {
        const model = String(msg.model ?? '').trim();
        if (model) await this.updateOverride(model, resolvePricing(model).pricing);
        break;
      }
      case 'refreshPricing':
        await this.store.forcePricingRefresh();
        this.postSettings(true);
        break;
      case 'exportData':
        await vscode.commands.executeCommand('claudometer.exportData');
        break;
      case 'importData':
        await vscode.commands.executeCommand('claudometer.importData');
        break;
    }
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('claudometer');
  }

  private async updateOverride(model: string, pricing: ModelPricing | null): Promise<void> {
    const overrides: Record<string, Partial<ModelPricing>> = {
      ...this.config().get<Record<string, Partial<ModelPricing>>>('pricing.overrides', {}),
    };
    if (pricing) overrides[model] = pricing;
    else delete overrides[model];
    await this.config().update('pricing.overrides', overrides, vscode.ConfigurationTarget.Global);
  }

  private postSettings(force = false): void {
    const cfg = this.config();
    const usedModels = this.store.state.summary?.byModel.map((m) => m.model) ?? [];
    const payload = {
      config: {
        'statusBar.showCost': cfg.get('statusBar.showCost', true),
        'statusBar.show5hQuota': cfg.get('statusBar.show5hQuota', true),
        'statusBar.show7dQuota': cfg.get('statusBar.show7dQuota', true),
        'statusBar.showResetCountdown': cfg.get('statusBar.showResetCountdown', false),
        'statusBar.showWorkspaceCost': cfg.get('statusBar.showWorkspaceCost', false),
        'statusBar.showSessionCost': cfg.get('statusBar.showSessionCost', false),
        'appearance.accentColor': cfg.get('appearance.accentColor', '#D97757'),
        'dashboard.weekMetric': cfg.get('dashboard.weekMetric', 'calendar'),
        'stats.streakExcludesWeekends': cfg.get('stats.streakExcludesWeekends', false),
        'quota.enabled': cfg.get('quota.enabled', true),
        'pricing.autoUpdate': cfg.get('pricing.autoUpdate', true),
        'budget.monthly': cfg.get('budget.monthly', 0),
        'alerts.enabled': cfg.get('alerts.enabled', true),
        ledgerPath: cfg.get('ledgerPath', ''),
      },
      catalog: pricingCatalog(usedModels),
      pricingMeta: this.store.state.pricing,
    };

    // Skip identical reposts so an open editor row isn't wiped by unrelated
    // store activity (scans fire every few seconds during active usage).
    const json = JSON.stringify(payload);
    if (!force && json === this.lastPayloadJson) return;
    this.lastPayloadJson = json;
    void this.panel.webview.postMessage({ type: 'settings', payload });
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
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mediaUri('settings', 'settings.css')}">
  <title>Claudometer Settings</title>
</head>
<body>
  <header><h1>Claudometer Settings</h1></header>
  <main>
    <section>
      <h2>Status Bar</h2>
      <div id="statusbar-toggles" class="toggles"></div>
    </section>
    <section>
      <h2>Appearance</h2>
      <div id="appearance" class="toggles"></div>
    </section>
    <section>
      <h2>Budget &amp; Alerts</h2>
      <div id="budget" class="toggles"></div>
    </section>
    <section>
      <h2>Data &amp; Network</h2>
      <div id="network" class="toggles"></div>
    </section>
    <section>
      <h2>Pricing <span class="unit">(USD per million tokens)</span></h2>
      <p id="pricing-meta" class="meta"></p>
      <div class="pricing-actions">
        <button id="refresh-pricing">Refresh from models.dev</button>
        <span class="spacer"></span>
        <input id="new-model" type="text" placeholder="model id, e.g. claude-omega-7" spellcheck="false">
        <button id="add-override">Add override</button>
      </div>
      <table id="pricing-table"></table>
      <p class="meta">Overrides take precedence over fetched and bundled pricing and apply retroactively to your whole history. They are stored in the <code>claudometer.pricing.overrides</code> user setting.</p>
    </section>
  </main>
  <script nonce="${nonce}" src="${mediaUri('settings', 'settings.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SettingsPage.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
