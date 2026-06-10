import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { UsageStore } from './store';
import { Alerts } from './ui/alerts';
import { Dashboard } from './ui/dashboard';
import { SettingsPage } from './ui/settingsPage';
import { StatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const store = new UsageStore(
    context.globalState,
    undefined,
    context.globalStorageUri.fsPath
  );

  context.subscriptions.push(
    store,
    new StatusBar(store),
    new Alerts(context.globalState, store),
    vscode.commands.registerCommand('claudometer.openDashboard', () =>
      Dashboard.show(context, store)
    ),
    vscode.commands.registerCommand('claudometer.openSettings', () =>
      SettingsPage.show(context, store)
    ),
    vscode.commands.registerCommand('claudometer.refresh', () => store.refresh()),
    vscode.commands.registerCommand('claudometer.exportData', () => exportData(store)),
    vscode.commands.registerCommand('claudometer.importData', () => importData(store))
  );

  store.start();
  trackVersion(context);
}

const VERSION_KEY = 'claudometer.lastVersion';

/**
 * First install → surface the getting-started walkthrough once.
 * Update → one "what's new" toast linking to the bundled changelog.
 */
function trackVersion(context: vscode.ExtensionContext): void {
  const current: string = context.extension.packageJSON.version;
  const previous = context.globalState.get<string>(VERSION_KEY);
  if (previous === current) return;
  void context.globalState.update(VERSION_KEY, current);

  if (!previous) {
    void vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#claudometer.gettingStarted`,
      false
    );
    return;
  }

  void vscode.window
    .showInformationMessage(`Claudometer updated to v${current}.`, "What's New")
    .then((choice) => {
      if (choice) {
        void vscode.commands.executeCommand(
          'markdown.showPreview',
          vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md')
        );
      }
    });
}

async function exportData(store: UsageStore): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'CSV', description: 'date, project, model, tokens, cost — spreadsheet-friendly' },
      { label: 'JSON', description: 'full rows including tool counts and subagent tokens' },
    ],
    { title: 'Export Claudometer usage data' }
  );
  if (!pick) return;
  const format = pick.label.toLowerCase() as 'csv' | 'json';
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(os.homedir(), `claudometer-usage-${new Date().toISOString().slice(0, 10)}.${format}`)
    ),
    filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
  });
  if (!uri) return;
  await fs.promises.writeFile(uri.fsPath, store.exportData(format));
  void vscode.window.showInformationMessage(
    `Claudometer: exported usage data to ${path.basename(uri.fsPath)}.`
  );
}

async function importData(store: UsageStore): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    title: 'Import Claudometer usage data (JSON export)',
    filters: { JSON: ['json'] },
    canSelectMany: false,
  });
  if (!uris?.[0]) return;
  const text = await fs.promises.readFile(uris[0].fsPath, 'utf8');
  const merged = store.importData(text);
  if (merged === null) {
    void vscode.window.showErrorMessage(
      'Claudometer: that file is not a Claudometer JSON export.'
    );
  } else {
    void vscode.window.showInformationMessage(
      `Claudometer: merged ${merged} day-rows into your ledger.`
    );
  }
}

export function deactivate(): void {}
